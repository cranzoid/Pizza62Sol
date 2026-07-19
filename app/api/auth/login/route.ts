import { createStaffSession, verifyPassword } from "@/lib/auth";
import { ensureDatabase, getD1 } from "@/db/runtime";
import { enforceRateLimit, RateLimitError } from "@/lib/security";

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "staff-login", 10, 15 * 60 * 1000);
    await ensureDatabase();
    const body = (await request.json()) as { email?: string; password?: string };
    const email = body.email?.trim().toLowerCase() ?? "";
    const row = await getD1()
      .prepare(
        `SELECT id, email, name, role, password_hash, password_salt, password_iterations,
                permissions_json, active
         FROM staff_users WHERE email = ?`,
      )
      .bind(email)
      .first<{
        id: string;
        email: string;
        name: string;
        role: "owner" | "manager" | "employee";
        password_hash: string;
        password_salt: string;
        password_iterations: number;
        permissions_json: string;
        active: number;
      }>();
    const valid =
      row?.active === 1 &&
      (await verifyPassword(
        body.password ?? "",
        row.password_hash,
        row.password_salt,
        row.password_iterations,
      ));
    if (!valid || !row) {
      return Response.json({ error: "The email or password is incorrect." }, { status: 401 });
    }
    await getD1().prepare("UPDATE staff_users SET last_login_at = ?, updated_at = ? WHERE id = ?").bind(
      Date.now(),
      Date.now(),
      row.id,
    ).run();
    const session = await createStaffSession(row.id);
    return Response.json(
      {
        user: {
          id: row.id,
          email: row.email,
          name: row.name,
          role: row.role,
          permissions: JSON.parse(row.permissions_json),
        },
      },
      { headers: { "set-cookie": session.cookie } },
    );
  } catch (error) {
    if (error instanceof RateLimitError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "Sign-in is temporarily unavailable." }, { status: 500 });
  }
}
