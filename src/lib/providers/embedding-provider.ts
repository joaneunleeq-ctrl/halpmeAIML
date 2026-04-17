// Embedding Provider Abstraction Layer
// PRD §4.2: Provider swaps via env var, not code changes
// Local: sentence-transformers all-mpnet-base-v2 (768 dims)
// OpenAI: text-embedding-3-large (3072 dims)

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<boolean>;
}

// ============================================================
// Local Embedding Provider (sentence-transformers via HTTP server)
// ============================================================

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly dimensions = 768;
  private serverUrl: string;

  constructor() {
    this.serverUrl = process.env.EMBEDDING_SERVER_URL || "http://localhost:5001";
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.serverUrl}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Local embedding error (${res.status}): ${err}`);
    }

    const data = await res.json();
    return data.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const batchSize = 32;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const res = await fetch(`${this.serverUrl}/embed-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: batch }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Local embedding batch error (${res.status}): ${err}`);
      }

      const data = await res.json();
      allEmbeddings.push(...data.embeddings);
    }

    return allEmbeddings;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ============================================================
// OpenAI Embedding Provider
// ============================================================

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimensions = 3072;
  private apiKey: string;
  private model = "text-embedding-3-large";

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY || "";
    if (!this.apiKey) {
      console.warn("OPENAI_API_KEY not set — OpenAI embedding provider will fail");
    }
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI embedding error (${res.status}): ${err}`);
    }

    const data = await res.json();
    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const batchSize = 100;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenAI embedding batch error (${res.status}): ${err}`);
      }

      const data = await res.json();
      const sorted = data.data.sort(
        (a: { index: number }, b: { index: number }) => a.index - b.index
      );
      allEmbeddings.push(...sorted.map((d: { embedding: number[] }) => d.embedding));
    }

    return allEmbeddings;
  }

  async healthCheck(): Promise<boolean> {
    return !!this.apiKey;
  }
}

// ============================================================
// Factory
// ============================================================

let cachedProvider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (cachedProvider) return cachedProvider;

  const provider = process.env.EMBEDDING_PROVIDER || "local";

  switch (provider) {
    case "local":
      cachedProvider = new LocalEmbeddingProvider();
      break;
    case "openai":
      cachedProvider = new OpenAIEmbeddingProvider();
      break;
    default:
      throw new Error(
        `Unknown EMBEDDING_PROVIDER: "${provider}". Valid options: local, openai`
      );
  }

  console.log(
    `Embedding provider initialized: ${cachedProvider.name} (${cachedProvider.dimensions} dims)`
  );
  return cachedProvider;
}
