// Paper Ingestion Runner
// Usage:
//   npm run ingest-papers
//   npm run ingest-papers -- --skip-download     (use already-downloaded PDFs)
//   npm run ingest-papers -- --grobid-url http://localhost:8070

import * as path from "path";
import { Pool } from "pg";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

async function main() {
  const { ingestAllPapers, CANONICAL_PAPERS } = require(
    "../src/lib/pipeline/ingest-papers"
  );

  const args = process.argv.slice(2);
  const skipDownload = args.includes("--skip-download");
  const grobidUrlArg = args.find((a) => a.startsWith("--grobid-url="));
  const grobidUrl = grobidUrlArg
    ? grobidUrlArg.split("=")[1]
    : "http://localhost:8070";

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const papersDir = path.join(process.cwd(), "papers");

  console.log("============================================");
  console.log("  halpmeAIML — Paper Ingestion Pipeline");
  console.log("============================================\n");
  console.log(`Papers directory: ${papersDir}`);
  console.log(`GROBID URL:       ${grobidUrl}`);
  console.log(`Skip download:    ${skipDownload}`);
  console.log(`Total papers:     ${CANONICAL_PAPERS.length}`);
  console.log("");

  const startTime = Date.now();

  const results = await ingestAllPapers({
    pool,
    papersDir,
    grobidUrl,
    skipDownload,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Summary report
  console.log("\n============================================");
  console.log("  Ingestion Summary");
  console.log("============================================\n");

  const ingested = results.filter((r: { status: string }) => r.status === "ingested");
  const skipped = results.filter((r: { status: string }) => r.status === "skipped");
  const errors = results.filter((r: { status: string }) => r.status === "error");

  console.log(`Ingested:  ${ingested.length} papers`);
  console.log(`Skipped:   ${skipped.length} papers (already in DB)`);
  console.log(`Errors:    ${errors.length} papers`);
  console.log(`Time:      ${elapsed}s`);

  if (ingested.length > 0) {
    const totalSections = ingested.reduce(
      (sum: number, r: { sections_count: number }) => sum + r.sections_count, 0
    );
    const totalChunks = ingested.reduce(
      (sum: number, r: { chunks_count: number }) => sum + r.chunks_count, 0
    );
    const grobidCount = ingested.filter(
      (r: { parse_method: string }) => r.parse_method === "grobid"
    ).length;
    const pdfParseCount = ingested.filter(
      (r: { parse_method: string }) => r.parse_method === "pdf-parse"
    ).length;

    console.log(`\nTotal sections:  ${totalSections}`);
    console.log(`Total chunks:    ${totalChunks}`);
    console.log(`Parsed via GROBID:    ${grobidCount}`);
    console.log(`Parsed via pdf-parse: ${pdfParseCount}`);
  }

  if (errors.length > 0) {
    console.log("\nErrors:");
    for (const err of errors) {
      console.log(
        `  ✗ ${(err as { paper_title: string }).paper_title}: ${(err as { error: string }).error}`
      );
    }

    // Check for manual PDF papers
    const manualPapers = errors.filter(
      (r: { error?: string }) => r.error === "PDF not available"
    );
    if (manualPapers.length > 0) {
      console.log("\n⚠ Some papers require manual PDF placement:");
      console.log("  The Dropout, Backprop, and LSTM papers aren't freely");
      console.log("  downloadable. Place their PDFs in the papers/ directory:");
      console.log(`    ${papersDir}/rumelhart1986.pdf`);
      console.log(`    ${papersDir}/hochreiter1997.pdf`);
      console.log(`    ${papersDir}/srivastava14a.pdf  (Dropout)`);
      console.log("  Then re-run: npm run ingest-papers");
    }
  }

  console.log("");
  await pool.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
