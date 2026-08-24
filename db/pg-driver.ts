/**
 * Postgres driver that presents the same surface as the Cloudflare D1 binding.
 *
 * The application talks to its database through a deliberately small interface
 * (see `types/cloudflare.d.ts`): `prepare`/`batch` on the database, and
 * `bind`/`first`/`all`/`run` on a statement. Re-implementing that interface over
 * Postgres keeps all ~120 `getD1()` call sites and the 169 SQL statements they
 * issue exactly as they are, so the port carries no rewrite risk in the query
 * layer. Only genuinely SQLite-specific SQL is edited, and that is done in place.
 *
 * The behaviours below are load-bearing — the order-creation idempotency guard
 * and the time-clock compare-and-swap both read `meta.changes` to decide whether
 * they won a race. `tests/pg-driver.test.ts` asserts each of them against a real
 * Postgres, because a silent divergence here corrupts data rather than erroring.
 */
// `pg` is CommonJS, so values come off the default export while the types are
// imported separately — a named value import does not resolve under Node's
// type-stripping ESM loader, which is how the test suite runs.
import pg from "pg";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

// D1 hands back JavaScript numbers. node-postgres defaults to strings for int8
// and numeric to protect precision it cannot know is unneeded — here it is:
// timestamps are epoch-milliseconds (~1.7e12) and money is integer cents, both
// far below Number.MAX_SAFE_INTEGER (9.007e15). Without these parsers every
// `COALESCE(SUM(...))` in the analytics routes returns a string and the
// arithmetic silently concatenates instead of adding.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => (value === null ? null : Number(value)));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => (value === null ? null : Number(value)));

/**
 * Rewrites SQLite's positional `?` markers into Postgres' numbered `$n` form.
 *
 * Quoted text and comments are skipped so a literal question mark inside a
 * string is never mistaken for a parameter. No statement in the codebase relies
 * on that today, but the three `IN (${ids.map(() => "?").join(",")})` builders
 * generate their markers dynamically, and a future one could easily include a
 * literal.
 */
export function toPositionalParameters(sql: string): string {
  let out = "";
  let parameter = 0;
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (character === "'" || character === '"') {
      // Copy the whole quoted run, honouring SQL's doubled-quote escape.
      const quote = character;
      out += character;
      index += 1;
      while (index < sql.length) {
        out += sql[index];
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            out += sql[index + 1];
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") {
        out += sql[index];
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) {
        out += sql[index];
        index += 1;
      }
      out += sql.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === "?") {
      parameter += 1;
      out += `$${parameter}`;
      index += 1;
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

/**
 * D1 reports `meta.changes` as rows written. Postgres reports `rowCount` as rows
 * *affected*, which for a SELECT is the number of rows returned — so mapping it
 * blindly would make a `SELECT` look like it mutated something. Only the three
 * mutating commands carry a change count through.
 */
function toD1Result<T>(result: QueryResult<QueryResultRow>): D1Result<T> {
  const mutating =
    result.command === "INSERT" || result.command === "UPDATE" || result.command === "DELETE";
  return {
    results: result.rows as T[],
    success: true,
    meta: { changes: mutating ? result.rowCount ?? 0 : 0 },
  };
}

class PostgresStatement implements D1PreparedStatement {
  // Written as explicit fields rather than constructor parameter properties:
  // the test runner strips types rather than compiling them, and parameter
  // properties are the one TypeScript feature that cannot be stripped.
  readonly #pool: Pool;
  readonly #text: string;
  readonly #values: unknown[];

  constructor(pool: Pool, text: string, values: unknown[] = []) {
    this.#pool = pool;
    this.#text = text;
    this.#values = values;
  }

  /** D1's `bind` yields a new bound statement; keeping it immutable means a
   *  prepared statement can safely be bound more than once. */
  bind(...values: unknown[]): D1PreparedStatement {
    return new PostgresStatement(this.#pool, this.#text, values);
  }

  /** Returns `null`, never `undefined` — call sites are typed `T | null` and
   *  several use optional chaining that would misread `undefined`. */
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const result = await this.execute();
    return (result.rows[0] as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return toD1Result<T>(await this.execute());
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return toD1Result<T>(await this.execute());
  }

  /**
   * Passing the SQL text as a plain string uses the unnamed portal. Named
   * prepared statements are deliberately avoided: the same name bound to
   * different SQL is an error, and statement text here is generated dynamically
   * in thirteen places.
   *
   * `client` is supplied by `batch` so every statement in a transaction runs on
   * the one connection — without that, a statement could not see a row an
   * earlier statement in the same batch had just written.
   */
  execute(client?: PoolClient): Promise<QueryResult<QueryResultRow>> {
    return (client ?? this.#pool).query(toPositionalParameters(this.#text), this.#values);
  }
}

export class PostgresDatabase implements D1Database {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  prepare(query: string): D1PreparedStatement {
    return new PostgresStatement(this.#pool, query);
  }

  /**
   * D1 batches are implicitly transactional. A real `BEGIN`/`COMMIT` is strictly
   * stronger, and gives the codebase actual atomicity it never had — the order
   * write in `createOrder` spans five-plus statements that must all land or none.
   *
   * Results are returned per statement, in order: `lib/timeclock-punch.ts`
   * destructures the first element to read the compare-and-swap's change count.
   */
  async batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        results.push(toD1Result<T>(await (statement as PostgresStatement).execute(client)));
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

let pool: Pool | null = null;

function connectionSettings() {
  const url = process.env.DATABASE_URL;
  // Azure Database for PostgreSQL requires TLS. `rejectUnauthorized` stays off
  // only for local Docker, which presents a self-signed certificate.
  const ssl =
    process.env.PGSSLMODE === "disable"
      ? false
      : { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false" };
  if (url) return { connectionString: url, ssl };
  return {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    ssl,
  };
}

/**
 * One pool per process. Container Apps runs several replicas, so the per-replica
 * ceiling multiplies — keep `PGPOOL_MAX` low enough that replicas × max stays
 * under the server's connection limit, which is modest on smaller Flexible
 * Server tiers.
 */
export function getPool(): Pool {
  if (!pool) {
    pool = new pg.Pool({
      ...connectionSettings(),
      max: Number(process.env.PGPOOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // Without a listener an idle-client error is an unhandled 'error' event,
    // which terminates the process.
    pool.on("error", (error) => {
      console.error("Postgres idle client error", error);
    });
  }
  return pool;
}

let database: PostgresDatabase | null = null;

export function getPostgresDatabase(): D1Database {
  database ??= new PostgresDatabase(getPool());
  return database;
}

/** Releases the pool. Used by the scheduled jobs and by tests. */
export async function closePool(): Promise<void> {
  if (pool) {
    const closing = pool;
    pool = null;
    database = null;
    await closing.end();
  }
}
