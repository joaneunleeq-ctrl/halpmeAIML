// Paper Embedding Runner
// Usage:
//   npm run embed-papers
//
// Prerequisites:
//   1. Embedding server running: bash scripts/start-embedding-server.sh
//   2. Papers ingested: npm run ingest-papers
//   3. (Optional) Chroma running for local vector store

import { Pool } from "pg";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

async function main() {
  const { embedAllPapers } = require("../src/lib/pipeline/embed-papers");
  const { getEmbeddingProvider } = require("../src/lib/providers/embedding-provider");
  const { getVectorStore } = require("../src/lib/providers/vector-store");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  console.log("============================================");
  console.log("  halpmeAIML — Paper Embedding Pipeline");
  console.log("============================================\n");

  // Initialize embedding provider
  let embeddingProvider;
  try {
    embeddingProvider = getEmbeddingProvider();
    const healthy = await embeddingProvider.healthCheck();
    if (!healthy) {
      console.error("✗ Embedding provider is not healthy.");
      console.error("  Make sure the embedding server is running:");
      console.error("  bash scripts/start-embedding-server.sh");
      process.exit(1);
    }
    console.log(`✓ Embedding provider: ${embeddingProvider.name} (${embeddingProvider.dimensions} dims)`);
  } catch (err) {
    console.error("✗ Failed to initialize embedding provider:", err);
    console.error("  Make sure the embedding server is running:");
    console.error("  bash scripts/start-embedding-server.sh");
    process.exit(1);
  }

  // Initialize vector store (optional — skip if Chroma isn't running)
  let vectorStore = null;
  try {
    vectorStore = getVectorStore();
    const vsHealthy = await vectorStore.healthCheck();
    if (vsHealthy) {
      console.log(`✓ Vector store: ${vectorStore.name}`);
    } else {
      console.log(`⚠ Vector store (${vectorStore.name}) not available — will store in PostgreSQL only`);
      vectorStore = null;
    }
  } catch {
    console.log("⚠ Vector store not available — will store in PostgreSQL only");
    vectorStore = null;
  }

  // Check database
  try {
    const paperCount = await pool.query("SELECT count(*) as c FROM papers");
    const count = parseInt(paperCount.rows[0].c);
    if (count === 0) {
      console.error("\n✗ No papers in database. Run ingestion first:");
      console.error("  npm run ingest-papers");
      process.exit(1);
    }
    console.log(`✓ Database: ${count} papers found`);
  } catch (err) {
    console.error("✗ Database connection failed:", err);
    process.exit(1);
  }

  console.log("");

  // Run embedding
  const result = await embedAllPapers({
    pool,
    embeddingProvider,
    vectorStore,
  });

  // Summary
  console.log("\n============================================");
  console.log("  Embedding Summary");
  console.log("============================================\n");
  console.log(`Sections embedded:  ${result.sections_embedded} (${result.sections_skipped} already done)`);
  console.log(`Chunks embedded:    ${result.chunks_embedded} (${result.chunks_skipped} already done)`);
  console.log(`Time:               ${result.elapsed_seconds}s`);

  if (result.errors.length > 0) {
    console.log(`\nErrors (${result.errors.length}):`);
    for (const err of result.errors) {
      console.log(`  ✗ ${err}`);
    }
  }

  // Verify
  const sectionCheck = await pool.query(
    "SELECT count(*) as total, count(embedding) as with_emb FROM paper_sections"
  );
  const chunkCheck = await pool.query(
    "SELECT count(*) as total, count(embedding) as with_emb FROM paper_chunks"
  );
  console.log(`\nVerification:`);
  console.log(`  Sections: ${sectionCheck.rows[0].with_emb}/${sectionCheck.rows[0].total} have embeddings`);
  console.log(`  Chunks:   ${chunkCheck.rows[0].with_emb}/${chunkCheck.rows[0].total} have embeddings`);

  console.log("");
  await pool.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
