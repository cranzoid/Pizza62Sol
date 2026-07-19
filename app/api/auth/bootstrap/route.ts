import { createPasswordHash, createStaffSession, ownerSetupSecret } from "@/lib/auth";
import { ensureDatabase, getD1, writeAudit } from "@/db/runtime";
import { enforceRateLimit, RateLimitError } from "@/lib/security";

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "owner-bootstrap", 5, 60 * 60 * 1000);
    await ensureDatabase();
    const configuredSecret = ownerSetupSecret();
    if (!configuredSecret) {
      return Response.json(
        { error: "Owner setup is unavailable until OWNER_SETUP_SECRET is configured." },
        { status: 503 },
      );
    }
    const existing = await getD1().prepare("SELECT COUNT(*) AS count FROM staff_users").first<{ count: number }>();
    if ((existing?.count ?? 0) > 0) {
      return Response.json({ error: "Owner setup has already been completed." }, { status: 409 });
    }
    const body = (await request.json()) as {
      name?: string;
      email?: string;
      password?: string;
      setupSecret?: string;
    };
    if (body.setupSecret !== configuredSecret) {
      return Response.json({ error: "The owner setup secret is invalid." }, { status: 403 });
    }
    const email = body.email?.trim().toLowerCase() ?? "";
    const name = body.name?.trim() ?? "";
    if (!/^\S+@\S+\.\S+$/.test(email) || name.length < 2 || name.length > 80) {
      return Response.json({ error: "Enter a valid owner name and email." }, { status: 400 });
    }
    const password = await createPasswordHash(body.password ?? "");
    const id = crypto.randomUUID();
    const now = Date.now();
    await getD1()
      .prepare(
        `INSERT INTO staff_users
         (id, email, name, role, password_hash, password_salt, password_iterations,
          permissions_json, active, created_at, updated_at)
         VALUES (?, ?, ?, 'owner', ?, ?, ?, '[]', 1, ?, ?)`,
      )
      .bind(id, email, name, password.hash, password.salt, password.iterations, now, now)
      .run();
    await writeAudit({
      actorId: id,
      action: "owner.bootstrap",
      targetType: "staff_user",
      targetId: id,
      next: { email, name, role: "owner" },
    });
    const session = await createStaffSession(id);
    return Response.json(
      { user: { id, email, name, role: "owner", permissions: [] } },
      { status: 201, headers: { "set-cookie": session.cookie } },
    );
  } catch (error) {
    if (error instanceof RateLimitError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Owner setup failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
