import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { badRequest, handle, json, readJson } from "@/lib/http";
import { LIST_PAGE_SIZE, offsetFor, pageResult } from "@/lib/paging";
import { SUMMARY_COLUMNS, toSummary } from "@/lib/papers";
import {
  YEAR_MAX,
  YEAR_MIN,
  intQuery,
  normaliseDoi,
  optionalInt,
  optionalString,
  pageParam,
  requiredString,
} from "@/lib/validate";

const MAX_ID = 2147483647; // largest PostgreSQL INT

// GET /api/papers?page=1&year=2020: newest papers first.
export const GET = handle(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const page = pageParam(params);
  const year = intQuery(params, "year", YEAR_MIN, YEAR_MAX) ?? null;

  const rows = await query(
    `SELECT ${SUMMARY_COLUMNS}, count(*) OVER () AS total
     FROM v_paper_details d
     WHERE ($1::int IS NULL OR d.year = $1)
     ORDER BY d.year DESC NULLS LAST, d.paper_id DESC
     LIMIT $2 OFFSET $3`,
    [year, LIST_PAGE_SIZE, offsetFor(page)],
  );
  return json(
    await pageResult(rows, toSummary, "SELECT count(*) AS n FROM papers WHERE ($1::int IS NULL OR year = $1)", [year]),
  );
});

// POST /api/papers (admin): atomic insert through add_paper() (db/005_functions.sql).
export const POST = handle(async (req: Request) => {
  await requireRole("admin");
  const body = await readJson(req);

  const title = requiredString(body.title, "title", 1000);
  const abstract = optionalString(body.abstract, "abstract") ?? null;
  const year = optionalInt(body.year, "year", YEAR_MIN, YEAR_MAX) ?? null;
  const doi = normaliseDoi(body.doi) ?? null;
  const conferenceId = optionalInt(body.conference_id, "conference_id", 1, MAX_ID) ?? null;

  if (!Array.isArray(body.authors) || body.authors.length === 0) {
    throw badRequest("authors must be a non-empty array of {name, affiliation}");
  }
  if (body.authors.length > 100) throw badRequest("at most 100 authors");
  const authors = body.authors.map((a: unknown, i: number) => {
    if (!a || typeof a !== "object") throw badRequest(`authors[${i}] must be an object`);
    const author = a as Record<string, unknown>;
    return {
      name: requiredString(author.name, `authors[${i}].name`, 300),
      affiliation: optionalString(author.affiliation, `authors[${i}].affiliation`, 500) ?? null,
    };
  });

  const cited = body.cited_paper_ids ?? [];
  if (!Array.isArray(cited) || cited.length > 1000) {
    throw badRequest("cited_paper_ids must be an array of at most 1000 paper ids");
  }
  cited.forEach((id: unknown, i: number) => optionalInt(id, `cited_paper_ids[${i}]`, 1, MAX_ID));

  // One function call = one transaction: paper, authors and citations are
  // all saved, or (on any error) none are.
  const [row] = await query<{ paper_id: number }>(
    "SELECT add_paper($1, $2, $3, $4, $5, $6::jsonb, $7::int[]) AS paper_id",
    [title, abstract, year, doi, conferenceId, JSON.stringify(authors), cited],
  );
  return json({ paper_id: row.paper_id, embedding_status: "pending" }, 201);
});
