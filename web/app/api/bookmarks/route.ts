import { requireUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { badRequest, handle, json, notFound, readJson } from "@/lib/http";
import { LIST_PAGE_SIZE, offsetFor, pageResult } from "@/lib/paging";
import { SUMMARY_COLUMNS, toSummary } from "@/lib/papers";
import { optionalInt, pageParam } from "@/lib/validate";

// GET /api/bookmarks?page=1: the logged-in user's bookmarks, newest first.
export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const page = pageParam(new URL(req.url).searchParams);
  const rows = await query(
    `SELECT ${SUMMARY_COLUMNS}, b.created_at AS bookmarked_at, count(*) OVER () AS total
     FROM bookmarks b JOIN v_paper_details d ON d.paper_id = b.paper_id
     WHERE b.user_id = $1
     ORDER BY b.created_at DESC, d.paper_id
     LIMIT $2 OFFSET $3`,
    [user.user_id, LIST_PAGE_SIZE, offsetFor(page)],
  );
  return json(
    await pageResult(
      rows,
      (r) => ({ ...toSummary(r), bookmarked_at: r.bookmarked_at }),
      "SELECT count(*) AS n FROM bookmarks WHERE user_id = $1",
      [user.user_id],
    ),
  );
});

// POST /api/bookmarks  { paper_id }
// The composite primary key (user_id, paper_id) makes a second bookmark of
// the same paper fail with a unique violation, which becomes 409.
export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson(req);
  const paperId = optionalInt(body.paper_id, "paper_id", 1, 2147483647);
  if (paperId == null) throw badRequest("paper_id is required");

  const exists = await query("SELECT 1 FROM papers WHERE paper_id = $1", [paperId]);
  if (!exists.length) throw notFound("paper");

  const [row] = await query<{ paper_id: number; bookmarked_at: string }>(
    "INSERT INTO bookmarks (user_id, paper_id) VALUES ($1, $2) RETURNING paper_id, created_at AS bookmarked_at",
    [user.user_id, paperId],
  );
  return json(row, 201);
});
