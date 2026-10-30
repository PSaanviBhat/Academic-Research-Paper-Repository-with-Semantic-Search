import { query } from "@/lib/db";
import { HttpError, badRequest, handle, json } from "@/lib/http";
import { YEAR_MAX, YEAR_MIN, intQuery, pageParam } from "@/lib/validate";

const PAGE_SIZE = 10;
const MODES = ["keyword", "semantic", "hybrid"] as const;

// GET /api/search?q=...&mode=keyword|semantic|hybrid&page=1&year=2020
export const GET = handle(async (req: Request) => {
  const params = new URL(req.url).searchParams;

  const q = (params.get("q") ?? "").trim();
  if (!q) throw badRequest("q is required");
  if (q.length > 500) throw badRequest("q must be at most 500 characters");

  const mode = params.get("mode") ?? "keyword";
  if (!MODES.includes(mode as (typeof MODES)[number])) {
    throw badRequest("mode must be keyword, semantic or hybrid");
  }
  const page = pageParam(params);
  const year = intQuery(params, "year", YEAR_MIN, YEAR_MAX) ?? null;

  // Semantic and hybrid search need the vector database; they are built in Part 2.
  if (mode !== "keyword") throw new HttpError(501, "NOT_IMPLEMENTED", "implemented in Part 2");

  // All the search logic lives in the SQL function (db/006_search.sql).
  const rows = await query(
    `SELECT paper_id, title, abstract_snippet, year, conference, authors, citation_count, score, total
     FROM search_papers_keyword($1, $2, $3, $4)`,
    [q, year, PAGE_SIZE, (page - 1) * PAGE_SIZE],
  );

  return json({
    results: rows.map(({ total: _total, ...r }) => r),
    // Every row carries the same total; an empty page means there are no
    // matches at all, or the page is past the end. Then count separately.
    total: rows.length ? (rows[0].total as number) : await countMatches(q, year),
  });
});

async function countMatches(q: string, year: number | null): Promise<number> {
  const [{ n }] = await query<{ n: number }>(
    `SELECT count(*) AS n FROM papers
     WHERE search_tsv @@ websearch_to_tsquery('english', $1) AND ($2::int IS NULL OR year = $2)`,
    [q, year],
  );
  return n;
}
