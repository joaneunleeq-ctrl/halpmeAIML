// Concept Graph Seeding Runner
// Usage:
//   npm run seed-concepts -- --generate           Generate with LLM, save to data/concept_graph.json
//   npm run seed-concepts -- --load path/to/file   Load from curated JSON file
//   npm run seed-concepts                          Load from data/concept_graph.json if it exists, else generate
//
// Prerequisites:
//   - Ollama running (for --generate mode)
//   - Embedding server running (for embedding generation)
//   - Papers ingested (for paper linking)

import * as path from "path";
import { Pool } from "pg";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

async function main() {
  const {
    generateConceptsWithLLM,
    loadConceptsFromFile,
    saveConceptsToFile,
    insertConcepts,
  } = require("../src/lib/pipeline/seed-concepts");

  const { getLLMProvider } = require("../src/lib/providers/llm-provider");
  const { getEmbeddingProvider } = require("../src/lib/providers/embedding-provider");

  const args = process.argv.slice(2);
  const generateMode = args.includes("--generate");
  const loadIndex = args.indexOf("--load");
  const loadFile = loadIndex !== -1 ? args[loadIndex + 1] : null;

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const defaultJsonPath = path.join(process.cwd(), "data", "concept_graph.json");

  console.log("============================================");
  console.log("  halpmeAIML — Concept Graph Seeding");
  console.log("============================================\n");

  // Determine mode
  let concepts;

  if (loadFile) {
    // Explicit load mode
    console.log(`Mode: Load from file (${loadFile})\n`);
    concepts = loadConceptsFromFile(loadFile);
  } else if (generateMode) {
    // Explicit generate mode
    console.log("Mode: Generate with LLM\n");

    const llmProvider = getLLMProvider();
    const healthy = await llmProvider.healthCheck();
    if (!healthy) {
      console.error("LLM provider is not available.");
      console.error("Make sure Ollama is running: ollama serve");
      process.exit(1);
    }
    console.log(`LLM provider: ${llmProvider.name}\n`);

    console.log("Generating 50 concepts across 8 categories...\n");
    concepts = await generateConceptsWithLLM(
      llmProvider.complete.bind(llmProvider)
    );

    // Save for manual review
    saveConceptsToFile(concepts, defaultJsonPath);
    console.log(`\n  >>> Review and curate: ${defaultJsonPath}`);
    console.log("  >>> Then reload with: npm run seed-concepts -- --load data/concept_graph.json\n");
  } else {
    // Auto mode: load from default file if it exists, otherwise generate
    const fs = require("fs");
    if (fs.existsSync(defaultJsonPath)) {
      console.log(`Mode: Auto-load from ${defaultJsonPath}\n`);
      concepts = loadConceptsFromFile(defaultJsonPath);
    } else {
      console.log("Mode: Auto-generate (no existing concept_graph.json found)\n");

      const llmProvider = getLLMProvider();
      const healthy = await llmProvider.healthCheck();
      if (!healthy) {
        console.error("LLM provider is not available.");
        console.error("Make sure Ollama is running: ollama serve");
        process.exit(1);
      }

      concepts = await generateConceptsWithLLM(
        llmProvider.complete.bind(llmProvider)
      );
      saveConceptsToFile(concepts, defaultJsonPath);
      console.log(`\n  >>> Review: ${defaultJsonPath}\n`);
    }
  }

  if (!concepts || concepts.length === 0) {
    console.error("No concepts to seed. Exiting.");
    process.exit(1);
  }

  // Check embedding server
  let embeddingProvider = null;
  try {
    embeddingProvider = getEmbeddingProvider();
    const embHealthy = await embeddingProvider.healthCheck();
    if (embHealthy) {
      console.log(`Embedding provider: ${embeddingProvider.name} (${embeddingProvider.dimensions} dims)`);
    } else {
      console.log("Embedding provider not available — will skip embedding generation");
      embeddingProvider = null;
    }
  } catch {
    console.log("Embedding provider not available — will skip embedding generation");
  }

  // Check papers in database
  const paperCount = await pool.query("SELECT count(*) as c FROM papers");
  console.log(`Papers in database: ${paperCount.rows[0].c}`);

  // Check existing concepts
  const existingCount = await pool.query("SELECT count(*) as c FROM concepts");
  console.log(`Existing concepts: ${existingCount.rows[0].c}`);
  console.log("");

  // Insert concepts
  const startTime = Date.now();
  const result = await insertConcepts(pool, concepts, embeddingProvider);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Summary
  console.log("\n============================================");
  console.log("  Seeding Summary");
  console.log("============================================\n");
  console.log(`Concepts inserted:       ${result.concepts_inserted}`);
  console.log(`Prerequisites linked:    ${result.prerequisites_linked}`);
  console.log(`Paper links created:     ${result.papers_linked}`);
  console.log(`Embeddings generated:    ${result.embeddings_generated}`);
  console.log(`Time:                    ${elapsed}s`);

  if (result.errors.length > 0) {
    console.log(`\nWarnings (${result.errors.length}):`);
    for (const err of result.errors) {
      console.log(`  - ${err}`);
    }
  }

  // Final verification
  const finalCount = await pool.query("SELECT count(*) as c FROM concepts");
  const prereqCount = await pool.query("SELECT count(*) as c FROM concept_prerequisites");
  const paperLinkCount = await pool.query("SELECT count(*) as c FROM concept_papers");
  const embeddedCount = await pool.query(
    "SELECT count(*) as c FROM concepts WHERE embedding IS NOT NULL"
  );

  console.log(`\nDatabase state:`);
  console.log(`  Total concepts:       ${finalCount.rows[0].c}`);
  console.log(`  Prerequisite edges:   ${prereqCount.rows[0].c}`);
  console.log(`  Paper links:          ${paperLinkCount.rows[0].c}`);
  console.log(`  With embeddings:      ${embeddedCount.rows[0].c}/${finalCount.rows[0].c}`);

  // Category breakdown
  const categories = await pool.query(
    "SELECT category, count(*) as c FROM concepts GROUP BY category ORDER BY category"
  );
  console.log(`\n  By category:`);
  for (const row of categories.rows) {
    console.log(`    ${(row as { category: string }).category}: ${(row as { c: string }).c}`);
  }

  console.log("");
  await pool.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
