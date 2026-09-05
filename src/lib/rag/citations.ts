import type { RetrievedChunk } from "./retrieval";

export const NOT_FOUND_ANSWER =
  "I couldn't find enough information in your indexed knowledge base to answer this confidently.";

export interface Citation {
  documentId: number;
  documentName: string;
  pageNumber: number | null;
  label: string;
}

export function formatCitation(documentName: string, pageNumber: number | null): string {
  return pageNumber
    ? `[Source: ${documentName}, Page ${pageNumber}]`
    : `[Source: ${documentName}]`;
}

export function createCitations(chunks: RetrievedChunk[]): Citation[] {
  const seen = new Set<string>();

  return chunks.flatMap((chunk) => {
    const key = `${chunk.documentId}:${chunk.pageNumber ?? "source"}`;
    if (seen.has(key)) return [];
    seen.add(key);

    return [{
      documentId: chunk.documentId,
      documentName: chunk.documentName,
      pageNumber: chunk.pageNumber,
      label: formatCitation(chunk.documentName, chunk.pageNumber),
    }];
  });
}
