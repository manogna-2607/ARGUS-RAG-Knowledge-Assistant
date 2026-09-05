import { db } from "../../db";
import { documentChunks, documents } from "../../db/schema";
import { eq, sql } from "drizzle-orm";
import { computeCosineSimilarity } from "./embeddings";
import { rankLexically } from "./lexical";

export interface VectorMetadata {
  document_id: number;
  document_name: string;
  chunk_id?: number;
  chunk_index: number;
  page_number: number | null;
  source: string;
  text: string;
  document_created_at?: string;
  chunk_created_at?: string;
  indexing_status?: "Indexed";
}

export interface VectorRecord {
  embedding: number[];
  chunkText: string;
  documentId: number;
  documentName: string;
  pageNumber: number | null;
  chunkIndex: number;
  metadata: VectorMetadata;
}

export interface SearchedChunk {
  chunkId: number;
  documentId: number;
  documentName: string;
  documentType: string;
  chunkIndex: number;
  textContent: string;
  pageNumber: number | null;
  similarity: number;
  metadata: VectorMetadata;
  retrievalMethod?: "vector" | "lexical" | "hybrid" | "contextual";
  vectorSimilarity?: number;
  lexicalScore?: number;
}

type IndexedChunkRow = {
  id: number;
  documentId: number;
  chunkIndex: number;
  textContent: string;
  embedding: unknown;
  pageNumber: number | null;
  metadata: unknown;
  createdAt: Date;
  documentName: string;
  documentCreatedAt: Date;
  documentStatus: string;
  documentType: string;
};

function asNumberArray(value: unknown): number[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return value as number[];
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) && parsed.every((item) => typeof item === "number") ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toSearchedChunk(chunk: IndexedChunkRow): SearchedChunk {
  const storedMetadata = (chunk.metadata || {}) as Partial<VectorMetadata>;
  const metadata: VectorMetadata = {
    document_id: chunk.documentId,
    document_name: chunk.documentName,
    chunk_id: chunk.id,
    chunk_index: chunk.chunkIndex,
    page_number: chunk.pageNumber,
    source: chunk.documentName,
    text: chunk.textContent,
    document_created_at: chunk.documentCreatedAt.toISOString(),
    chunk_created_at: chunk.createdAt.toISOString(),
    indexing_status: "Indexed",
    ...storedMetadata,
  };

  return {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    documentName: chunk.documentName,
    documentType: chunk.documentType,
    chunkIndex: chunk.chunkIndex,
    textContent: chunk.textContent,
    pageNumber: chunk.pageNumber,
    similarity: 0,
    metadata: { ...metadata, chunk_id: chunk.id },
  };
}

export class PostgresVectorStore {
  private async getIndexedChunks(): Promise<IndexedChunkRow[]> {
    return db
      .select({
        id: documentChunks.id,
        documentId: documentChunks.documentId,
        chunkIndex: documentChunks.chunkIndex,
        textContent: documentChunks.textContent,
        embedding: documentChunks.embedding,
        pageNumber: documentChunks.pageNumber,
        metadata: documentChunks.metadata,
        createdAt: documentChunks.createdAt,
        documentName: documents.name,
        documentCreatedAt: documents.createdAt,
        documentStatus: documents.status,
        documentType: documents.type,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(eq(documents.status, "Indexed"));
  }

  /**
   * Inserts fully embedded chunks and records their database-generated chunk IDs
   * back into metadata. This makes each persisted vector record self-contained.
   */
  async insert(records: VectorRecord[]): Promise<number[]> {
    if (records.length === 0) return [];

    const insertedRows = await db.transaction(async (transaction) => {
      const rows = await transaction
        .insert(documentChunks)
        .values(
          records.map((record) => ({
            documentId: record.documentId,
            chunkIndex: record.chunkIndex,
            textContent: record.chunkText,
            embedding: record.embedding,
            pageNumber: record.pageNumber,
            metadata: record.metadata,
          }))
        )
        .returning({ id: documentChunks.id, createdAt: documentChunks.createdAt });

      await Promise.all(
        rows.map((row, index) =>
          transaction
            .update(documentChunks)
            .set({
              metadata: {
                ...records[index].metadata,
                chunk_id: row.id,
                chunk_created_at: row.createdAt.toISOString(),
                indexing_status: "Indexed",
              },
            })
            .where(eq(documentChunks.id, row.id))
        )
      );

      return rows;
    });

    return insertedRows.map((row) => row.id);
  }

  /** Performs persisted cosine similarity retrieval over indexed documents only. */
  async similaritySearch(
    queryEmbedding: number[],
    limit = 5,
    minSimilarity = 0.18
  ): Promise<SearchedChunk[]> {
    const allChunks = await this.getIndexedChunks();

    return allChunks
      .map((chunk) => {
        const vector = asNumberArray(chunk.embedding);
        const vectorSimilarity =
          vector.length > 0 && vector.length === queryEmbedding.length
            ? computeCosineSimilarity(queryEmbedding, vector)
            : 0;
        return {
          ...toSearchedChunk(chunk),
          similarity: vectorSimilarity,
          vectorSimilarity,
          retrievalMethod: "vector" as const,
        };
      })
      .filter((chunk) => chunk.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /**
   * Uses persisted chunk text for a BM25-style local search. This is independent
   * from embeddings and works for one-document and one-chunk corpora.
   */
  async lexicalSearch(query: string, limit = 5, minScore = 0.05): Promise<SearchedChunk[]> {
    const chunks = (await this.getIndexedChunks()).map(toSearchedChunk);
    return rankLexically(query, chunks, limit, minScore).map((chunk) => {
      const lexicalScore = chunk.similarity;
      return {
        ...chunk,
        // Convert unbounded BM25-style score to a 0..1 display/ranking signal.
        similarity: 1 - Math.exp(-lexicalScore),
        lexicalScore,
        retrievalMethod: "lexical" as const,
      };
    });
  }

  /**
   * Returns immediate neighboring chunks for structured list questions. The
   * chunks remain persisted source content and are explicitly marked as
   * contextual rather than pretending they were direct similarity matches.
   */
  async getContextualNeighbors(anchors: SearchedChunk[], limit = 2): Promise<SearchedChunk[]> {
    if (anchors.length === 0 || limit <= 0) return [];

    const indexedChunks = await this.getIndexedChunks();
    const neighbors = indexedChunks
      .map(toSearchedChunk)
      .flatMap((candidate) => {
        const closestAnchor = anchors
          .filter((anchor) => anchor.documentId === candidate.documentId)
          .map((anchor) => ({ anchor, distance: Math.abs(anchor.chunkIndex - candidate.chunkIndex) }))
          .filter(({ distance }) => distance === 1)
          .sort((a, b) => a.distance - b.distance || b.anchor.similarity - a.anchor.similarity)[0];

        if (!closestAnchor) return [];
        return [{
          ...candidate,
          similarity: Math.max(0.1, closestAnchor.anchor.similarity * 0.82),
          retrievalMethod: "contextual" as const,
        }];
      })
      .sort((a, b) => b.similarity - a.similarity);

    return neighbors.slice(0, limit);
  }

  /** Deletes every vector record associated with one document. */
  async deleteByDocument(documentId: number): Promise<void> {
    await db.delete(documentChunks).where(eq(documentChunks.documentId, documentId));
  }

  /** Deletes every persisted vector from the store. */
  async clearAll(): Promise<void> {
    await db.delete(documentChunks);
  }

  /** Counts vectors that belong to complete indexed documents. */
  async countVectors(): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(eq(documents.status, "Indexed"));
    return result[0]?.count || 0;
  }
}

export const vectorStore = new PostgresVectorStore();
