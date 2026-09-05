import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { documents } from "../../db/schema";
import { chunkPages, cleanText } from "./chunker";
import { loadRagSettings } from "./config";
import { embedTexts, getEmbeddingService } from "./embeddings";
import { DocumentExtractionError, extractText } from "./extractor";
import { vectorStore, type VectorRecord } from "./vectorStore";

export type SupportedDocumentType = "pdf" | "docx" | "txt";
export type ProcessingStage =
  | "Uploaded"
  | "Extracting"
  | "Cleaning"
  | "Chunking"
  | "Embedding"
  | "Indexing"
  | "Indexed"
  | "Failed";

export interface ProcessedDocumentResult {
  id: number;
  name: string;
  status: "Indexed";
  processingStage: "Indexed";
  pageCount: number;
  extractedCharacters: number;
  chunkCount: number;
  parser: string;
}

export class DocumentProcessingError extends Error {
  constructor(message: string, public readonly code = "PROCESSING_FAILED") {
    super(message);
    this.name = "DocumentProcessingError";
  }
}

function toUserFacingProcessingError(error: unknown): { message: string; code: string } {
  const detail = error instanceof Error ? error.message : "Unknown processing error";
  const code =
    error instanceof DocumentProcessingError
      ? error.code
      : error instanceof DocumentExtractionError
        ? error.code
        : "PROCESSING_FAILED";

  if (code === "SCANNED_PDF" || /scanned\/image-only|ocr is required/i.test(detail)) {
    return {
      code: "SCANNED_PDF",
      message: "This PDF appears to contain scanned/image-only pages. OCR is required for these pages.",
    };
  }
  if (code === "SOURCE_UNAVAILABLE") {
    return {
      code,
      message: "The original upload is unavailable for this legacy record. Please re-upload the file to process it with the current pipeline.",
    };
  }
  if (/encrypted|password/i.test(detail)) {
    return { code, message: "This PDF is encrypted and requires a password before it can be indexed." };
  }
  if (/no readable text|no extractable text|contains no readable|no meaningful chunks/i.test(detail)) {
    return { code, message: "ARGUS could not find readable text in this document. Please upload a text-based file or an OCR-processed PDF." };
  }
  if (/pdf|parser|extract/i.test(detail)) {
    return { code, message: "Unable to extract text from this PDF. Please try uploading the original file again." };
  }
  if (/embedding/i.test(detail)) {
    return { code, message: "Unable to create embeddings for this document. Please try processing it again." };
  }
  if (/vector|database|index/i.test(detail)) {
    return { code, message: "Unable to save this document to the knowledge index. Please try again." };
  }

  return { code, message: "Unable to index this document. Please try uploading it again." };
}

async function updateProcessingStage(
  documentId: number,
  processingStage: ProcessingStage,
  status: "Uploaded" | "Processing" | "Indexed" | "Failed" = "Processing"
) {
  await db
    .update(documents)
    .set({ processingStage, status })
    .where(eq(documents.id, documentId));
}

function normaliseDocumentPages(
  pages: { text: string; pageNumber: number | null }[]
): { text: string; pageNumber: number | null }[] {
  return pages
    .map((page) => ({
      text: cleanText(page.text),
      pageNumber: page.pageNumber,
    }))
    .filter((page) => page.text.length > 0);
}

/**
 * Processes an existing document that already has source bytes persisted.
 * All embeddings are generated before vectors are saved to avoid partial indexes.
 */
export async function processStoredDocument(documentId: number): Promise<ProcessedDocumentResult> {
  const [document] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (!document) {
    throw new DocumentProcessingError("This document no longer exists.", "DOCUMENT_NOT_FOUND");
  }

  if (!document.fileData) {
    const message =
      "The original upload is unavailable because this document predates durable source storage. Please re-upload the original file to index it with the updated parser.";
    await db
      .update(documents)
      .set({ status: "Failed", processingStage: "Failed", errorMessage: message })
      .where(eq(documents.id, documentId));
    throw new DocumentProcessingError(message, "SOURCE_UNAVAILABLE");
  }

  const documentType = document.type as SupportedDocumentType;

  try {
    await updateProcessingStage(documentId, "Extracting");
    const extracted = await extractText(document.fileData, documentType);

    await updateProcessingStage(documentId, "Cleaning");
    const pages = normaliseDocumentPages(extracted.pages);
    const cleanedText = pages.map((page) => page.text).join("\n\n").trim();

    if (!cleanedText || pages.length === 0) {
      throw new DocumentProcessingError("No readable text remained after document cleaning.");
    }

    await db
      .update(documents)
      .set({
        textContent: cleanedText,
        pageCount: extracted.pageCount,
        extractedCharacters: cleanedText.length,
        errorMessage: null,
      })
      .where(eq(documents.id, documentId));

    const config = await loadRagSettings();

    await updateProcessingStage(documentId, "Chunking");
    const chunks = chunkPages(pages, {
      chunkSize: config.chunkSize,
      chunkOverlap: Math.min(config.chunkOverlap, config.chunkSize - 1),
    });

    if (chunks.length === 0) {
      throw new DocumentProcessingError("No meaningful chunks were generated from the extracted text.");
    }

    await updateProcessingStage(documentId, "Embedding");
    const apiKey =
      config.provider === "openai"
        ? config.openAIKey
        : config.provider === "gemini"
          ? config.geminiKey
          : undefined;
    const embeddingService = getEmbeddingService(config.provider, apiKey);
    const embeddings = await embedTexts(
      chunks.map((chunk) => chunk.textContent),
      embeddingService
    );

    await updateProcessingStage(documentId, "Indexing");
    // Retrying always rebuilds the vector index from the currently persisted source.
    await vectorStore.deleteByDocument(documentId);

    const vectorRecords: VectorRecord[] = chunks.map((chunk, index) => ({
      embedding: embeddings[index],
      chunkText: chunk.textContent,
      documentId,
      documentName: document.name,
      pageNumber: chunk.pageNumber,
      chunkIndex: chunk.chunkIndex,
      metadata: {
        document_id: documentId,
        document_name: document.name,
        chunk_index: chunk.chunkIndex,
        page_number: chunk.pageNumber,
        source: document.name,
        text: chunk.textContent,
        document_created_at: document.createdAt.toISOString(),
        indexing_status: "Indexed",
      },
    }));

    await vectorStore.insert(vectorRecords);

    await db
      .update(documents)
      .set({
        status: "Indexed",
        processingStage: "Indexed",
        pageCount: extracted.pageCount,
        extractedCharacters: cleanedText.length,
        chunkCount: chunks.length,
        errorMessage: null,
      })
      .where(eq(documents.id, documentId));

    return {
      id: documentId,
      name: document.name,
      status: "Indexed",
      processingStage: "Indexed",
      pageCount: extracted.pageCount,
      extractedCharacters: cleanedText.length,
      chunkCount: chunks.length,
      parser: extracted.parser,
    };
  } catch (error: unknown) {
    console.error(`Document ingestion failed for document ${documentId}:`, error);
    await vectorStore.deleteByDocument(documentId).catch((cleanupError) => {
      console.error("Failed to remove partial vectors after ingestion error:", cleanupError);
    });

    const safeError = toUserFacingProcessingError(error);
    await db
      .update(documents)
      .set({
        status: "Failed",
        processingStage: "Failed",
        chunkCount: 0,
        errorMessage: safeError.message,
      })
      .where(eq(documents.id, documentId));

    throw new DocumentProcessingError(safeError.message, safeError.code);
  }
}

/** Creates an Uploaded record with durable source bytes, then indexes it immediately. */
export async function createAndProcessDocument(input: {
  name: string;
  type: SupportedDocumentType;
  size: number;
  bytes: Buffer;
}): Promise<ProcessedDocumentResult> {
  const [existingDocument] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.name, input.name), eq(documents.size, input.size)))
    .limit(1);

  const [document] = await db
    .insert(documents)
    .values({
      name: input.name,
      type: input.type,
      size: input.size,
      fileData: input.bytes,
      status: "Uploaded",
      processingStage: "Uploaded",
      pageCount: 0,
      extractedCharacters: 0,
      chunkCount: 0,
      errorMessage: null,
    })
    .returning({ id: documents.id });

  let processedDocument: ProcessedDocumentResult;
  try {
    processedDocument = await processStoredDocument(document.id);
  } catch (error) {
    // Preserve a working duplicate until its replacement completes. A failed
    // replacement is removed so the library never accumulates duplicate rows.
    if (existingDocument) {
      await db.delete(documents).where(eq(documents.id, document.id));
    }
    throw error;
  }

  // Only after the replacement is indexed do we remove the previous duplicate.
  // The document_chunks foreign key cascade removes its associated vectors.
  if (existingDocument) {
    await db.delete(documents).where(eq(documents.id, existingDocument.id));
  }

  return processedDocument;
}
