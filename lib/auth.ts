import { env } from "@/lib/runtime-env";
import { ensureDatabase, getD1, safeJson } from "@/db/runtime";
import { generateOpaqueToken, hashOpaqueToken, hasPermission } from "@/lib/domain";

const SESSION_COOKIE = "p62_staff_session";
// Cloudflare Workers supports PBKDF2 iteration counts up to 100,000.
const PASSWORD_ITERATIONS = 100_000;
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

export type StaffIdentity = {
  id: string;
  email: string;
  name: string;
  role: "owner" | "manager" | "employee";
  permissions: string[];
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function derivePassword(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer,
      iterations,
    },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function validatePassword(password: string): void {
  if (password.length < 12 || password.length > 128) {
    throw new Error("Password must be between 12 and 128 characters");
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error("Password must include upper-case, lower-case, and numeric characters");
  }
}

export async function createPasswordHash(password: string): Promise<{
  hash: string;
  salt: string;
  iterations: number;
}> {
  validatePassword(password);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  return {
    hash: bytesToBase64(derived),
    salt: bytesToBase64(salt),
    iterations: PASSWORD_ITERATIONS,
  };
}

// Kiosk PINs are short by necessity — they are typed on a shared tablet in front
// of other people — so they are hashed with the same PBKDF2 work factor as a
// password and the endpoint that checks them is rate limited.
export function validatePin(pin: string): void {
  if (!/^[0-9]{4,8}$/.test(pin)) throw new Error("A clock-in PIN must be 4 to 8 digits");
  if (/^(.)\1+$/.test(pin)) throw new Error("A clock-in PIN cannot be the same digit repeated");
}

export async function createPinHash(pin: string): Promise<{ hash: string; salt: string; iterations: number }> {
  validatePin(pin);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derivePassword(pin, salt, PASSWORD_ITERATIONS);
  return { hash: bytesToBase64(derived), salt: bytesToBase64(salt), iterations: PASSWORD_ITERATIONS };
}

export async function verifyPin(pin: string, expectedHash: string, salt: string, iterations: number): Promise<boolean> {
  if (!/^[0-9]{4,8}$/.test(pin)) return false;
  const actual = await derivePassword(pin, base64ToBytes(salt), iterations);
  return equalBytes(actual, base64ToBytes(expectedHash));
}

export async function verifyPassword(
  password: string,
  expectedHash: string,
  salt: string,
  iterations: number,
): Promise<boolean> {
  if (password.length < 1 || password.length > 128) return false;
  const actual = await derivePassword(password, base64ToBytes(salt), iterations);
  return equalBytes(actual, base64ToBytes(expectedHash));
}

function parseCookie(request: Request, key: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === key) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function getStaffIdentity(request: Request): Promise<StaffIdentity | null> {
  await ensureDatabase();
  const token = parseCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await hashOpaqueToken(token);
  const row = await getD1()
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, u.permissions_json
       FROM staff_sessions s
       JOIN staff_users u ON u.id = s.staff_user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.active = 1`,
    )
    .bind(tokenHash, Date.now())
    .first<{
      id: string;
      email: string;
      name: string;
      role: "owner" | "manager" | "employee";
      permissions_json: string;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    permissions: safeJson<string[]>(row.permissions_json, []),
  };
}

export async function requireStaff(
  request: Request,
  permission?: string,
): Promise<StaffIdentity> {
  const identity = await getStaffIdentity(request);
  if (!identity) throw new AuthError(401, "Sign in is required");
  if (permission && !hasPermission(identity.role, identity.permissions, permission)) {
    throw new AuthError(403, "You do not have permission to perform this action");
  }
  return identity;
}

export class AuthError extends Error {
  constructor(
    public status: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

export async function createStaffSession(staffUserId: string): Promise<{
  token: string;
  cookie: string;
}> {
  const token = generateOpaqueToken();
  const tokenHash = await hashOpaqueToken(token);
  const now = Date.now();
  await getD1()
    .prepare(
      `INSERT INTO staff_sessions (id, staff_user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), staffUserId, tokenHash, now + SESSION_DURATION_MS, now)
    .run();
  return {
    token,
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}`,
  };
}

export async function revokeStaffSession(request: Request): Promise<void> {
  const token = parseCookie(request, SESSION_COOKIE);
  if (!token) return;
  await ensureDatabase();
  await getD1()
    .prepare("UPDATE staff_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(Date.now(), await hashOpaqueToken(token))
    .run();
}

export function expiredStaffCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export function ownerSetupSecret(): string | null {
  const value = (env as unknown as Record<string, string | undefined>).OWNER_SETUP_SECRET;
  return value && value.length >= 24 ? value : null;
}

export function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  throw error;
}
