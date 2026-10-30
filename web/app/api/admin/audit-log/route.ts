import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { pageParam } from "@/lib/validate";

const PAGE_SIZE = 20;

// GET /api/admin/audit-log?page=1 (admin only)
// Rows are written by the database trigger on paper deletion, never by the app.
export const GET = handle(async (req: Request) => {
  await requireRole("admin");
  const page = pageParam(new URL(req.url).searchParams);
  const rows = await query(
    `SELECT l.log_id, l.action, l.paper_id, l.admin_id, u.email AS admin_email, l.logged_at,
            count(*) OVER () AS total
     FROM audit_log l LEFT JOIN users u ON u.user_id = l.admin_id
     ORDER BY l.log_id DESC LIMIT $1 OFFSET $2`,
    [PAGE_SIZE, (page - 1) * PAGE_SIZE],
  );
  return json({
    results: rows.map(({ total: _t, ...r }) => r),
    total: rows.length ? (rows[0].total as number) : (await query<{ n: number }>("SELECT count(*) AS n FROM audit_log"))[0].n,
  });
});
