import { createHmac, timingSafeEqual } from "node:crypto";

// Session = a small signed cookie, no session table.
//
//   cookie "session" = base64url(JSON {uid, exp}) + "." + HMAC-SHA256 signature
//
// The server signs the payload with SESSION_SECRET. A client can read the
// payload but cannot change it (for example to become another user) without
// invalidating the signature, because only the server knows the secret.
// The cookie is HttpOnly (JavaScript in the page cannot read it, which
// protects it from XSS) and SameSite=Lax (not sent on cross-site POSTs,
// which protects against CSRF).
//
// Only the user id is stored. The role is looked up in the database on each
// request (see auth.ts), so a role change or a deleted account takes effect
// immediately.

export const SESSION_COOKIE = "session";
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days, in seconds

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set in .env (at least 32 characters)");
  return s;
}

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

export function createSessionToken(userId: number): string {
  const payload = Buffer.from(
    JSON.stringify({ uid: userId, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Returns the user id if the token is genuine and not expired, else null. */
export function readSessionToken(token: string | undefined): number | null {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  // Constant-time comparison so an attacker cannot guess the signature byte by byte from response timing.
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!Number.isInteger(uid) || typeof exp !== "number" || exp < Date.now() / 1000) return null;
    return uid;
  } catch {
    return null;
  }
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production", // HTTPS-only outside local development
  path: "/",
  maxAge: SESSION_MAX_AGE,
};
