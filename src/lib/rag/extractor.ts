import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { getPath } from "pdf-parse/worker";

// pdf-parse v2 needs an explicit server worker when it is used as the final
// fallback beneath the primary PyMuPDF extraction route.
PDFParse.setWorker(getPath());

export interface ExtractedPage {
  text: string;
  pageNumber: number | null;
}

export interface ExtractedData {
  text: string;
  pages: ExtractedPage[];
  pageCount: number;
  extractedCharacters: number;
  parser: string;
}

interface PythonExtractionResponse extends ExtractedData {
  ok: boolean;
  code?: "SCANNED_PDF" | "EXTRACTION_FAILED";
  error?: string;
}

export class DocumentExtractionError extends Error {
  constructor(
    message: string,
    public readonly code: "SCANNED_PDF" | "EXTRACTION_FAILED" = "EXTRACTION_FAILED"
  ) {
    super(message);
    this.name = "DocumentExtractionError";
  }
}

const MAX_WORKER_OUTPUT_BYTES = 40 * 1024 * 1024;

function createExtractedData(
  pages: ExtractedPage[],
  parser: string,
  pageCount = 0
): ExtractedData {
  const nonEmptyPages = pages
    .map((page) => ({ text: page.text.trim(), pageNumber: page.pageNumber }))
    .filter((page) => page.text.length > 0);
  const text = nonEmptyPages.map((page) => page.text).join("\n\n").trim();

  if (!text || nonEmptyPages.length === 0) {
    throw new DocumentExtractionError("The document contains no readable text.");
  }

  return {
    text,
    pages: nonEmptyPages,
    pageCount,
    extractedCharacters: text.length,
    parser,
  };
}

function runPythonExtractor(inputPath: string, documentType: "pdf" | "docx" | "txt") {
  const scriptPath = "src/lib/rag/document_extractor.py";
  const pythonCommand = process.env.ARGUS_PYTHON_BIN || "python3";

  return new Promise<string>((resolve, reject) => {
    const child = spawn(pythonCommand, [scriptPath, "--input", inputPath, "--type", documentType], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;

    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize <= MAX_WORKER_OUTPUT_BYTES) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      reject(new DocumentExtractionError(`Unable to start Python extraction worker: ${error.message}`));
    });
    child.on("close", (exitCode) => {
      if (outputSize > MAX_WORKER_OUTPUT_BYTES) {
        reject(new DocumentExtractionError("Extracted text is too large to process safely. Please upload a smaller document."));
        return;
      }

      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (!output) {
        reject(new DocumentExtractionError(`Python extraction worker returned no output${errorOutput ? `: ${errorOutput}` : ""}`));
        return;
      }
      if (exitCode !== 0 && !output.startsWith("{")) {
        reject(new DocumentExtractionError(`Python extraction worker failed${errorOutput ? `: ${errorOutput}` : ""}`));
        return;
      }
      resolve(output);
    });
  });
}

async function extractWithPython(
  buffer: Buffer,
  documentType: "pdf" | "docx" | "txt"
): Promise<ExtractedData> {
  const tempDirectory = await mkdtemp(`${tmpdir().replace(/\/$/, "")}/argus-extract-`);
  const inputPath = `${tempDirectory}/source.${documentType}`;

  try {
    await writeFile(inputPath, buffer);
    const rawOutput = await runPythonExtractor(inputPath, documentType);
    let result: PythonExtractionResponse;
    try {
      result = JSON.parse(rawOutput) as PythonExtractionResponse;
    } catch {
      throw new DocumentExtractionError("The extraction worker returned an invalid response.");
    }

    if (!result.ok) {
      throw new DocumentExtractionError(
        result.error || "Document text extraction failed.",
        result.code === "SCANNED_PDF" ? "SCANNED_PDF" : "EXTRACTION_FAILED"
      );
    }

    return createExtractedData(result.pages, result.parser, result.pageCount);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function extractPdfWithNodeFallback(buffer: Buffer): Promise<ExtractedData> {
  let parser: PDFParse | null = null;
  try {
    parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText({ lineEnforce: true });
    return createExtractedData(
      result.pages.map((page) => ({ text: page.text, pageNumber: page.num })),
      "pdf-parse v2 fallback",
      result.total
    );
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
}

async function extractDocxWithNodeFallback(buffer: Buffer): Promise<ExtractedData> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return createExtractedData([{ text: result.value, pageNumber: null }], "mammoth fallback");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DocumentExtractionError(`Unable to parse DOCX content: ${message}`);
  }
}

function extractTxtWithNodeFallback(buffer: Buffer): ExtractedData {
  const encodings = ["utf-8", "utf-16le", "windows-1252", "iso-8859-1"];
  for (const encoding of encodings) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
      return createExtractedData([{ text, pageNumber: null }], `TextDecoder (${encoding})`);
    } catch {
      // Try the next safe decoding fallback.
    }
  }
  throw new DocumentExtractionError("Unable to decode this TXT file with a supported character encoding.");
}

/**
 * Extracts structured text from uploaded document bytes. PDF first runs the
 * requested PyMuPDF worker (with pdfplumber/pypdf fallback); when those Python
 * dependencies are unavailable in a managed Node runtime, pdf-parse v2 is used
 * as a genuine parser fallback. DOCX and TXT receive equivalent safe fallbacks.
 */
export async function extractText(
  buffer: Buffer,
  documentType: "pdf" | "docx" | "txt"
): Promise<ExtractedData> {
  if (documentType === "pdf") {
    try {
      return await extractWithPython(buffer, "pdf");
    } catch (error: unknown) {
      if (error instanceof DocumentExtractionError && error.code === "SCANNED_PDF") throw error;
      try {
        return await extractPdfWithNodeFallback(buffer);
      } catch (fallbackError: unknown) {
        const primaryMessage = error instanceof Error ? error.message : String(error);
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new DocumentExtractionError(`Unable to extract PDF text. PyMuPDF path: ${primaryMessage}. Fallback parser: ${fallbackMessage}`);
      }
    }
  }

  if (documentType === "docx") {
    try {
      return await extractWithPython(buffer, "docx");
    } catch {
      return extractDocxWithNodeFallback(buffer);
    }
  }

  // TXT has no structural page boundaries, so direct decoding is faster and
  // avoids spawning a Python process for normal text uploads.
  return extractTxtWithNodeFallback(buffer);
}
