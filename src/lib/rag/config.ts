import { db } from "../../db";
import { settings } from "../../db/schema";

export type EmbeddingProvider = "local" | "openai" | "gemini";

export interface RagSettings {
  provider: EmbeddingProvider;
  openAIKey?: string;
  geminiKey?: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  temperature: number;
  systemPrompt?: string;
}

export const DEFAULT_RAG_SETTINGS = {
  llm_provider: "local",
  openai_api_key: "",
  gemini_api_key: "",
  chunk_size: "3200", // approximately 500–800 English tokens
  chunk_overlap: "500", // approximately 80–120 English tokens
  top_k: "5",
  temperature: "0.2",
  system_prompt: "",
} as const;

function clampNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

/** Loads server-only RAG configuration from PostgreSQL and environment secrets. */
export async function loadRagSettings(): Promise<RagSettings> {
  const storedSettings = await db.select().from(settings);
  const values: Record<string, string> = { ...DEFAULT_RAG_SETTINGS };

  for (const setting of storedSettings) values[setting.key] = setting.value;

  const candidateProvider = values.llm_provider as EmbeddingProvider;
  const requestedProvider: EmbeddingProvider = ["local", "openai", "gemini"].includes(candidateProvider)
    ? candidateProvider
    : "local";

  // Environment values take precedence and never leave the server. Database
  // values preserve backward compatibility with the existing write-only form.
  const openAIKey = process.env.OPENAI_API_KEY || values.openai_api_key || undefined;
  const geminiKey = process.env.GEMINI_API_KEY || values.gemini_api_key || undefined;
  const provider: EmbeddingProvider =
    requestedProvider === "openai" && !openAIKey
      ? "local"
      : requestedProvider === "gemini" && !geminiKey
        ? "local"
        : requestedProvider;

  return {
    provider,
    openAIKey,
    geminiKey,
    chunkSize: clampNumber(values.chunk_size, 3200, 500, 12000),
    chunkOverlap: clampNumber(values.chunk_overlap, 500, 0, 3000),
    topK: clampNumber(values.top_k, 5, 1, 15),
    temperature: Math.min(Math.max(Number(values.temperature) || 0.2, 0), 1),
    systemPrompt: values.system_prompt || undefined,
  };
}

/** Produces settings that are safe to return to a browser. */
export async function loadPublicSettings() {
  const config = await loadRagSettings();
  return {
    llm_provider: config.provider,
    openai_api_key: "",
    gemini_api_key: "",
    openai_api_key_configured: Boolean(config.openAIKey),
    gemini_api_key_configured: Boolean(config.geminiKey),
    chunk_size: String(config.chunkSize),
    chunk_overlap: String(config.chunkOverlap),
    top_k: String(config.topK),
    temperature: String(config.temperature),
    system_prompt: config.systemPrompt || "",
  };
}
