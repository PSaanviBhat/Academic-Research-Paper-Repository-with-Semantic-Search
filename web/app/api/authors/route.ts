import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { badRequest, handle, json, readJson } from "@/lib/http";
import { LIST_PAGE_SIZE, likeEscape, offsetFor, pageResult } from "@/lib/paging";
import { optionalString, pageParam, requiredString } from "@/lib/validate";

const toAuthor = (r: Record<string, unknown>) => ({
  author_id: r.author_id,
  name: r.name,
  affiliation: r.affiliation,
  paper_count: r.paper_count,
  total_citations: r.total_citations,
});

// GET /api/authors?q=vaswani&page=1
// With q: fuzzy name match (ILIKE uses the trigram index on authors.name),
// closest names first. Without q: most-cited authors first.
export const GET = handle(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const page = pageParam(params);
  const q = (params.get("q") ?? "").trim();
  if (q.length > 100) throw badRequest("q must be at most 100 characters");

  const rows = q
    ? await query(
        `SELECT s.*, count(*) OVER () AS total FROM v_author_stats s
         WHERE s.name ILIKE '%' || $1 || '%'
         ORDER BY similarity(s.name, $2) DESC, s.total_citations DESC, s.author_id
         LIMIT $3 OFFSET $4`,
        [likeEscape(q), q, LIST_PAGE_SIZE, offsetFor(page)],
      )
    : await query(
        `SELECT s.*, count(*) OVER () AS total FROM v_author_stats s
         ORDER BY s.total_citations DESC, s.author_id
         LIMIT $1 OFFSET $2`,
        [LIST_PAGE_SIZE, offsetFor(page)],
      );
  return json(
    await pageResult(rows, toAuthor, "SELECT count(*) AS n FROM authors WHERE $1 = '' OR name ILIKE '%' || $2 || '%'", [
      q,
      likeEscape(q),
    ]),
  );
});

// POST /api/authors (admin)  { name, affiliation }
export const POST = handle(async (req: Request) => {
  await requireRole("admin");
  const body = await readJson(req);
  const [author] = await query(
    "INSERT INTO authors (name, affiliation) VALUES ($1, $2) RETURNING author_id, name, affiliation",
    [requiredString(body.name, "name", 300), optionalString(body.affiliation, "affiliation", 500) ?? null],
  );
  return json(author, 201);
});
