import { getStaffIdentity } from "@/lib/auth";

export async function GET(request: Request) {
  const user = await getStaffIdentity(request);
  return user
    ? Response.json({ user })
    : Response.json({ error: "Sign in is required" }, { status: 401 });
}
