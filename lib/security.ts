import { ensureDatabase, getD1 } from "@/db/runtime";
import { hashOpaqueToken } from "@/lib/domain";

export async function enforceRateLimit(
  request: Request,
  scope: string,
  maxAttempts: number,
  windowMs: number,
): Promise<void> {
  await ensureDatabase();
  const identity =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local";
  const keyHash = await hashOpaqueToken(`${scope}:${identity}`);
  const now = Date.now();
  const row = await getD1()
    .prepare("SELECT window_started_at, attempts FROM rate_limits WHERE key_hash = ?")
    .bind(keyHash)
    .first<{ window_started_at: number; attempts: number }>();
  if (!row || now - row.window_started_at >= windowMs) {
    await getD1()
      .prepare(
        `INSERT INTO rate_limits (key_hash, window_started_at, attempts, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(key_hash) DO UPDATE SET window_started_at = excluded.window_started_at,
           attempts = 1, updated_at = excluded.updated_at`,
      )
      .bind(keyHash, now, now)
      .run();
    return;
  }
  if (row.attempts >= maxAttempts) {
    throw new RateLimitError();
  }
  await getD1()
    .prepare("UPDATE rate_limits SET attempts = attempts + 1, updated_at = ? WHERE key_hash = ?")
    .bind(now, keyHash)
    .run();
}

export class RateLimitError extends Error {
  readonly status = 429;
  constructor() {
    super("Too many attempts. Please wait and try again.");
  }
}
