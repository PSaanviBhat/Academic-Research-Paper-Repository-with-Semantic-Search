import { clearSessionCookie } from "@/lib/auth";
import { handle, json } from "@/lib/http";

// POST /api/auth/logout
// Sessions are stateless signed cookies, so logging out means telling the
// browser to delete the cookie (Max-Age=0).
export const POST = handle(async () => {
  const res = json({ ok: true });
  clearSessionCookie(res);
  return res;
});
