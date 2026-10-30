import { requireUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { handle, json, notFound } from "@/lib/http";
import { idParam } from "@/lib/validate";

type Ctx = { params: Promise<{ paperId: string }> };

// DELETE /api/bookmarks/:paperId: remove one of the logged-in user's bookmarks.
// The WHERE includes user_id, so nobody can delete another user's bookmark.
export const DELETE = handle(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const paperId = idParam((await params).paperId, "paperId");
  const rows = await query("DELETE FROM bookmarks WHERE user_id = $1 AND paper_id = $2 RETURNING paper_id", [
    user.user_id,
    paperId,
  ]);
  if (!rows.length) throw notFound("bookmark");
  return json({ paper_id: paperId, deleted: true });
});
