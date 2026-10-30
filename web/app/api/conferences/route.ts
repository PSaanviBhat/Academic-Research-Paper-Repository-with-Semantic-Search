import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { badRequest, handle, json, readJson } from "@/lib/http";
import { LIST_PAGE_SIZE, likeEscape, offsetFor, pageResult } from "@/lib/paging";
import { CONFERENCE_COLUMNS } from "@/lib/papers";
import { YEAR_MAX, YEAR_MIN, optionalInt, optionalString, pageParam, requiredString } from "@/lib/validate";

const toConference = (r: Record<string, unknown>) => ({
  conference_id: r.conference_id,
  name: r.name,
  acronym: r.acronym,
  year: r.year,
  location: r.location,
  paper_count: r.paper_count,
  total_citations: r.total_citations,
});

// GET /api/conferences?q=emnlp&page=1: newest editions first.
export const GET = handle(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const page = pageParam(params);
  const q = (params.get("q") ?? "").trim();
  if (q.length > 100) throw badRequest("q must be at most 100 characters");
  const pattern = likeEscape(q);

  const rows = await query(
    `SELECT s.*, count(*) OVER () AS total FROM v_conference_stats s
     WHERE $1 = '' OR s.name ILIKE '%' || $2 || '%' OR s.acronym ILIKE '%' || $2 || '%'
     ORDER BY s.year DESC NULLS LAST, s.name, s.conference_id
     LIMIT $3 OFFSET $4`,
    [q, pattern, LIST_PAGE_SIZE, offsetFor(page)],
  );
  return json(
    await pageResult(
      rows,
      toConference,
      "SELECT count(*) AS n FROM conferences WHERE $1 = '' OR name ILIKE '%' || $2 || '%' OR acronym ILIKE '%' || $2 || '%'",
      [q, pattern],
    ),
  );
});

// POST /api/conferences (admin)  { name, acronym?, year?, location? }
// A duplicate (name, year) hits the UNIQUE constraint and becomes 409.
export const POST = handle(async (req: Request) => {
  await requireRole("admin");
  const body = await readJson(req);
  const [conference] = await query(
    `INSERT INTO conferences (name, acronym, year, location) VALUES ($1, $2, $3, $4)
     RETURNING ${CONFERENCE_COLUMNS}`,
    [
      requiredString(body.name, "name", 300),
      optionalString(body.acronym, "acronym", 50) ?? null,
      optionalInt(body.year, "year", YEAR_MIN, YEAR_MAX) ?? null,
      optionalString(body.location, "location", 200) ?? null,
    ],
  );
  return json(conference, 201);
});
