import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../../../db";
import { documents } from "../../../db/schema";
import {
  createAndProcessDocument,
  DocumentProcessingError,
  processStoredDocument,
  type SupportedDocumentType,
} from "../../../lib/rag/ingestion";
import { vectorStore } from "../../../lib/rag/vectorStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const SUPPORTED_TYPES: Record<string, SupportedDocumentType> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".txt": "txt",
};

function getDocumentType(filename: string): SupportedDocumentType | null {
  return SUPPORTED_TYPES[path.extname(filename).toLowerCase()] ?? null;
}

function getErrorMessage(error: unknown, fallback: string): string {
  // DocumentProcessingError messages have already been sanitized by the
  // ingestion service; never expose raw database/parser errors to the browser.
  return error instanceof DocumentProcessingError ? error.message : fallback;
}

export async function GET() {
  try {
    const documentList = await db
      .select({
        id: documents.id,
        name: documents.name,
        type: documents.type,
        size: documents.size,
        status: documents.status,
        processingStage: documents.processingStage,
        pageCount: documents.pageCount,
        extractedCharacters: documents.extractedCharacters,
        chunkCount: documents.chunkCount,
        errorMessage: documents.errorMessage,
        createdAt: documents.createdAt,
        hasSource: sql<boolean>`${documents.fileData} is not null`,
      })
      .from(documents)
      .orderBy(desc(documents.createdAt));

    const statistics = {
      indexedDocuments: documentList.filter((document) => document.status === "Indexed").length,
      failedDocuments: documentList.filter((document) => document.status === "Failed").length,
      vectorChunks: await vectorStore.countVectors(),
    };

    return NextResponse.json({ success: true, documents: documentList, statistics });
  } catch (error: unknown) {
    console.error("Failed to list documents:", error);
    return NextResponse.json(
      { success: false, error: getErrorMessage(error, "Unable to load documents. Please refresh and try again.") },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "Choose a PDF, DOCX, or TXT file to upload." }, { status: 400 });
    }

    const filename = path.basename(file.name || "untitled-document");
    const documentType = getDocumentType(filename);

    if (!documentType) {
      return NextResponse.json(
        { success: false, error: "Unsupported file type. ARGUS supports PDF, DOCX, and TXT documents only." },
        { status: 400 }
      );
    }
    if (file.size === 0) {
      return NextResponse.json({ success: false, error: "The uploaded document is empty." }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { success: false, error: "This file is larger than 25 MB. Please upload a smaller document." },
        { status: 413 }
      );
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const document = await createAndProcessDocument({
      name: filename,
      type: documentType,
      size: file.size,
      bytes,
    });

    return NextResponse.json({ success: true, document });
  } catch (error: unknown) {
    console.error("Document upload/indexing failed:", error);
    return NextResponse.json(
      { success: false, error: getErrorMessage(error, "Unable to index this document. Please try uploading it again.") },
      { status: 500 }
    );
  }
}

/** Re-processes a persisted source file for Retry and Process actions. */
export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as { id?: unknown; action?: "process" | "retry" };
    const documentId = Number(body.id);

    if (!Number.isInteger(documentId) || documentId <= 0) {
      return NextResponse.json({ success: false, error: "A valid document ID is required." }, { status: 400 });
    }

    const document = await processStoredDocument(documentId);
    return NextResponse.json({ success: true, document, action: body.action || "process" });
  } catch (error: unknown) {
    console.error("Document retry/process failed:", error);
    const status =
      error instanceof DocumentProcessingError && error.code === "SOURCE_UNAVAILABLE" ? 409 : 500;
    return NextResponse.json(
      { success: false, error: getErrorMessage(error, "Unable to process this document. Please try uploading it again.") },
      { status }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const idValue = new URL(request.url).searchParams.get("id");
    const documentId = Number(idValue);

    if (!Number.isInteger(documentId) || documentId <= 0) {
      return NextResponse.json({ success: false, error: "A valid document ID is required." }, { status: 400 });
    }

    const deleted = await db
      .delete(documents)
      .where(eq(documents.id, documentId))
      .returning({ id: documents.id });

    if (deleted.length === 0) {
      return NextResponse.json({ success: false, error: "This document has already been deleted." }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      message: "Document metadata and all associated vector records were deleted.",
    });
  } catch (error: unknown) {
    console.error("Failed to delete document:", error);
    return NextResponse.json(
      { success: false, error: getErrorMessage(error, "Unable to delete the document. Please try again.") },
      { status: 500 }
    );
  }
}
