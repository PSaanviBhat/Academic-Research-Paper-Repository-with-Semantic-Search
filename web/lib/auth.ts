import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { query } from "./db";
import { HttpError } from "./http";
import { SESSION_COOKIE, cookieOptions, createSessionToken, readSessionToken } from "./session";

export type Role = "researcher" | "admin";

export type User = {
  user_id: number;
  name: string;
  email: string;
  role: Role;
  created_at: string;
};

// Columns returned to clients. password_hash is never selected here.
export const USER_COLUMNS = "user_id, name, email, role, created_at";

/** The logged-in user, or null. The role comes fresh from the database. */
export async function getUser(): Promise<User | null> {
  const store = await cookies();
  const userId = readSessionToken(store.get(SESSION_COOKIE)?.value);
  if (userId === null) return null;
  const rows = await query<User>(`SELECT ${USER_COLUMNS} FROM users WHERE user_id = $1`, [userId]);
  return rows[0] ?? null;
}

/** 401 unless someone is logged in. */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "login required");
  return user;
}

/**
 * Role-based guard: 401 if not logged in, 403 if logged in with the wrong role.
 *   const admin = await requireRole("admin");
 */
export async function requireRole(role: Role): Promise<User> {
  const user = await requireUser();
  if (user.role !== role) throw new HttpError(403, "FORBIDDEN", `${role} role required`);
  return user;
}

export function setSessionCookie(res: NextResponse, userId: number) {
  res.cookies.set(SESSION_COOKIE, createSessionToken(userId), cookieOptions);
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, "", { ...cookieOptions, maxAge: 0 });
}
