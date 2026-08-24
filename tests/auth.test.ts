/**
 * Staff authentication, through the real route handlers (R1.6).
 *
 * Everything behind `/staff`, `/admin` and `/kitchen` — the order queue, the
 * menu, refunds, timesheets, the audit log — is guarded by exactly one thing:
 * the session cookie this code issues and the permission check it feeds. Until
 * now none of it was exercised by a test.
 *
 * The assertions are therefore mostly about denial. Confirming that a correct
 * password signs in is table stakes; what actually matters is that a wrong one
 * does not, that a revoked or expired session stops working immediately rather
 * than at the next natural expiry, that an inactive account cannot be used, and
 * that an employee cannot reach an owner's actions by asking nicely.
 *
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";
process.env.TRUST_PROXY_HEADERS = "true";

const { getPool, closePool } = await import("@/db/pg-driver");
const { POST: loginRoute } = await import("@/app/api/auth/login/route");
const { POST: logoutRoute } = await import("@/app/api/auth/logout/route");
const { GET: meRoute } = await import("@/app/api/auth/me/route");
const { POST: bootstrapRoute } = await import("@/app/api/auth/bootstrap/route");
const { createPasswordHash, requireStaff, getStaffIdentity, AuthError } = await import("@/lib/auth");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

let addressCounter = 0;
// The limiter treats the client identity as an opaque string, and the budgets it
// enforces outlive a test run — owner-bootstrap allows only 5 per *hour*. A
// counter that restarts at the same value every run would therefore share one
// budget across runs and start failing on the second or third `npm test` of the
// hour. Seeding it per run keeps each run in its own buckets.
const RUN = crypto.randomUUID().slice(0, 8);
const nextClientIp = () => `192.0.2.${(addressCounter += 1) % 250}-${RUN}`;

// Satisfies validatePassword(): upper-case, lower-case and numeric characters.
const PASSWORD = "Correct Horse Battery Staple 62";

/** Creates a staff user directly, so tests do not depend on one already existing. */
async function makeStaff(options: {
  role: "owner" | "manager" | "employee";
  permissions?: string[];
  active?: boolean;
}): Promise<{ id: string; email: string }> {
  const id = crypto.randomUUID();
  const email = `test-${id}@example.test`;
  const hash = await createPasswordHash(PASSWORD);
  const now = Date.now();
  await getPool().query(
    `INSERT INTO staff_users
     (id, email, name, role, password_hash, password_salt, password_iterations, permissions_json, active, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
    [
      id,
      email,
      "Test Staff",
      options.role,
      hash.hash,
      hash.salt,
      hash.iterations,
      JSON.stringify(options.permissions ?? []),
      options.active === false ? 0 : 1,
      now,
    ],
  );
  return { id, email };
}

const login = (email: string, password: string, clientIp = nextClientIp()) =>
  loginRoute(
    new Request("https://order.pizza62.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-azure-clientip": clientIp },
      body: JSON.stringify({ email, password }),
    }),
  );

/** Pulls the session token out of a Set-Cookie header. */
function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const value = header.split(";")[0];
  assert.ok(value.startsWith("p62_staff_session="), `expected a session cookie, got ${header}`);
  return value;
}

const withCookie = (cookie: string, url = "https://order.pizza62.test/api/auth/me") =>
  new Request(url, { headers: { cookie } });

// --- signing in -------------------------------------------------------------

withDb("issues a session for the right password", async () => {
  const staff = await makeStaff({ role: "manager", permissions: ["view_orders"] });
  const response = await login(staff.email, PASSWORD);
  assert.equal(response.status, 200);

  const body = (await response.json()) as { user: { email: string; role: string; permissions: string[] } };
  assert.equal(body.user.email, staff.email);
  assert.equal(body.user.role, "manager");
  assert.deepEqual(body.user.permissions, ["view_orders"]);
});

withDb("marks the session cookie HttpOnly, Secure and SameSite=Strict", async () => {
  // The cookie is a bearer token for the whole staff surface. Without HttpOnly
  // any injected script can read it; without SameSite it rides along on
  // cross-site requests.
  const staff = await makeStaff({ role: "manager" });
  const header = (await login(staff.email, PASSWORD)).headers.get("set-cookie") ?? "";
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Strict/);
});

withDb("refuses a wrong password without revealing which half was wrong", async () => {
  const staff = await makeStaff({ role: "manager" });
  const wrongPassword = await login(staff.email, "not the password");
  const unknownUser = await login(`nobody-${crypto.randomUUID()}@example.test`, PASSWORD);

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownUser.status, 401);
  // Identical messages: differing ones turn the login form into an account
  // enumeration oracle.
  assert.deepEqual(await wrongPassword.json(), await unknownUser.json());
  assert.equal(wrongPassword.headers.get("set-cookie"), null);
});

withDb("refuses a deactivated account that still knows its password", async () => {
  // Deactivating someone is how a departing employee is cut off; if the password
  // still worked, it would not actually do that.
  const staff = await makeStaff({ role: "manager", active: false });
  assert.equal((await login(staff.email, PASSWORD)).status, 401);
});

withDb("matches the email case-insensitively", async () => {
  const staff = await makeStaff({ role: "manager" });
  assert.equal((await login(staff.email.toUpperCase(), PASSWORD)).status, 200);
});

withDb("throttles repeated password guesses", async () => {
  // The budget is 10 per 15 minutes. Without it the PBKDF2 hash is the only
  // thing between an attacker and an unlimited online guessing run.
  const staff = await makeStaff({ role: "manager" });
  const attacker = nextClientIp();
  let last: Response | null = null;
  for (let attempt = 0; attempt < 11; attempt += 1) {
    last = await login(staff.email, "wrong", attacker);
  }
  assert.equal(last?.status, 429);
  // And the lockout is per caller, not global — one attacker must not be able to
  // lock the restaurant's own staff out.
  assert.equal((await login(staff.email, PASSWORD, nextClientIp())).status, 200);
});

// --- using and ending a session ---------------------------------------------

withDb("resolves an identity from the session cookie", async () => {
  const staff = await makeStaff({ role: "manager", permissions: ["view_orders"] });
  const cookie = cookieFrom(await login(staff.email, PASSWORD));

  const response = await meRoute(withCookie(cookie));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { user: { id: string } };
  assert.equal(body.user.id, staff.id);
});

withDb("rejects a request with no cookie, and one with a forged token", async () => {
  assert.equal((await meRoute(new Request("https://order.pizza62.test/api/auth/me"))).status, 401);
  assert.equal(
    (await meRoute(withCookie(`p62_staff_session=${"a".repeat(64)}`))).status,
    401,
    "a made-up token must not resolve",
  );
});

withDb("logging out invalidates the session immediately", async () => {
  const staff = await makeStaff({ role: "manager" });
  const cookie = cookieFrom(await login(staff.email, PASSWORD));
  assert.equal((await meRoute(withCookie(cookie))).status, 200);

  const loggedOut = await logoutRoute(withCookie(cookie, "https://order.pizza62.test/api/auth/logout"));
  assert.match(loggedOut.headers.get("set-cookie") ?? "", /Max-Age=0/);
  // The revocation must be server-side. Clearing the cookie alone would leave a
  // token that still works for anyone who kept a copy.
  assert.equal((await meRoute(withCookie(cookie))).status, 401);
});

withDb("stops accepting a session once it has expired", async () => {
  const staff = await makeStaff({ role: "manager" });
  const cookie = cookieFrom(await login(staff.email, PASSWORD));
  await getPool().query("UPDATE staff_sessions SET expires_at = $1 WHERE staff_user_id = $2", [
    Date.now() - 1000,
    staff.id,
  ]);
  assert.equal((await meRoute(withCookie(cookie))).status, 401);
});

withDb("stops accepting a live session once the account is deactivated", async () => {
  // Deactivation has to take effect on sessions already issued, not just at the
  // next sign-in — otherwise a departing employee keeps access for 12 hours.
  const staff = await makeStaff({ role: "manager" });
  const cookie = cookieFrom(await login(staff.email, PASSWORD));
  await getPool().query("UPDATE staff_users SET active = 0 WHERE id = $1", [staff.id]);
  assert.equal(await getStaffIdentity(withCookie(cookie)), null);
});

// --- permissions ------------------------------------------------------------

withDb("lets an owner through any permission check", async () => {
  const staff = await makeStaff({ role: "owner" });
  const cookie = cookieFrom(await login(staff.email, PASSWORD));
  const identity = await requireStaff(withCookie(cookie), "issue_refunds");
  assert.equal(identity.role, "owner");
});

withDb("refuses a permission an employee has not been granted", async () => {
  const staff = await makeStaff({ role: "employee", permissions: ["view_orders"] });
  const cookie = cookieFrom(await login(staff.email, PASSWORD));

  await requireStaff(withCookie(cookie), "view_orders");
  await assert.rejects(
    () => requireStaff(withCookie(cookie), "issue_refunds"),
    (error: unknown) => error instanceof AuthError && error.status === 403,
  );
});

withDb("distinguishes an unauthenticated caller from an unauthorised one", async () => {
  // 401 and 403 are not interchangeable: the first tells the UI to show a login,
  // the second tells it not to bother.
  await assert.rejects(
    () => requireStaff(new Request("https://order.pizza62.test/api/admin/actions"), "issue_refunds"),
    (error: unknown) => error instanceof AuthError && error.status === 401,
  );
});

// --- owner bootstrap --------------------------------------------------------

const SETUP_SECRET = "test-owner-setup-secret-value-1234";

const bootstrap = (setupSecret: string) =>
  bootstrapRoute(
    new Request("https://order.pizza62.test/api/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json", "x-azure-clientip": nextClientIp() },
      body: JSON.stringify({
        name: "Second Owner",
        email: `second-${crypto.randomUUID()}@example.test`,
        password: PASSWORD,
        setupSecret,
      }),
    }),
  );

withDb("refuses to bootstrap a second owner, whatever secret is offered", async () => {
  // The setup secret is a one-time key. Once any staff user exists the endpoint
  // must be closed regardless of who holds it, or it is a permanent back door
  // that mints owner accounts. Note the route checks for existing staff *before*
  // comparing the secret, so a wrong secret also gets 409 — which is right: the
  // response must not reveal whether the secret was correct.
  const previous = process.env.OWNER_SETUP_SECRET;
  process.env.OWNER_SETUP_SECRET = SETUP_SECRET;
  try {
    await makeStaff({ role: "owner" });
    assert.equal((await bootstrap(SETUP_SECRET)).status, 409);
    assert.equal((await bootstrap("not-the-setup-secret-at-all-1234")).status, 409);
  } finally {
    if (previous === undefined) delete process.env.OWNER_SETUP_SECRET;
    else process.env.OWNER_SETUP_SECRET = previous;
  }
});

withDb("refuses to bootstrap at all when no setup secret is configured", async () => {
  // An unset OWNER_SETUP_SECRET must close the endpoint, not open it. The
  // failure mode this guards is a deployment that forgets the secret and thereby
  // exposes unauthenticated owner creation.
  const previous = process.env.OWNER_SETUP_SECRET;
  delete process.env.OWNER_SETUP_SECRET;
  try {
    assert.equal((await bootstrap("anything")).status, 503);
  } finally {
    if (previous !== undefined) process.env.OWNER_SETUP_SECRET = previous;
  }
});
