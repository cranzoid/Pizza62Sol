/**
 * The database and object-storage interfaces the application codes against.
 *
 * These shapes originated as a minimal subset of Cloudflare's D1 and R2
 * bindings. They are kept verbatim through the move to Azure so the 169 raw SQL
 * statements and their ~120 call sites did not have to change: `db/pg-driver.ts`
 * implements them over Postgres and `lib/blob-store.ts` over Azure Blob Storage.
 * The names are historical; nothing Cloudflare-specific remains behind them.
 */
interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes: number; [key: string]: unknown };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}


interface R2ObjectBody {
  body: ReadableStream;
  httpMetadata?: { contentType?: string };
  size: number;
}

interface R2Bucket {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<void>;
}

