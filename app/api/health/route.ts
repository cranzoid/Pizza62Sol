import { getD1 } from "@/db/runtime";

export const dynamic = "force-dynamic";

/**
 * Liveness and readiness probe for the Container App.
 *
 * Deliberately cheaper than any real route: it confirms the process is up and
 * that a pooled connection can round-trip, without touching application tables.
 * A revision that cannot reach Postgres must fail its probe rather than take
 * traffic and serve errors.
 */
export async function GET() {
  try {
    await getD1().prepare("SELECT 1").first();
    return Response.json({ status: "ok" });
  } catch (error) {
    return Response.json(
      { status: "degraded", error: error instanceof Error ? error.message : "database unreachable" },
      { status: 503 },
    );
  }
}
