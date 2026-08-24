/**
 * Conformance suite for the Postgres driver.
 *
 * The application reads `meta.changes` to decide whether it won a race — an
 * order is created, or a clock punch is recorded, only when the count says the
 * write landed. If the driver's notion of "changes" drifts from D1's, those
 * guards fail silently and duplicate orders or corrupt time records result. Each
 * test below pins one behaviour the application actually depends on.
 *
 * Requires a reachable Postgres. Set PG* / DATABASE_URL, or run against the
 * local default of postgres://localhost:5432/pizza62_test. Skipped when the
 * database cannot be reached so the default `npm test` stays hermetic.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { PostgresDatabase, getPool, closePool, toPositionalParameters } = await import("@/db/pg-driver");

// The probe runs at module load, not in a `before` hook: node:test evaluates a
// test's `skip` option when the test is registered, so a flag set later would
// arrive too late and every case would skip.
const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const database: D1Database = new PostgresDatabase(getPool());

if (reachable) {
  await getPool().query(`
    DROP TABLE IF EXISTS conformance_keys, conformance_state, conformance_log, conformance_sequence;
    CREATE TABLE conformance_keys (
      key_hash TEXT PRIMARY KEY NOT NULL,
      resource_id TEXT,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE conformance_state (
      staff_user_id TEXT PRIMARY KEY NOT NULL,
      state TEXT NOT NULL,
      transition_id TEXT
    );
    CREATE TABLE conformance_log (
      id TEXT PRIMARY KEY NOT NULL,
      staff_user_id TEXT NOT NULL,
      action TEXT NOT NULL
    );
  `);
}

after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

// The reservation in createOrder treats "0 rows changed" as proof that another
// request already owns this checkout. If a conflicting insert reported 1, every
// duplicate submission would create a second order.
withDb("reports zero changes when ON CONFLICT DO NOTHING skips the insert", async () => {
  const insert = () =>
    database
      .prepare(
        "INSERT INTO conformance_keys (key_hash, created_at) VALUES (?, ?) ON CONFLICT(key_hash) DO NOTHING",
      )
      .bind("idem-1", Date.now())
      .run();

  const first = await insert();
  assert.equal(first.meta.changes, 1, "the winning insert must report one change");

  const second = await insert();
  assert.equal(second.meta.changes, 0, "a conflicting insert must report zero changes");
});

// D1 reports no changes for a read. Postgres' rowCount counts rows returned, so
// mapping it blindly would make a SELECT look like a successful mutation.
withDb("reports zero changes for a SELECT", async () => {
  await database
    .prepare("INSERT INTO conformance_keys (key_hash, created_at) VALUES (?, ?) ON CONFLICT(key_hash) DO NOTHING")
    .bind("idem-select", Date.now())
    .run();
  const read = await database.prepare("SELECT key_hash FROM conformance_keys").all();
  assert.ok(read.results.length > 0, "rows should come back");
  assert.equal(read.meta.changes, 0, "a read must never report changes");
});

// timeclock-punch destructures the first element of the batch result and reads
// only its change count, so results must be per statement and in order.
withDb("returns one result per batched statement, in order", async () => {
  const results = await database.batch([
    database
      .prepare("INSERT INTO conformance_state (staff_user_id, state) VALUES (?, 'clocked_out') ON CONFLICT(staff_user_id) DO NOTHING")
      .bind("staff-order"),
    database.prepare("SELECT staff_user_id FROM conformance_state WHERE staff_user_id = ?").bind("staff-order"),
    database.prepare("UPDATE conformance_state SET state = 'working' WHERE staff_user_id = ?").bind("staff-order"),
  ]);
  assert.equal(results.length, 3, "one result per statement");
  assert.equal(results[0].meta.changes, 1, "the insert reports its own change count");
  assert.equal(results[1].meta.changes, 0, "the select reports none");
  assert.equal(results[2].meta.changes, 1, "the update reports its own");
});

// The clock punch writes its guard row and then inserts the matching event with
// INSERT..SELECT against that same row. If batch statements ran on different
// pooled connections the SELECT would see nothing and the event would vanish.
withDb("a batched statement sees a row written earlier in the same batch", async () => {
  await database
    .prepare("INSERT INTO conformance_state (staff_user_id, state) VALUES (?, 'clocked_out') ON CONFLICT(staff_user_id) DO NOTHING")
    .bind("staff-cas")
    .run();

  const transitionId = "transition-1";
  const [swap] = await database.batch([
    database
      .prepare("UPDATE conformance_state SET state = 'working', transition_id = ? WHERE staff_user_id = ? AND state = 'clocked_out'")
      .bind(transitionId, "staff-cas"),
    database
      .prepare(
        `INSERT INTO conformance_log (id, staff_user_id, action)
         SELECT ?, staff_user_id, 'clock_in' FROM conformance_state
         WHERE staff_user_id = ? AND transition_id = ?`,
      )
      .bind("event-1", "staff-cas", transitionId),
  ]);

  assert.equal(swap.meta.changes, 1, "the compare-and-swap must win exactly once");
  const logged = await database.prepare("SELECT id FROM conformance_log WHERE id = ?").bind("event-1").first();
  assert.ok(logged, "the event insert must see the row the swap just wrote");
});

// A losing racer must write nothing at all, rather than leaving the guard row
// ahead of the event log.
withDb("a losing compare-and-swap writes neither the state nor the event", async () => {
  await database
    .prepare("INSERT INTO conformance_state (staff_user_id, state) VALUES (?, 'working') ON CONFLICT(staff_user_id) DO UPDATE SET state = 'working'")
    .bind("staff-loser")
    .run();

  const [swap] = await database.batch([
    database
      .prepare("UPDATE conformance_state SET state = 'working', transition_id = ? WHERE staff_user_id = ? AND state = 'clocked_out'")
      .bind("transition-losing", "staff-loser"),
    database
      .prepare(
        `INSERT INTO conformance_log (id, staff_user_id, action)
         SELECT ?, staff_user_id, 'clock_in' FROM conformance_state
         WHERE staff_user_id = ? AND transition_id = ?`,
      )
      .bind("event-losing", "staff-loser", "transition-losing"),
  ]);

  assert.equal(swap.meta.changes, 0, "the swap must not match a row already working");
  const logged = await database.prepare("SELECT id FROM conformance_log WHERE id = ?").bind("event-losing").first();
  assert.equal(logged, null, "no event may be written when the swap lost");
});

// createOrder writes the order, payment, event, outbox row and item rows as one
// batch. D1 made that implicitly atomic; a real transaction must roll all of it
// back rather than leave a half-written order.
withDb("rolls the whole batch back when one statement fails", async () => {
  await assert.rejects(
    database.batch([
      database.prepare("INSERT INTO conformance_keys (key_hash, created_at) VALUES (?, ?)").bind("rollback-key", Date.now()),
      database.prepare("INSERT INTO conformance_keys (key_hash, created_at) VALUES (?, ?)").bind("rollback-key", Date.now()),
    ]),
  );
  const survivor = await database.prepare("SELECT key_hash FROM conformance_keys WHERE key_hash = ?").bind("rollback-key").first();
  assert.equal(survivor, null, "the first insert must not survive the failed batch");
});

// Timestamps are epoch milliseconds in BIGINT columns. node-postgres returns
// int8 as a string by default, which would turn every date arithmetic and every
// COALESCE(SUM(...)) in the analytics routes into string concatenation.
withDb("returns bigint columns as numbers, not strings", async () => {
  const createdAt = Date.now();
  await database
    .prepare("INSERT INTO conformance_keys (key_hash, created_at) VALUES (?, ?) ON CONFLICT(key_hash) DO NOTHING")
    .bind("bigint-key", createdAt)
    .run();
  const row = await database
    .prepare("SELECT created_at, COALESCE(SUM(created_at), 0) AS total FROM conformance_keys WHERE key_hash = ? GROUP BY created_at")
    .bind("bigint-key")
    .first<{ created_at: number; total: number }>();
  assert.equal(typeof row?.created_at, "number", "epoch-ms must arrive as a number");
  assert.equal(row?.created_at, createdAt);
  assert.equal(typeof row?.total, "number", "aggregates must arrive as numbers");
});

// Call sites are typed `T | null` and several use optional chaining, which would
// misread undefined.
withDb("first() yields null for no match", async () => {
  const missing = await database.prepare("SELECT key_hash FROM conformance_keys WHERE key_hash = ?").bind("absent").first();
  assert.equal(missing, null);
});

// The order-number generator reads its new value straight out of the UPDATE.
withDb("reads a RETURNING value through first()", async () => {
  await getPool().query("CREATE TABLE IF NOT EXISTS conformance_sequence (key TEXT PRIMARY KEY, current_number INTEGER NOT NULL)");
  await getPool().query("INSERT INTO conformance_sequence VALUES ('public_order', 1000) ON CONFLICT (key) DO NOTHING");
  const next = await database
    .prepare("UPDATE conformance_sequence SET current_number = current_number + 1 WHERE key = 'public_order' RETURNING current_number")
    .first<{ current_number: number }>();
  assert.equal(next?.current_number, 1001);
});

// Three routes build `IN (?,?,?)` lists at runtime; the markers must number
// straight through the rest of the statement.
withDb("binds a dynamically built IN list", async () => {
  const keys = ["in-a", "in-b", "in-c"];
  for (const key of keys) {
    await database
      .prepare("INSERT INTO conformance_keys (key_hash, created_at) VALUES (?, ?) ON CONFLICT(key_hash) DO NOTHING")
      .bind(key, Date.now())
      .run();
  }
  const found = await database
    .prepare(`SELECT key_hash FROM conformance_keys WHERE key_hash IN (${keys.map(() => "?").join(",")}) AND created_at > ?`)
    .bind(...keys, 0)
    .all();
  assert.equal(found.results.length, 3);
});

test("rewrites positional markers without touching quoted text", () => {
  assert.equal(toPositionalParameters("SELECT * FROM t WHERE a = ? AND b = ?"), "SELECT * FROM t WHERE a = $1 AND b = $2");
  assert.equal(
    toPositionalParameters("SELECT * FROM t WHERE note = 'why? because' AND a = ?"),
    "SELECT * FROM t WHERE note = 'why? because' AND a = $1",
    "a question mark inside a literal is not a parameter",
  );
  assert.equal(
    toPositionalParameters("SELECT * FROM t WHERE a = ? -- trailing ? comment\n AND b = ?"),
    "SELECT * FROM t WHERE a = $1 -- trailing ? comment\n AND b = $2",
    "a question mark inside a comment is not a parameter",
  );
  assert.equal(
    toPositionalParameters("INSERT INTO t (a) VALUES (?) ON CONFLICT(a) DO UPDATE SET a = excluded.a"),
    "INSERT INTO t (a) VALUES ($1) ON CONFLICT(a) DO UPDATE SET a = excluded.a",
  );
});
