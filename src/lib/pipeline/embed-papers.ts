// Paper Embedding Pipeline
// PRD §4.3: Embedded using sentence-transformers locally, stored in
// Chroma (local) or pgvector (production).
//
// Resumable: only processes records with NULL embeddings.
// Stores embeddings in BOTH PostgreSQL (pgvector) and the vector store (Chroma).

import { Pool } from "pg";

interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimensions: number;
}

interface VectorStore {
  upsertBatch(
    collection: string,
    items: Array<{
      id: string;
      embedding: number[];
      metadata: Record<string, unknown>;
      content?: string;
    }>
  ): Promise<void>;
}

interface SectionRow {
  section_id: string;
  paper_id: string;
  section_title: string;
  content: string;
  paper_title: string;
}

interface ChunkRow {
  chunk_id: string;
  paper_id: string;
  section_id: string;
  content: string;
  paper_title: string;
  section_title: string;
}

export interface EmbedResult {
  sections_embedded: number;
  chunks_embedded: number;
  sections_skipped: number;
  chunks_skipped: number;
  errors: string[];
  elapsed_seconds: number;
}

// ============================================================
// Embed Sections
// ============================================================

async function embedSections(
  pool: Pool,
  embeddingProvider: EmbeddingProvider,
  vectorStore: VectorStore | null
): Promise<{ embedded: number; skipped: number; errors: string[] }> {
  const BATCH_SIZE = 32;
  let embedded = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Get total count for progress tracking
  const totalResult = await pool.query(
    "SELECT count(*) as total FROM paper_sections"
  );
  const nullResult = await pool.query(
    "SELECT count(*) as total FROM paper_sections WHERE embedding IS NULL"
  );
  const total = parseInt(totalResult.rows[0].total);
  const toProcess = parseInt(nullResult.rows[0].total);
  skipped = total - toProcess;

  if (toProcess === 0) {
    console.log(`  All ${total} sections already have embeddings.`);
    return { embedded: 0, skipped, errors };
  }

  console.log(`  ${toProcess} sections to embed (${skipped} already done)`);

  // Fetch sections in batches
  let offset = 0;
  while (offset < toProcess) {
    const batchResult = await pool.query<SectionRow>(
      `SELECT s.section_id, s.paper_id, s.section_title, s.content,
              p.title AS paper_title
       FROM paper_sections s
       JOIN papers p ON p.paper_id = s.paper_id
       WHERE s.embedding IS NULL
       ORDER BY s.section_id
       LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, 0] // always offset 0 since we're updating as we go
    );

    if (batchResult.rows.length === 0) break;

    const texts = batchResult.rows.map((r) =>
      truncateForEmbedding(`${r.section_title}: ${r.content}`)
    );

    try {
      const embeddings = await embeddingProvider.embedBatch(texts);

      // Store in PostgreSQL
      for (let i = 0; i < batchResult.rows.length; i++) {
        const row = batchResult.rows[i];
        const vectorStr = `[${embeddings[i].join(",")}]`;

        await pool.query(
          "UPDATE paper_sections SET embedding = $1::vector WHERE section_id = $2",
          [vectorStr, row.section_id]
        );
      }

      // Store in Chroma vector store
      if (vectorStore) {
        await vectorStore.upsertBatch(
          "paper_sections",
          batchResult.rows.map((row, i) => ({
            id: row.section_id,
            embedding: embeddings[i],
            metadata: {
              paper_id: row.paper_id,
              paper_title: row.paper_title,
              section_title: row.section_title,
            },
            content: row.content,
          }))
        );
      }

      embedded += batchResult.rows.length;
      offset += batchResult.rows.length;

      if (embedded % 50 === 0 || embedded === toProcess) {
        console.log(`  Sections: ${embedded}/${toProcess} embedded`);
      }
    } catch (err) {
      const msg = `Section batch error at offset ${offset}: ${err}`;
      console.error(`  ✗ ${msg}`);
      errors.push(msg);
      offset += batchResult.rows.length; // skip this batch
    }
  }

  return { embedded, skipped, errors };
}

// ============================================================
// Embed Chunks
// ============================================================

async function embedChunks(
  pool: Pool,
  embeddingProvider: EmbeddingProvider,
  vectorStore: VectorStore | null
): Promise<{ embedded: number; skipped: number; errors: string[] }> {
  const BATCH_SIZE = 32;
  let embedded = 0;
  let skipped = 0;
  const errors: string[] = [];

  const totalResult = await pool.query(
    "SELECT count(*) as total FROM paper_chunks"
  );
  const nullResult = await pool.query(
    "SELECT count(*) as total FROM paper_chunks WHERE embedding IS NULL"
  );
  const total = parseInt(totalResult.rows[0].total);
  const toProcess = parseInt(nullResult.rows[0].total);
  skipped = total - toProcess;

  if (toProcess === 0) {
    console.log(`  All ${total} chunks already have embeddings.`);
    return { embedded: 0, skipped, errors };
  }

  console.log(`  ${toProcess} chunks to embed (${skipped} already done)`);

  while (true) {
    const batchResult = await pool.query<ChunkRow>(
      `SELECT c.chunk_id, c.paper_id, c.section_id, c.content,
              p.title AS paper_title,
              s.section_title
       FROM paper_chunks c
       JOIN papers p ON p.paper_id = c.paper_id
       JOIN paper_sections s ON s.section_id = c.section_id
       WHERE c.embedding IS NULL
       ORDER BY c.chunk_id
       LIMIT $1`,
      [BATCH_SIZE]
    );

    if (batchResult.rows.length === 0) break;

    const texts = batchResult.rows.map((r) =>
      truncateForEmbedding(r.content)
    );

    try {
      const embeddings = await embeddingProvider.embedBatch(texts);

      // Store in PostgreSQL
      for (let i = 0; i < batchResult.rows.length; i++) {
        const row = batchResult.rows[i];
        const vectorStr = `[${embeddings[i].join(",")}]`;

        await pool.query(
          "UPDATE paper_chunks SET embedding = $1::vector WHERE chunk_id = $2",
          [vectorStr, row.chunk_id]
        );
      }

      // Store in Chroma vector store
      if (vectorStore) {
        await vectorStore.upsertBatch(
          "paper_chunks",
          batchResult.rows.map((row, i) => ({
            id: row.chunk_id,
            embedding: embeddings[i],
            metadata: {
              paper_id: row.paper_id,
              section_id: row.section_id,
              paper_title: row.paper_title,
              section_title: row.section_title,
            },
            content: row.content,
          }))
        );
      }

      embedded += batchResult.rows.length;

      if (embedded % 100 === 0 || embedded + skipped === total) {
        console.log(`  Chunks: ${embedded}/${toProcess} embedded`);
      }
    } catch (err) {
      const msg = `Chunk batch error: ${err}`;
      console.error(`  ✗ ${msg}`);
      errors.push(msg);
      // Mark these chunks so we don't infinite-loop on persistent errors
      for (const row of batchResult.rows) {
        // Set a zero vector to skip on next run — better than looping forever
        const zeroVec = `[${new Array(embeddingProvider.dimensions).fill(0).join(",")}]`;
        await pool.query(
          "UPDATE paper_chunks SET embedding = $1::vector WHERE chunk_id = $2",
          [zeroVec, row.chunk_id]
        );
      }
    }
  }

  return { embedded, skipped, errors };
}

// ============================================================
// Utility: truncate text to fit embedding model context
// ============================================================

function truncateForEmbedding(text: string, maxChars: number = 8000): string {
  // all-mpnet-base-v2 has a 384 token limit but we truncate by chars as a proxy
  // Most academic text: ~5 chars per token, so 8000 chars ≈ 1600 tokens
  // The model internally truncates, but sending less is faster
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

// ============================================================
// Main Orchestrator
// ============================================================

export async function embedAllPapers(options: {
  pool: Pool;
  embeddingProvider: EmbeddingProvider;
  vectorStore: VectorStore | null;
}): Promise<EmbedResult> {
  const { pool, embeddingProvider, vectorStore } = options;
  const startTime = Date.now();
  const allErrors: string[] = [];

  console.log("\n--- Embedding Paper Sections ---");
  const sectionResult = await embedSections(pool, embeddingProvider, vectorStore);
  allErrors.push(...sectionResult.errors);

  console.log("\n--- Embedding Paper Chunks ---");
  const chunkResult = await embedChunks(pool, embeddingProvider, vectorStore);
  allErrors.push(...chunkResult.errors);

  const elapsed = (Date.now() - startTime) / 1000;

  return {
    sections_embedded: sectionResult.embedded,
    chunks_embedded: chunkResult.embedded,
    sections_skipped: sectionResult.skipped,
    chunks_skipped: chunkResult.skipped,
    errors: allErrors,
    elapsed_seconds: Math.round(elapsed),
  };
}
