import bcrypt from "bcryptjs";
import { setSessionCookie, type User } from "@/lib/auth";
import { query } from "@/lib/db";
import { HttpError, handle, json, readJson } from "@/lib/http";
import { email, requiredString } from "@/lib/validate";

// When the email does not exist we still run one bcrypt comparison (against
// this throwaway hash), so a wrong email and a wrong password take the same
// time and cannot be told apart.
const DUMMY_HASH = bcrypt.hashSync("no-such-user-placeholder", 10);

// POST /api/auth/login  { email, password }
export const POST = handle(async (req: Request) => {
  const body = await readJson(req);
  const userEmail = email(body.email);
  const password = requiredString(body.password, "password", 200);

  const [row] = await query<User & { password_hash: string }>(
    "SELECT user_id, name, email, role, created_at, password_hash FROM users WHERE email = $1",
    [userEmail],
  );
  const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) {
    // Same message for both cases: do not reveal which emails are registered.
    throw new HttpError(401, "UNAUTHENTICATED", "wrong email or password");
  }

  const { password_hash: _hash, ...user } = row;
  const res = json({ user });
  setSessionCookie(res, user.user_id);
  return res;
});
