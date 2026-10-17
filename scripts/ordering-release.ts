import { readFile, writeFile } from "node:fs/promises";
import { getPool, closePool } from "@/db/pg-driver";
import { inspectOrderingRelease, applyOrderingRelease, type OrderingReleaseSnapshot } from "@/lib/ordering-release";

const [action, file] = process.argv.slice(2);
try {
  if (!file || !["--inspect", "--apply", "--rollback"].includes(action)) throw new Error("Usage: npm run ordering:release -- --inspect|--apply|--rollback <snapshot.json>");
  if (action === "--inspect") {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const snapshot = await inspectOrderingRelease(client);
      await client.query("COMMIT");
      await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      console.log(`Captured all five delivery products, their variations, category and operations settings. ${snapshot.changes.length} proposed row changes. Review ${file} before applying.`);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  } else {
    const snapshot = JSON.parse(await readFile(file, "utf8")) as OrderingReleaseSnapshot;
    console.log(await applyOrderingRelease(getPool(), snapshot, action === "--rollback"));
  }
} finally { await closePool(); }
