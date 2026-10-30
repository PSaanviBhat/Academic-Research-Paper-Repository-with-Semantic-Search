import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";

// GET /api/auth/me: the logged-in user, or 401.
export const GET = handle(async () => {
  const user = await requireUser();
  return json({ user });
});
