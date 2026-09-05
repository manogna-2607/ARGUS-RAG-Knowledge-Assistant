/**
 * Computes the cosine similarity between two numeric vectors.
 */
export function computeCosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Standard list of English stop words to exclude from local embeddings.
 */
const STOP_WORDS = new Set([
  "i", "me", "my", "myself", "we", "our", "ours", "ourselves", "you", "your", "yours", 
  "yourself", "yourselves", "he", "him", "his", "himself", "she", "her", "hers", 
  "herself", "it", "its", "itself", "they", "them", "their", "theirs", "themselves", 
  "what", "which", "who", "whom", "this", "that", "these", "those", "am", "is", "are", 
  "was", "were", "be", "been", "being", "have", "has", "had", "having", "do", "does", 
  "did", "doing", "a", "an", "the", "and", "but", "if", "or", "because", "as", "until", 
  "while", "of", "at", "by", "for", "with", "about", "against", "between", "into", 
  "through", "during", "before", "after", "above", "below", "to", "from", "up", "down", 
  "in", "out", "on", "off", "over", "under", "again", "further", "then", "once", "here", 
  "there", "when", "where", "why", "how", "all", "any", "both", "each", "few", "more", 
  "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so", 
  "than", "too", "very", "s", "t", "can", "will", "just", "don", "should", "now"
]);

/**
 * Replaceable Embedding Service Interface
 */
export interface EmbeddingService {
  generateEmbedding(text: string): Promise<number[]>;
}

/**
 * Local deterministic vectorizer using Feature Hashing (The Hashing Trick) + TF-IDF.
 * Generates a 128-dimensional normalized dense embedding from text.
 */
export class LocalEmbeddingService implements EmbeddingService {
  async generateEmbedding(text: string): Promise<number[]> {
    const DIMENSIONS = 128;
    const vector = new Array(DIMENSIONS).fill(0);
    
    if (!text) return vector;
    
    // Normalize, lowercase and split into words
    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/);
      
    for (const word of words) {
      if (!word || STOP_WORDS.has(word)) continue;
      
      // Hash word to an index between 0 and DIMENSIONS - 1
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = (hash * 31 + word.charCodeAt(i)) % DIMENSIONS;
      }
      const idx = Math.abs(hash) % DIMENSIONS;
      vector[idx] += 1.0;
    }
    
    // Add bigram features
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]}_${words[i+1]}`;
      if (!words[i] || !words[i+1] || STOP_WORDS.has(words[i]) || STOP_WORDS.has(words[i+1])) continue;
      
      let hash = 0;
      for (let j = 0; j < bigram.length; j++) {
        hash = (hash * 31 + bigram.charCodeAt(j)) % DIMENSIONS;
      }
      const idx = Math.abs(hash) % DIMENSIONS;
      vector[idx] += 1.5;
    }

    // Normalize (L2 norm)
    let sumSq = 0;
    for (let i = 0; i < DIMENSIONS; i++) {
      sumSq += vector[i] * vector[i];
    }
    
    const magnitude = Math.sqrt(sumSq);
    if (magnitude > 0) {
      for (let i = 0; i < DIMENSIONS; i++) {
        vector[i] = vector[i] / magnitude;
      }
    }
    
    return vector;
  }
}

/**
 * OpenAI API embedding generator
 */
export class OpenAIEmbeddingService implements EmbeddingService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new Error("OpenAI API key is missing");
    }

    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: text,
        model: "text-embedding-3-small",
      }),
    });

    if (!response.ok) {
      const errJson = await response.json().catch(() => ({}));
      throw new Error(
        errJson.error?.message || `OpenAI Embedding API failed (status: ${response.status})`
      );
    }

    const resJson = await response.json();
    return resJson.data[0].embedding;
  }
}

/**
 * Google Gemini API embedding generator
 */
export class GeminiEmbeddingService implements EmbeddingService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new Error("Gemini API key is missing");
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${this.apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: {
            parts: [{ text }],
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini Embedding API failed (status: ${response.status})`);
    }

    const resJson = await response.json();
    return resJson.embedding.values;
  }
}

/**
 * Replaceable embedding service factory method
 */
export function getEmbeddingService(
  provider: "local" | "openai" | "gemini",
  apiKey?: string
): EmbeddingService {
  // Use explicit custom key or read from environment variable if present
  const openAIKey = apiKey || process.env.OPENAI_API_KEY || "";
  const geminiKey = apiKey || process.env.GEMINI_API_KEY || "";

  if (provider === "openai" && openAIKey) {
    return new OpenAIEmbeddingService(openAIKey);
  }

  if (provider === "gemini" && geminiKey) {
    return new GeminiEmbeddingService(geminiKey);
  }

  // Fallback to local
  return new LocalEmbeddingService();
}

/**
 * Generates embeddings for a batch with bounded concurrency. Embeddings are all
 * prepared before insertion, so an embedding failure cannot create partial vectors.
 */
export async function embedTexts(
  texts: string[],
  service: EmbeddingService,
  concurrency = 3
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const results = new Array<number[]>(texts.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), texts.length);

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= texts.length) return;
      const embedding = await service.generateEmbedding(texts[index]);
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error(`Embedding service returned an empty vector for chunk ${index}.`);
      }
      results[index] = embedding;
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Backward compatibility helper function
 */
export async function getEmbedding(
  text: string,
  config: {
    provider: "local" | "openai" | "gemini";
    apiKey?: string;
  }
): Promise<number[]> {
  const service = getEmbeddingService(config.provider, config.apiKey);
  return service.generateEmbedding(text);
}
