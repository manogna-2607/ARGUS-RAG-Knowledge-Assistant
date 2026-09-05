import { cleanText } from "./chunker";
import { createCitations, formatCitation, NOT_FOUND_ANSWER } from "./citations";
import { tokenizeForSearch } from "./lexical";
import type { RetrievedChunk } from "./retrieval";

export interface LLMResponse {
  answer: string;
  usedSources: RetrievedChunk[];
}

type SentenceCandidate = {
  text: string;
  context: RetrievedChunk;
  terms: Set<string>;
  score: number;
};

function getQuestionTerms(query: string): string[] {
  return Array.from(new Set(tokenizeForSearch(query)));
}

function countMatchedTerms(text: string, questionTerms: string[]): number {
  const chunkTerms = new Set(tokenizeForSearch(text));
  return questionTerms.filter((term) => chunkTerms.has(term)).length;
}

/**
 * Discards weak candidate chunks before answer generation. A multi-term query
 * needs two distinct shared content terms; one-term questions remain supported
 * by one direct match. This prevents generic words from becoming evidence.
 */
function selectGroundingContexts(query: string, contexts: RetrievedChunk[]): RetrievedChunk[] {
  const questionTerms = getQuestionTerms(query);
  if (questionTerms.length === 0) return [];
  const requiredTermMatches = Math.min(2, questionTerms.length);

  return contexts.filter(
    (context) => countMatchedTerms(context.textContent, questionTerms) >= requiredTermMatches
  );
}

function isHeadingLike(text: string): boolean {
  return !/[.!?]$/.test(text.trim()) && text.length < 110 && !text.includes("\n");
}

function formatEvidenceText(text: string): string {
  // Chunks are already cleaned on ingestion; this final pass joins remaining
  // visual PDF wraps for answer readability without adding or removing facts.
  return cleanText(text).replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
}

/**
 * Generates a strictly extractive local answer. Query terms that appear in only
 * a subset of retrieved chunks receive a higher weight than corpus-wide domain
 * terms, making the selected sentences better match the user's actual intent.
 */
export function generateLocalFallbackResult(query: string, contexts: RetrievedChunk[]): LLMResponse {
  const questionTerms = getQuestionTerms(query);
  const supportedContexts = selectGroundingContexts(query, contexts);
  if (questionTerms.length === 0 || supportedContexts.length === 0) {
    return { answer: NOT_FOUND_ANSWER, usedSources: [] };
  }

  const sentencePool = supportedContexts.flatMap((context) =>
    context.textContent
      .split(/(?<=[.!?])\s+|\n{2,}/)
      .map((text) => text.trim())
      .filter((text) => text.length >= 3)
      .map((text) => ({ text, context, terms: new Set(tokenizeForSearch(text)) }))
  );

  const sentenceTermFrequency = new Map<string, number>();
  for (const candidate of sentencePool) {
    for (const term of questionTerms) {
      if (candidate.terms.has(term)) {
        sentenceTermFrequency.set(term, (sentenceTermFrequency.get(term) || 0) + 1);
      }
    }
  }

  const observedQuestionTerms = questionTerms.filter((term) => (sentenceTermFrequency.get(term) || 0) > 0);
  if (observedQuestionTerms.length === 0) return { answer: NOT_FOUND_ANSWER, usedSources: [] };

  const leastFrequentCount = Math.min(
    ...observedQuestionTerms.map((term) => sentenceTermFrequency.get(term) || 0)
  );
  // Focus on the rarest observed query terms at sentence scope. This is the
  // lexical equivalent of selecting the user's most discriminative intent.
  const focusTerms = observedQuestionTerms.filter(
    (term) => (sentenceTermFrequency.get(term) || 0) === leastFrequentCount
  );
  const termWeights = new Map(
    observedQuestionTerms.map((term) => {
      const frequency = sentenceTermFrequency.get(term) || 0;
      const specificity = Math.log((sentencePool.length + 1) / (frequency + 0.5));
      return [term, 1 + Math.max(0, specificity) * 2] as const;
    })
  );

  const candidates: SentenceCandidate[] = sentencePool
    .map((candidate) => {
      const matchingTerms = observedQuestionTerms.filter((term) => candidate.terms.has(term));
      const weightedScore = matchingTerms.reduce(
        (score, term) => score + (termWeights.get(term) || 1),
        0
      );
      return {
        ...candidate,
        // Headings can be useful context but should not outrank full facts.
        score: weightedScore - (isHeadingLike(candidate.text) ? 0.8 : 0),
      };
    })
    .filter((candidate) => {
      const matchedTerms = observedQuestionTerms.filter((term) => candidate.terms.has(term));
      if (matchedTerms.length === 0) return false;
      // A rare observed term keeps broad framework references from displacing
      // direct sentences about the specific item being asked about.
      return focusTerms.some((term) => candidate.terms.has(term));
    });

  if (candidates.length === 0) return { answer: NOT_FOUND_ANSWER, usedSources: [] };

  const selected = candidates
    .sort((a, b) => b.score - a.score || b.context.similarity - a.context.similarity)
    .filter(
      (candidate, index, items) =>
        items.findIndex((item) => item.text.toLowerCase() === candidate.text.toLowerCase()) === index
    )
    .slice(0, 2);

  if (selected.length === 0) return { answer: NOT_FOUND_ANSWER, usedSources: [] };

  const usedSources = Array.from(
    new Map(selected.map((candidate) => [candidate.context.chunkId, candidate.context])).values()
  );

  const formattedEvidence = selected.map(({ text, context }) => ({
    text: formatEvidenceText(text),
    context,
  }));

  const answer =
    formattedEvidence.length === 1
      ? `According to **${formattedEvidence[0].context.documentName}**:\n\n${formattedEvidence[0].text} ${formatCitation(
          formattedEvidence[0].context.documentName,
          formattedEvidence[0].context.pageNumber
        )}`
      : `Based on the indexed sources:\n\n${formattedEvidence
          .map(
            ({ text, context }) =>
              `• ${text} ${formatCitation(context.documentName, context.pageNumber)}`
          )
          .join("\n")}`;

  return { answer, usedSources };
}

/** Backward-compatible text-only entrypoint for local grounded generation. */
export function generateLocalFallbackResponse(query: string, contexts: RetrievedChunk[]): string {
  return generateLocalFallbackResult(query, contexts).answer;
}

function appendMissingCitations(answer: string, contexts: RetrievedChunk[]): string {
  const citations = createCitations(contexts);
  if (citations.length === 0 || answer === NOT_FOUND_ANSWER) return answer;

  const missing = citations.filter((citation) => !answer.includes(citation.label));
  return missing.length > 0
    ? `${answer.trim()}\n\n${missing.map((citation) => citation.label).join("\n")}`
    : answer;
}

function getOpenAIAnswer(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = record.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim() ? content.trim() : null;
}

function getGeminiAnswer(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
  const text = record.candidates?.[0]?.content?.parts?.[0]?.text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

/** Queries a selected provider using only confident retrieved source context. */
export async function generateGroundedAnswer(
  query: string,
  contexts: RetrievedChunk[],
  config: {
    provider: "local" | "openai" | "gemini";
    apiKey?: string;
    temperature?: number;
    systemPrompt?: string;
  }
): Promise<LLMResponse> {
  const groundedContexts = selectGroundingContexts(query, contexts);
  if (groundedContexts.length === 0) return { answer: NOT_FOUND_ANSWER, usedSources: [] };

  const contextBlock = groundedContexts
    .map((context) => `${formatCitation(context.documentName, context.pageNumber)}\n${context.textContent}`)
    .join("\n\n---\n\n");
  const defaultSystemPrompt = `You are ARGUS, a private knowledge assistant. Answer only from the provided retrieved context. Every factual claim must include one of the exact [Source: ...] citations supplied with that context. Never use outside knowledge. If the answer is not supported by the context, respond exactly: "${NOT_FOUND_ANSWER}"`;
  const systemPrompt = config.systemPrompt || defaultSystemPrompt;
  const userPrompt = `RETRIEVED CONTEXT:\n${contextBlock}\n\nUSER QUESTION:\n${query}\n\nGROUNDED ANSWER:`;
  const temperature = config.temperature ?? 0.2;

  if (config.provider === "openai" && config.apiKey) {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature,
        }),
      });
      const answer = response.ok ? getOpenAIAnswer(await response.json()) : null;
      if (answer) return { answer: appendMissingCitations(answer, groundedContexts), usedSources: groundedContexts };
    } catch (error) {
      console.warn("OpenAI grounded answer failed; using local extractive fallback.", error);
    }
  }

  if (config.provider === "gemini" && config.apiKey) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${config.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
            generationConfig: { temperature },
          }),
        }
      );
      const answer = response.ok ? getGeminiAnswer(await response.json()) : null;
      if (answer) return { answer: appendMissingCitations(answer, groundedContexts), usedSources: groundedContexts };
    } catch (error) {
      console.warn("Gemini grounded answer failed; using local extractive fallback.", error);
    }
  }

  return generateLocalFallbackResult(query, groundedContexts);
}
