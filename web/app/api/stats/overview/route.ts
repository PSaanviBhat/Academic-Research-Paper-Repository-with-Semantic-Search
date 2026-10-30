import { query } from "@/lib/db";
import { handle, json } from "@/lib/http";

// GET /api/stats/overview: everything the dashboard needs, read from the views in db/004_views.sql.
export const GET = handle(async () => {
  // Independent queries, run in parallel.
  const [[totals], topCited, perYear, conferenceStats, topAuthors] = await Promise.all([
    query(`SELECT (SELECT count(*) FROM papers)      AS papers,
                  (SELECT count(*) FROM authors)     AS authors,
                  (SELECT count(*) FROM citations)   AS citations,
                  (SELECT count(*) FROM conferences) AS conferences`),
    query(`SELECT paper_id, title, year, conference_name AS conference, citation_count
           FROM v_top_cited_papers LIMIT 10`),
    query("SELECT year, paper_count FROM v_papers_per_year ORDER BY year"),
    query(`SELECT conference_id, name, acronym, year, paper_count, total_citations
           FROM v_conference_stats ORDER BY total_citations DESC, paper_count DESC, conference_id LIMIT 10`),
    query(`SELECT author_id, name, paper_count, total_citations
           FROM v_author_stats ORDER BY total_citations DESC, author_id LIMIT 10`),
  ]);

  return json({
    totals,
    top_cited: topCited,
    papers_per_year: perYear,
    conference_stats: conferenceStats,
    top_authors: topAuthors,
  });
});
