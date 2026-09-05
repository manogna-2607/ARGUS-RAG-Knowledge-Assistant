export interface TextChunk {
  textContent: string;
  chunkIndex: number;
  pageNumber: number | null;
}

const BULLET_OR_NUMBERED_LINE = /^(?:[-•▪◦‣]|\d+[.)]|[A-Za-z][.)])\s+/;
const LETTER_SPACED_WORD = /\b(?:[A-Z]\s+){3,}[A-Z]\b/g;

// Common heading vocabulary used only to separate PDF glyph runs after their
// spaces have been collapsed. It never changes normal sentence-case prose.
const UPPERCASE_HEADING_WORDS = [
  "ARTIFICIAL", "INTELLIGENCE", "INNOVATION", "INTERNSHIP", "INTEGRATION", "AUTOMATION",
  "ASSISTANT", "ASSISTANTS", "KNOWLEDGE", "RETRIEVAL", "GENERATIVE", "TECHNOLOGY",
  "TECHNOLOGIES", "REQUIREMENTS", "REQUIRED", "SUBMISSIONS", "SUBMISSION", "EVALUATION",
  "STRUCTURE", "PHILOSOPHY", "OVERVIEW", "OBJECTIVE", "FEATURES", "SUGGESTED", "MINIMUM",
  "PROJECT", "PROJECTS", "PRODUCTIVITY", "CAPSTONE", "DEVELOPMENT", "DOCUMENT", "DOCUMENTS",
  "WORKFLOW", "WORKFLOWS", "APPLICATION", "APPLICATIONS", "ARCHITECTURE", "PROFESSIONAL",
  "INNOVATE", "INNOVATION", "HACKS", "HANDBOOK", "WEEKLY", "WEEK", "PAGE", "BUILD",
  "LEARN", "REAL", "WORLD", "MEDIUM", "EASY", "HARD", "DIFFICULTY", "CORE", "POLICY",
  "TOOLS", "POSSIBLE", "DOMAINS", "RECOMMENDED", "OPTIONAL", "DEPLOYMENT", "REPOSITORY",
  "GITHUB", "LINKEDIN", "PYTHON", "SENTENCE", "TRANSFORMERS", "CONTEXT", "EMBEDDINGS",
  "VECTOR", "SEARCH", "SOURCE", "REFERENCE", "DISPLAY", "RESPONSES", "PIPELINE", "README",
  "OPENAI", "GEMINI", "ANTHROPIC", "LANGCHAIN", "LLAMAINDEX", "FAISS", "CHROMA", "FASTAPI",
  "STREAMLIT", "REACT", "NEXT", "FLASK", "AI", "RAG", "LLM", "PDF", "API", "OF", "THE",
].sort((a, b) => b.length - a.length);

function segmentFusedUppercaseToken(token: string): string {
  if (token.length < 8 || !/^[A-Z]+$/.test(token)) return token;

  const memo = new Map<number, string[] | null>();
  const segmentFrom = (start: number): string[] | null => {
    if (start === token.length) return [];
    if (memo.has(start)) return memo.get(start) || null;

    for (const word of UPPERCASE_HEADING_WORDS) {
      if (!token.startsWith(word, start)) continue;
      const remainder = segmentFrom(start + word.length);
      if (remainder) {
        const result = [word, ...remainder];
        memo.set(start, result);
        return result;
      }
    }

    memo.set(start, null);
    return null;
  };

  const segments = segmentFrom(0);
  return segments && segments.length > 1 ? segments.join(" ") : token;
}

function normaliseSpacedLetters(value: string): string {
  // PDF glyph extraction may return headings as “A R T I F I C I A L”.
  // Only collapse runs of at least four isolated uppercase characters so normal
  // prose and intentional two/three-letter abbreviations remain untouched.
  return value.replace(LETTER_SPACED_WORD, (word) => word.replace(/\s+/g, ""));
}

function repairFragmentedProseWords(value: string): string {
  let repaired = value
    // Repairs glyph output such as “We e k” without touching normal words.
    .replace(/\b([A-Z][a-z]?)(?:\s+[a-z]){2,}\b/g, (word) => word.replace(/\s+/g, ""));

  // Reconstruct a run of uppercase glyph fragments only when it can be fully
  // segmented into known heading words. This repairs labels such as
  // “P RO JECT” and “O BJECT IVE” without changing normal body prose.
  repaired = repaired.replace(/\b(?:[A-Z]{1,8}\s+){1,}[A-Z]{1,16}\b/g, (group) => {
    const compact = group.replace(/\s+/g, "");
    const segmented = segmentFusedUppercaseToken(compact);
    return segmented !== compact || UPPERCASE_HEADING_WORDS.includes(compact)
      ? segmented
      : group;
  });

  // These are common English suffixes. Rejoining only recognized suffixes
  // prevents false merges such as “This is” while repairing “Proje ct”.
  const suffixPattern = /\b([A-Za-z]{4,})\s+(tion|tions|ment|ments|ing|ed|er|ers|al|ally|ity|ies|ive|able|ship|ance|ence|ure|ures|ant|ants|ct|ks)\b/g;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = repaired.replace(suffixPattern, "$1$2");
    if (next === repaired) break;
    repaired = next;
  }

  return repaired
    .replace(/\b([A-Za-z]{4,})\s+io\s+n\b/g, "$1ion")
    .replace(/\b([A-Za-z]{4,})\s+at\s+ion\b/g, "$1ation")
    .replace(/\bPyt\s+hon\b/gi, "Python")
    .replace(/\bO\s+penAI\b/gi, "OpenAI")
    .replace(/\bAnt\s+hropic\b/gi, "Anthropic")
    .replace(/\bSt\s+reamlit\b/gi, "Streamlit")
    .replace(/\bTransf\s+ormers\b/gi, "Transformers")
    .replace(/\bGit\s+Hub\b/gi, "GitHub")
    .replace(/\bFast\s+API\b/g, "FastAPI")
    .replace(/\b(React|Next)\s+\.\s*js\b/gi, "$1.js")
    .replace(/\bRetrieval-\s+Augmented\b/gi, "Retrieval-Augmented");
}

function normaliseFragmentedUppercaseLine(value: string): string {
  const repairedProse = repairFragmentedProseWords(value);
  const line = normaliseSpacedLetters(repairedProse);
  const letters = line.match(/\p{L}/gu) || [];
  if (letters.length < 4) return line;

  const uppercaseRatio = (line.match(/[A-Z]/g) || []).length / letters.length;
  const compact = line.replace(/\s+/g, "");
  const segments = compact
    .split(/([A-Z]+|\d+|[^A-Z\d]+)/)
    .filter(Boolean)
    .map((part) => (/^[A-Z]+$/.test(part) ? segmentFusedUppercaseToken(part) : part))
    .join("");
  const hasGlyphSpacing = /(?:\b[A-Z]\s+){2,}[A-Z]\b/.test(value);

  // Only rebuild high-uppercase PDF display/header lines that are either glyph
  // spaced or clearly fused heading words. Normal title-case body text remains
  // untouched, preserving original sentence wording.
  if (uppercaseRatio >= 0.78 && (hasGlyphSpacing || segments !== compact)) {
    return segments
      .replace(/([:→])/g, " $1 ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  return line;
}

function isHeading(line: string): boolean {
  const letters = line.match(/\p{L}/gu) || [];
  if (letters.length < 3 || line.length > 120 || /[.!?:;]$/.test(line)) return false;
  const uppercaseLetters = (line.match(/[A-Z]/g) || []).length;
  return uppercaseLetters / letters.length >= 0.78;
}

function shouldKeepLineBreak(previous: string, current: string): boolean {
  return (
    isHeading(previous) ||
    BULLET_OR_NUMBERED_LINE.test(previous) ||
    BULLET_OR_NUMBERED_LINE.test(current) ||
    previous.includes("|") ||
    current.includes("|")
  );
}

function cleanPdfLine(line: string): string {
  let cleaned = line.trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const next = normaliseFragmentedUppercaseLine(cleaned)
      .replace(/\bWEEK\s*0?\s*([1-9])\b/gi, "WEEK $1")
      .replace(/([A-Za-z])(?=\d)/g, "$1 ")
      .replace(/(\d)(?=[A-Za-z])/g, "$1 ")
      .replace(/\bPAGE\s*0?(\d+)\s*OF\s*0?(\d+)\b/gi, "PAGE $1 OF $2");
    if (next === cleaned) break;
    cleaned = next;
  }
  return cleaned;
}

function cleanParagraph(paragraph: string): string {
  const lines = paragraph
    .split("\n")
    .map(cleanPdfLine)
    .filter(Boolean);

  const mergedLines: string[] = [];
  for (const line of lines) {
    const previous = mergedLines[mergedLines.length - 1];
    // Join PDF word wraps such as “informa-\ntion” without adding a space.
    if (previous && /[\p{L}\p{N}]-$/u.test(previous) && /^\p{Ll}/u.test(line)) {
      mergedLines[mergedLines.length - 1] = `${previous.slice(0, -1)}${line}`;
    } else {
      mergedLines.push(line);
    }
  }

  return mergedLines.reduce((result, line, index) => {
    if (index === 0) return line;
    const previous = mergedLines[index - 1];
    return `${result}${shouldKeepLineBreak(previous, line) ? "\n" : " "}${line}`;
  }, "");
}

/**
 * Cleans parser output without changing source meaning: normalizes Unicode,
 * removes non-printing artifacts, repairs line-wrap artifacts, and preserves
 * meaningful headings/list/table line boundaries and paragraph breaks.
 */
export function cleanText(text: string): string {
  if (!text) return "";

  const normalised = text
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00AD/g, "") // soft hyphen
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ")
    .replace(/[\uD800-\uDFFF]/g, "�")
    // PDF parsers use tabs for visual columns; treat them as source line breaks
    // before normalizing horizontal whitespace.
    .replace(/\t+/g, "\n")
    .replace(/[ ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalised
    .split(/\n{2,}/)
    .map(cleanParagraph)
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/**
 * Splits text into overlapping chunks of a target size while preferring
 * paragraph, sentence, and word boundaries.
 */
export function chunkText(
  text: string,
  options: {
    chunkSize?: number;
    chunkOverlap?: number;
    pageNumber?: number | null;
    startIndex?: number;
  } = {}
): TextChunk[] {
  const configuredChunkSize = options.chunkSize ?? 1000;
  const chunkSize = Math.max(100, Math.floor(configuredChunkSize));
  const configuredOverlap = options.chunkOverlap ?? 200;
  const chunkOverlap = Math.min(Math.max(0, Math.floor(configuredOverlap)), chunkSize - 1);
  const pageNumber = options.pageNumber ?? null;
  const startIndex = options.startIndex ?? 0;

  const cleaned = cleanText(text);
  if (!cleaned) return [];

  // A short page/document is already a complete, meaningful chunk. This avoids
  // producing duplicate tail chunks when configured overlap exceeds its length.
  if (cleaned.length <= chunkSize) {
    return [{ textContent: cleaned, chunkIndex: startIndex, pageNumber }];
  }

  const chunks: TextChunk[] = [];
  let index = 0;
  let chunkIndex = startIndex;

  while (index < cleaned.length) {
    let end = Math.min(index + chunkSize, cleaned.length);

    // For non-terminal chunks, move the boundary to a nearby natural delimiter.
    if (end < cleaned.length) {
      const searchStart = Math.max(index, end - Math.floor(chunkSize * 0.3));
      const searchEnd = Math.min(cleaned.length, end + Math.floor(chunkSize * 0.1));
      const boundaryArea = cleaned.substring(searchStart, searchEnd);

      let boundaryIndex = boundaryArea.lastIndexOf("\n\n");
      let boundaryOffset = 2;

      if (boundaryIndex === -1) {
        boundaryIndex = boundaryArea.lastIndexOf("\n");
        boundaryOffset = 1;
      }
      if (boundaryIndex === -1) {
        boundaryIndex = boundaryArea.lastIndexOf(". ");
        boundaryOffset = 2;
      }
      if (boundaryIndex === -1) {
        boundaryIndex = boundaryArea.lastIndexOf(" ");
        boundaryOffset = 1;
      }

      if (boundaryIndex !== -1) {
        const naturalEnd = searchStart + boundaryIndex + boundaryOffset;
        if (naturalEnd > index + Math.floor(chunkSize * 0.5)) end = naturalEnd;
      }
    }

    const chunkContent = cleaned.substring(index, end).trim();
    if (chunkContent) {
      chunks.push({ textContent: chunkContent, chunkIndex: chunkIndex++, pageNumber });
    }

    // Terminal chunks do not need an overlapping successor.
    if (end >= cleaned.length) break;
    // Because overlap is clamped below chunkSize, this always advances.
    index = Math.max(index + 1, end - chunkOverlap);
  }

  return chunks;
}

/** Splits document pages into chunks while preserving original page numbers. */
export function chunkPages(
  pages: { text: string; pageNumber: number | null }[],
  options: { chunkSize?: number; chunkOverlap?: number } = {}
): TextChunk[] {
  const allChunks: TextChunk[] = [];
  let globalChunkIndex = 0;

  for (const page of pages) {
    const pageChunks = chunkText(page.text, {
      ...options,
      pageNumber: page.pageNumber,
      startIndex: globalChunkIndex,
    });
    allChunks.push(...pageChunks);
    globalChunkIndex += pageChunks.length;
  }

  return allChunks;
}
