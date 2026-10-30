import bcrypt from "bcryptjs";
import { USER_COLUMNS, setSessionCookie, type User } from "@/lib/auth";
import { query } from "@/lib/db";
import { badRequest, handle, json, readJson } from "@/lib/http";
import { email, requiredString } from "@/lib/validate";

// bcrypt cost 10 = 2^10 rounds: about 50-100 ms per hash. Slow enough to make
// guessing stolen hashes expensive, fast enough for a login request.
export const BCRYPT_COST = 10;

// POST /api/auth/register  { name, email, password }
export const POST = handle(async (req: Request) => {
  const body = await readJson(req);
  const name = requiredString(body.name, "name", 100);
  const userEmail = email(body.email);
  const password = body.password;
  if (typeof password !== "string" || password.length < 8) {
    throw badRequest("password must be at least 8 characters");
  }
  // bcrypt only uses the first 72 bytes; refuse longer so nothing is silently ignored.
  if (Buffer.byteLength(password) > 72) throw badRequest("password must be at most 72 bytes");

  const hash = await bcrypt.hash(password, BCRYPT_COST);
  // role is not taken from the request: the column default makes every new account a 'researcher'.
  // A duplicate email hits the UNIQUE constraint and becomes 409 CONFLICT in handle().
  const [user] = await query<User>(
    `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING ${USER_COLUMNS}`,
    [name, userEmail, hash],
  );

  const res = json({ user }, 201);
  setSessionCookie(res, user.user_id);
  return res;
});
