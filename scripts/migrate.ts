import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const result = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations ORDER BY id"
  );
  return new Set(result.rows.map((r) => r.filename));
}

async function getMigrationFiles(): Promise<string[]> {
  const migrationsDir = path.join(process.cwd(), "migrations");
  if (!fs.existsSync(migrationsDir)) {
    console.error("No migrations/ directory found");
    process.exit(1);
  }
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files;
}

async function runMigration(filename: string): Promise<void> {
  const filepath = path.join(process.cwd(), "migrations", filename);
  const sql = fs.readFileSync(filepath, "utf-8");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (filename) VALUES ($1)",
      [filename]
    );
    await client.query("COMMIT");
    console.log(`  ✓ Applied: ${filename}`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`  ✗ Failed: ${filename}`);
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  console.log("halpmeAIML Migration Runner");
  console.log("==========================\n");

  try {
    await ensureMigrationsTable();

    const applied = await getAppliedMigrations();
    const files = await getMigrationFiles();

    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log("All migrations are up to date.\n");
      console.log(`Applied migrations: ${applied.size}`);
      return;
    }

    console.log(`Found ${pending.length} pending migration(s):\n`);

    for (const file of pending) {
      await runMigration(file);
    }

    console.log(`\nDone. ${pending.length} migration(s) applied.`);
    console.log(`Total migrations: ${applied.size + pending.length}`);
  } catch (error) {
    console.error("\nMigration failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
