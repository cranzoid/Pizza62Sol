import { expiredStaffCookie, revokeStaffSession } from "@/lib/auth";

export async function POST(request: Request) {
  await revokeStaffSession(request);
  return Response.json({ ok: true }, { headers: { "set-cookie": expiredStaffCookie() } });
}
