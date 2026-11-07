import { query } from "@/lib/db";
import { badRequest, handle, json } from "@/lib/http";
import { YEAR_MAX, YEAR_MIN, intQuery, pageParam } from "@/lib/validate";
import { embed, searchVectors, type VectorHit } from "@/lib/vector";

const PAGE_SIZE = 10;
const MODES = ["keyword", "semantic", "hybrid"] as const;
type Mode = (typeof MODES)[number];

// Semantic and hybrid search rank a fixed candidate pool, then paginate it.
// Nearest-neighbour search has no natural "total", so total = pool size (at most 100).
const CANDIDATES = 100;
// Reciprocal Rank Fusion constant (proposal section 4): score = sum of 1 / (60 + rank).
const RRF_K = 60;

type ResultRow = {
  paper_id: number;
  title: string;
  abstract_snippet: string;
  year: number | null;
  conference: string | null;
  authors: string[];
  citation_count: number;
  score: number;
};

// GET /api/search?q=...&mode=keyword|semantic|hybrid&page=1&year=2020
export const GET = handle(async (req: Request) => {
  const params = new URL(req.url).searchParams;

  const q = (params.get("q") ?? "").trim();
  if (!q) throw badRequest("q is required");
  if (q.length > 500) throw badRequest("q must be at most 500 characters");

  const mode = (params.get("mode") ?? "keyword") as Mode;
  if (!MODES.includes(mode)) throw badRequest("mode must be keyword, semantic or hybrid");
  const page = pageParam(params);
  const year = intQuery(params, "year", YEAR_MIN, YEAR_MAX) ?? null;

  if (mode === "keyword") return json(await keywordPage(q, year, page));

  const ranked = mode === "semantic" ? await semanticRanking(q, year) : await hybridRanking(q, year);
  return json(await hydratePage(ranked, page));
});

// ---------------------------------------------------------------- keyword

async function keywordPage(q: string, year: number | null, page: number) {
  // All the search logic lives in the SQL function (db/006_search.sql).
  const rows = await query(
    `SELECT paper_id, title, abstract_snippet, year, conference, authors, citation_count, score, total
     FROM search_papers_keyword($1, $2, $3, $4)`,
    [q, year, PAGE_SIZE, (page - 1) * PAGE_SIZE],
  );
  return {
    results: rows.map(({ total: _total, ...r }) => r),
    // Every row carries the same total; an empty page means there are no
    // matches at all, or the page is past the end. Then count separately.
    total: rows.length ? (rows[0].total as number) : await countMatches(q, year),
  };
}

async function countMatches(q: string, year: number | null): Promise<number> {
  const [{ n }] = await query<{ n: number }>(
    `SELECT count(*) AS n FROM papers
     WHERE search_tsv @@ websearch_to_tsquery('english', $1) AND ($2::int IS NULL OR year = $2)`,
    [q, year],
  );
  return n;
}

// --------------------------------------------------------------- semantic

/** Embed the query, then ask Qdrant for the nearest papers (cosine similarity, best first). */
async function semanticRanking(q: string, year: number | null): Promise<VectorHit[]> {
  return searchVectors(await embed(q), CANDIDATES, year);
}

// ----------------------------------------------------------------- hybrid

/**
 * Reciprocal Rank Fusion of the keyword ranking (S8) and the semantic ranking (V4).
 * Each paper scores sum of 1 / (60 + rank) over the lists it appears in (rank starts at 1),
 * so a paper ranked well by both methods beats one ranked first by only one.
 */
async function hybridRanking(q: string, year: number | null): Promise<VectorHit[]> {
  const [keyword, semantic] = await Promise.all([
    query<{ paper_id: number }>("SELECT paper_id FROM search_papers_keyword($1, $2, $3, 0)", [q, year, CANDIDATES]),
    semanticRanking(q, year),
  ]);

  const fused = new Map<number, number>();
  for (const list of [keyword, semantic]) {
    list.forEach(({ paper_id }, i) => fused.set(paper_id, (fused.get(paper_id) ?? 0) + 1 / (RRF_K + i + 1)));
  }
  return [...fused]
    .map(([paper_id, score]) => ({ paper_id, score }))
    .sort((a, b) => b.score - a.score || a.paper_id - b.paper_id);
}

// -------------------------------------------------------------- hydration

/**
 * Re-read the ranked ids from PostgreSQL (the source of truth), keep the
 * ranking order, and drop ids that no longer exist (an orphan vector left by
 * a delete is therefore harmless). Then cut out the requested page.
 */
async function hydratePage(ranked: VectorHit[], page: number) {
  if (ranked.length === 0) return { results: [], total: 0 };
  const ids = ranked.map((h) => h.paper_id);
  const score = new Map(ranked.map((h) => [h.paper_id, h.score]));

  const rows = await query<Omit<ResultRow, "score">>(
    `SELECT d.paper_id, d.title,
            -- Same length as keyword snippets (~35 words), from the start of the abstract.
            coalesce(substring(d.abstract FROM '^(\\S+(\\s+\\S+){0,34})'), '') AS abstract_snippet,
            d.year, d.conference_name AS conference, d.author_list AS authors, d.citation_count
     FROM v_paper_details d
     WHERE d.paper_id = ANY($1::int[])
     ORDER BY array_position($1::int[], d.paper_id)`,
    [ids],
  );

  const start = (page - 1) * PAGE_SIZE;
  return {
    results: rows.slice(start, start + PAGE_SIZE).map((r) => ({ ...r, score: score.get(r.paper_id)! })),
    total: rows.length,
  };
}
