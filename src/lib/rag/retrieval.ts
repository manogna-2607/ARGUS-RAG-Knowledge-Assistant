import { getEmbedding } from "./embeddings";
import { type SearchedChunk, vectorStore } from "./vectorStore";

export interface RetrievedChunk {
  chunkId: number;
  documentId: number;
  documentName: string;
  documentType: string;
  chunkIndex: number;
  textContent: string;
  pageNumber: number | null;
  similarity: number;
  metadata: unknown;
  retrievalMethod: "vector" | "lexical" | "hybrid" | "contextual";
  vectorSimilarity?: number;
  lexicalScore?: number;
}

/** Normalises whitespace and preserves meaningful question terms for retrieval. */
export function preprocessQuestion(query: string): string {
  return query.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function toRetrievedChunk(chunk: SearchedChunk): RetrievedChunk {
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    documentName: chunk.documentName,
    documentType: chunk.documentType,
    chunkIndex: chunk.chunkIndex,
    textContent: chunk.textContent,
    pageNumber: chunk.pageNumber,
    similarity: chunk.similarity,
    metadata: chunk.metadata,
    retrievalMethod: chunk.retrievalMethod || "vector",
    vectorSimilarity: chunk.vectorSimilarity,
    lexicalScore: chunk.lexicalScore,
  };
}

/**
 * Hybrid persisted RAG retrieval:
 * question preprocessing → query vector → cosine similarity → lexical BM25
 * fallback/ranking → deduplicated top-K context chunks.
 */
export async function retrieveRelevantChunks(
  query: string,
  config: {
    provider: "local" | "openai" | "gemini";
    apiKey?: string;
    limit?: number;
    minSimilarity?: number;
  }
): Promise<RetrievedChunk[]> {
  const processedQuery = preprocessQuestion(query);
  if (!processedQuery) return [];

  const limit = config.limit ?? 5;
  const minSimilarity = config.minSimilarity ?? 0.18;

  try {
    // Lexical retrieval is always available locally and remains useful when an
    // external embedding call fails or old vectors have another dimensionality.
    const lexicalPromise = vectorStore.lexicalSearch(processedQuery, limit, 0.05);
    let vectorResults: SearchedChunk[] = [];

    try {
      const queryEmbedding = await getEmbedding(processedQuery, {
        provider: config.provider,
        apiKey: config.apiKey,
      });
      vectorResults = await vectorStore.similaritySearch(queryEmbedding, limit, minSimilarity);
    } catch (embeddingError) {
      console.warn("Query embedding failed; continuing with local lexical retrieval.", embeddingError);
    }

    const lexicalResults = await lexicalPromise;
    const candidates = new Map<number, SearchedChunk>();

    for (const result of vectorResults) candidates.set(result.chunkId, result);
    for (const lexicalResult of lexicalResults) {
      const existing = candidates.get(lexicalResult.chunkId);
      if (!existing) {
        candidates.set(lexicalResult.chunkId, lexicalResult);
        continue;
      }

      // Preserve the strongest normalized relevance signal. Local hash vectors
      // can be less discriminative than an exact BM25 section match, so a hybrid
      // result must never downgrade either reliable signal.
      const vectorScore = existing.vectorSimilarity ?? existing.similarity;
      const lexicalScore = lexicalResult.similarity;
      candidates.set(lexicalResult.chunkId, {
        ...existing,
        similarity: Math.min(1, Math.max(vectorScore, lexicalScore, 0.55 * vectorScore + 0.45 * lexicalScore)),
        vectorSimilarity: vectorScore,
        lexicalScore: lexicalResult.lexicalScore,
        retrievalMethod: "hybrid",
      });
    }

    return [...candidates.values()]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
      .map(toRetrievedChunk);
  } catch (error) {
    console.error("RAG retrieval failed:", error);
    return [];
  }
}
