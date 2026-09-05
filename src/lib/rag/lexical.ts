import type { SearchedChunk } from "./vectorStore";

/** Common terms that should not determine lexical relevance on their own. */
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "did", "for", "from", "how",
  "i", "in", "is", "it", "its", "me", "my", "of", "on", "or", "please", "the", "that", "their",
  "there", "these", "this", "to", "was", "we", "were", "what", "when", "where", "which", "who",
  "why", "with", "would", "you", "your", "explain", "describe", "summarize", "summary", "list",
  "tell", "give", "show", "provide", "define", "outline", "include", "included",
]);

/** Applies conservative normalization for plural forms used in questions/headings. */
function normalizeSearchToken(token: string): string {
  if (/^\d+$/.test(token)) return String(Number(token));
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/**
 * Produces a stable, case-insensitive token stream. Unicode normalization
 * handles accented terms while punctuation and whitespace become separators.
 */
export function tokenizeForSearch(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .map(normalizeSearchToken)
    .filter((token) => (token.length > 1 || /^\d+$/.test(token)) && !STOP_WORDS.has(token));
}

function termFrequency(tokens: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
  return frequencies;
}

/**
 * BM25-style local lexical ranking. It deliberately works for a one-document,
 * one-chunk corpus: terms occurring in every document retain a small positive
 * IDF rather than being discarded.
 */
export function rankLexically(
  query: string,
  chunks: SearchedChunk[],
  limit: number,
  minScore = 0.05
): SearchedChunk[] {
  const queryTerms = Array.from(new Set(tokenizeForSearch(query)));
  if (queryTerms.length === 0 || chunks.length === 0) return [];

  const chunkTokens = chunks.map((chunk) => tokenizeForSearch(chunk.textContent));
  const averageLength = Math.max(
    1,
    chunkTokens.reduce((total, tokens) => total + tokens.length, 0) / chunkTokens.length
  );
  const documentFrequency = new Map<string, number>();

  for (const tokens of chunkTokens) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }

  const corpusSize = chunks.length;
  const k1 = 1.2;
  const b = 0.75;
  const requestedWeek = /\bweek\s*0*([1-9]\d*)\b/i.exec(query)?.[1];

  return chunks
    .map((chunk, index) => {
      const tokens = chunkTokens[index];
      const frequencies = termFrequency(tokens);
      let score = queryTerms.reduce((total, term) => {
        const frequency = frequencies.get(term) || 0;
        if (frequency === 0) return total;

        const df = documentFrequency.get(term) || 0;
        // This BM25 variant stays positive when corpusSize === 1 and df === 1.
        const idf = Math.log(1 + (corpusSize - df + 0.5) / (df + 0.5));
        const denominator = frequency + k1 * (1 - b + (b * tokens.length) / averageLength);
        return total + idf * ((frequency * (k1 + 1)) / denominator);
      }, 0);

      // Explicit section labels deserve priority over generic mentions spread
      // across a submission checklist. This works for Week/Chapter-style docs
      // without introducing data that is not in the actual chunk text.
      if (requestedWeek && new RegExp(`\\bweek\\s*0*${requestedWeek}\\b`, "i").test(chunk.textContent)) {
        score += 1.25;
        if (/\bobjective\b|\bcore features?\b|\brequirements?\b/i.test(chunk.textContent)) {
          score += 2.25;
        }
      }

      return { ...chunk, similarity: score };
    })
    .filter((chunk) => chunk.similarity >= minScore)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}
