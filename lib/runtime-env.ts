/**
 * Runtime bindings, replacing Cloudflare's `cloudflare:workers` `env` object.
 *
 * On Workers, `env` carried both service bindings (D1, R2) and secrets. Node has
 * neither, so this module reassembles the same object: `DB` and `UPLOADS` are
 * lazily-constructed clients, and every other key falls through to
 * `process.env`. Keeping the shape identical means the modules that used to
 * import from `cloudflare:workers` only changed their import path — including
 * the `(env as unknown as Record<string, string | undefined>).SECRET` casts,
 * which still resolve.
 *
 * Bindings are resolved on access rather than at import, so loading this module
 * never opens a connection. The build, the tests, and any route that touches
 * only secrets all work without a reachable database.
 */
import { getPostgresDatabase } from "@/db/pg-driver";
import { blobBucket } from "@/lib/blob-store";

type RuntimeEnv = {
  DB: D1Database;
  UPLOADS: R2Bucket;
  OWNER_SETUP_SECRET?: string;
  CLOVER_MERCHANT_ID?: string;
  CLOVER_API_TOKEN?: string;
  CLOVER_WEBHOOK_SECRET?: string;
  CLOVER_ENVIRONMENT?: string;
  EMAIL_PROVIDER?: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  [key: string]: unknown;
};

export const env: RuntimeEnv = new Proxy({} as RuntimeEnv, {
  get(_target, property) {
    if (typeof property !== "string") return undefined;
    if (property === "DB") return getPostgresDatabase();
    if (property === "UPLOADS") return blobBucket;
    return process.env[property];
  },
  has(_target, property) {
    return typeof property === "string"
      ? property === "DB" || property === "UPLOADS" || property in process.env
      : false;
  },
});
