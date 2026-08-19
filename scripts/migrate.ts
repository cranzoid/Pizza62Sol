/**
 * Applies schema migrations, then the launch seed and the gated data migrations.
 *
 * This runs as the `db-migrate` Container Apps job before a new revision takes
 * traffic — never from a request handler. An advisory lock makes a concurrent
 * second run wait rather than race, which matters because a deployment can start
 * the job while a previous one is still finishing.
 *
 * Safe to run repeatedly: applied migrations are recorded, the seed inserts only
 * what is missing, and each data migration is gated by its own marker row.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PostgresDatabase, closePool, getPool } from "@/db/pg-driver";
import { runDataMigrations, seedLaunchData } from "@/db/runtime";

// Arbitrary but fixed: any process using this key contends for the same lock.
const MIGRATION_LOCK_KEY = 6_211_962;

async function applySchemaMigrations(): Promise<number> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at BIGINT NOT NULL
    )
  `);
  const directory = path.join(process.cwd(), "drizzle");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  const applied = new Set(
    (await pool.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((row) => row.name),
  );

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(directory, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // drizzle-kit separates statements with this marker rather than plain
      // semicolons, which would split function bodies and quoted text.
      for (const statement of sql.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed) await client.query(trimmed);
      }
      await client.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", [file, Date.now()]);
      await client.query("COMMIT");
      console.log(`applied ${file}`);
      count += 1;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(`migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      client.release();
    }
  }
  return count;
}

async function main(): Promise<void> {
  const pool = getPool();
  // Session-scoped, so it must be taken and released on one dedicated client.
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    const applied = await applySchemaMigrations();
    console.log(applied ? `${applied} migration(s) applied` : "schema already current");

    const database = new PostgresDatabase(pool);
    await seedLaunchData(database);
    await runDataMigrations(database);
    console.log("seed and data migrations complete");
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    lock.release();
    await closePool();
  }
}

await main();
