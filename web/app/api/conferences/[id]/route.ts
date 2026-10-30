import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { badRequest, handle, json, notFound, readJson } from "@/lib/http";
import { CONFERENCE_COLUMNS, SUMMARY_COLUMNS, toSummary } from "@/lib/papers";
import { YEAR_MAX, YEAR_MIN, idParam, optionalInt, optionalString, requiredString } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/conferences/:id: conference stats + its papers
export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const conferenceId = idParam((await params).id);
  const [conference] = await query(
    `SELECT ${CONFERENCE_COLUMNS}, paper_count, total_citations FROM v_conference_stats WHERE conference_id = $1`,
    [conferenceId],
  );
  if (!conference) throw notFound("conference");
  const papers = await query(
    `SELECT ${SUMMARY_COLUMNS} FROM v_paper_details d WHERE d.conference_id = $1
     ORDER BY d.citation_count DESC, d.paper_id`,
    [conferenceId],
  );
  return json({ ...conference, papers: papers.map(toSummary) });
});

// PATCH /api/conferences/:id (admin): any of name, acronym, year, location.
export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  await requireRole("admin");
  const conferenceId = idParam((await params).id);
  const body = await readJson(req);

  // Fixed list of editable columns; values always go in as $n parameters.
  const changes: Record<string, unknown> = {};
  if (body.name !== undefined) changes.name = requiredString(body.name, "name", 300);
  if (body.acronym !== undefined) changes.acronym = optionalString(body.acronym, "acronym", 50);
  if (body.year !== undefined) changes.year = optionalInt(body.year, "year", YEAR_MIN, YEAR_MAX);
  if (body.location !== undefined) changes.location = optionalString(body.location, "location", 200);
  const columns = Object.keys(changes);
  if (!columns.length) throw badRequest("send at least one of name, acronym, year, location");

  const [conference] = await query(
    `UPDATE conferences SET ${columns.map((c, i) => `${c} = $${i + 2}`).join(", ")}
     WHERE conference_id = $1 RETURNING ${CONFERENCE_COLUMNS}`,
    [conferenceId, ...columns.map((c) => changes[c])],
  );
  if (!conference) throw notFound("conference");
  return json(conference);
});

// DELETE /api/conferences/:id (admin): its papers stay, with conference_id set to NULL (ON DELETE SET NULL).
export const DELETE = handle(async (_req: Request, { params }: Ctx) => {
  await requireRole("admin");
  const conferenceId = idParam((await params).id);
  const rows = await query("DELETE FROM conferences WHERE conference_id = $1 RETURNING conference_id", [conferenceId]);
  if (!rows.length) throw notFound("conference");
  return json({ conference_id: conferenceId, deleted: true });
});
