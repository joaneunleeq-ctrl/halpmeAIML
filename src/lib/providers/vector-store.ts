// Vector Store Abstraction Layer
// Local dev: Chroma (standalone vector DB)
// Production: pgvector (PostgreSQL extension)

export interface VectorResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
  content?: string;
}

export interface VectorStore {
  readonly name: string;
  upsert(
    collection: string,
    id: string,
    embedding: number[],
    metadata: Record<string, unknown>,
    content?: string
  ): Promise<void>;
  upsertBatch(
    collection: string,
    items: Array<{
      id: string;
      embedding: number[];
      metadata: Record<string, unknown>;
      content?: string;
    }>
  ): Promise<void>;
  query(
    collection: string,
    embedding: number[],
    k: number,
    filter?: Record<string, unknown>
  ): Promise<VectorResult[]>;
  healthCheck(): Promise<boolean>;
}

// ============================================================
// Chroma Vector Store (local development)
// ============================================================

export class ChromaVectorStore implements VectorStore {
  readonly name = "chroma";
  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.CHROMA_URL || "http://localhost:8000";
  }

  private async getOrCreateCollection(collection: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/v1/collections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: collection,
        get_or_create: true,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Chroma collection error: ${err}`);
    }

    const data = await res.json();
    return data.id;
  }

  async upsert(
    collection: string,
    id: string,
    embedding: number[],
    metadata: Record<string, unknown>,
    content?: string
  ): Promise<void> {
    const collectionId = await this.getOrCreateCollection(collection);

    const res = await fetch(
      `${this.baseUrl}/api/v1/collections/${collectionId}/upsert`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: [id],
          embeddings: [embedding],
          metadatas: [metadata],
          documents: content ? [content] : undefined,
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Chroma upsert error: ${err}`);
    }
  }

  async upsertBatch(
    collection: string,
    items: Array<{
      id: string;
      embedding: number[];
      metadata: Record<string, unknown>;
      content?: string;
    }>
  ): Promise<void> {
    if (items.length === 0) return;

    const collectionId = await this.getOrCreateCollection(collection);
    const batchSize = 100;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      const res = await fetch(
        `${this.baseUrl}/api/v1/collections/${collectionId}/upsert`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ids: batch.map((item) => item.id),
            embeddings: batch.map((item) => item.embedding),
            metadatas: batch.map((item) => item.metadata),
            documents: batch.map((item) => item.content || ""),
          }),
        }
      );

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Chroma batch upsert error: ${err}`);
      }
    }
  }

  async query(
    collection: string,
    embedding: number[],
    k: number,
    filter?: Record<string, unknown>
  ): Promise<VectorResult[]> {
    const collectionId = await this.getOrCreateCollection(collection);

    const body: Record<string, unknown> = {
      query_embeddings: [embedding],
      n_results: k,
      include: ["metadatas", "documents", "distances"],
    };

    if (filter && Object.keys(filter).length > 0) {
      body.where = filter;
    }

    const res = await fetch(
      `${this.baseUrl}/api/v1/collections/${collectionId}/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Chroma query error: ${err}`);
    }

    const data = await res.json();

    if (!data.ids?.[0]) return [];

    return data.ids[0].map((id: string, i: number) => ({
      id,
      score: 1 - (data.distances?.[0]?.[i] || 0),
      metadata: data.metadatas?.[0]?.[i] || {},
      content: data.documents?.[0]?.[i] || undefined,
    }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/heartbeat`);
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ============================================================
// pgvector Store (production — uses PostgreSQL)
// ============================================================

export class PgVectorStore implements VectorStore {
  readonly name = "pgvector";

  private async getDb() {
    const { query } = await import("@/lib/db");
    return query;
  }

  async upsert(
    collection: string,
    id: string,
    embedding: number[],
    metadata: Record<string, unknown>,
    content?: string
  ): Promise<void> {
    const query = await this.getDb();
    const vectorStr = `[${embedding.join(",")}]`;
    const table = this.collectionToTable(collection);

    if (table === "paper_sections") {
      await query(
        `UPDATE paper_sections SET embedding = $1::vector WHERE section_id = $2`,
        [vectorStr, id]
      );
    } else if (table === "paper_chunks") {
      await query(
        `UPDATE paper_chunks SET embedding = $1::vector WHERE chunk_id = $2`,
        [vectorStr, id]
      );
    } else if (table === "concepts") {
      await query(
        `UPDATE concepts SET embedding = $1::vector WHERE concept_id = $2`,
        [vectorStr, id]
      );
    }
  }

  async upsertBatch(
    collection: string,
    items: Array<{
      id: string;
      embedding: number[];
      metadata: Record<string, unknown>;
      content?: string;
    }>
  ): Promise<void> {
    for (const item of items) {
      await this.upsert(collection, item.id, item.embedding, item.metadata, item.content);
    }
  }

  async query(
    collection: string,
    embedding: number[],
    k: number,
    filter?: Record<string, unknown>
  ): Promise<VectorResult[]> {
    const query = await this.getDb();
    const vectorStr = `[${embedding.join(",")}]`;
    const table = this.collectionToTable(collection);

    let sql: string;
    let idCol: string;

    if (table === "paper_sections") {
      idCol = "section_id";
      sql = `
        SELECT section_id AS id, section_title, paper_id, content,
               1 - (embedding <=> $1::vector) AS score
        FROM paper_sections
        WHERE embedding IS NOT NULL
        ${filter?.paper_id ? "AND paper_id = $3" : ""}
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      `;
    } else if (table === "paper_chunks") {
      idCol = "chunk_id";
      sql = `
        SELECT chunk_id AS id, section_id, paper_id, content,
               1 - (embedding <=> $1::vector) AS score
        FROM paper_chunks
        WHERE embedding IS NOT NULL
        ${filter?.paper_id ? "AND paper_id = $3" : ""}
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      `;
    } else {
      idCol = "concept_id";
      sql = `
        SELECT concept_id AS id, name, category, summary,
               1 - (embedding <=> $1::vector) AS score
        FROM concepts
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      `;
    }

    const params: unknown[] = [vectorStr, k];
    if (filter?.paper_id) params.push(filter.paper_id);

    const result = await query(sql, params);

    return result.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      score: row.score as number,
      metadata: Object.fromEntries(
        Object.entries(row).filter(([key]) => key !== "id" && key !== "score" && key !== "content")
      ),
      content: row.content as string | undefined,
    }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      const query = await this.getDb();
      await query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  private collectionToTable(collection: string): string {
    const mapping: Record<string, string> = {
      paper_sections: "paper_sections",
      paper_chunks: "paper_chunks",
      concepts: "concepts",
    };
    return mapping[collection] || collection;
  }
}

// ============================================================
// Factory
// ============================================================

let cachedStore: VectorStore | null = null;

export function getVectorStore(): VectorStore {
  if (cachedStore) return cachedStore;

  const store = process.env.VECTOR_STORE || "chroma";

  switch (store) {
    case "chroma":
      cachedStore = new ChromaVectorStore();
      break;
    case "pgvector":
      cachedStore = new PgVectorStore();
      break;
    default:
      throw new Error(
        `Unknown VECTOR_STORE: "${store}". Valid options: chroma, pgvector`
      );
  }

  console.log(`Vector store initialized: ${cachedStore.name}`);
  return cachedStore;
}
