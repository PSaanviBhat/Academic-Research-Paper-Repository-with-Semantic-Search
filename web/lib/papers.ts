import { query } from "./db";

// Shared paper queries, so every route returns exactly the shapes in
// docs/API_CONTRACT.md.

/** Columns returned for a conference (POST/PATCH responses). */
export const CONFERENCE_COLUMNS = "conference_id, name, acronym, year, location";

/** Columns of v_paper_details that make up a PaperSummary. */
export const SUMMARY_COLUMNS = `d.paper_id, d.title, d.year, d.conference_name AS conference,
  d.author_list AS authors, d.citation_count`;

export type PaperSummary = {
  paper_id: number;
  title: string;
  year: number | null;
  conference: string | null;
  authors: string[];
  citation_count: number;
};

/** Pick exactly the PaperSummary fields (drops helper columns such as total). */
export function toSummary(row: Record<string, unknown>): PaperSummary {
  return {
    paper_id: row.paper_id as number,
    title: row.title as string,
    year: row.year as number | null,
    conference: row.conference as string | null,
    authors: row.authors as string[],
    citation_count: row.citation_count as number,
  };
}

/** Full paper for GET /api/papers/:id, or null if it does not exist. */
export async function getPaperDetail(paperId: number) {
  const [paper] = await query(
    `SELECT paper_id, title, abstract, year, doi, citation_count, embedding_status, created_at,
            conference_id, conference_name, conference_acronym, conference_year, conference_location
     FROM v_paper_details WHERE paper_id = $1`,
    [paperId],
  );
  if (!paper) return null;

  // The three lists are independent, so run them in parallel.
  const [authors, references, citedBy] = await Promise.all([
    query(
      `SELECT a.author_id, a.name, a.affiliation, pa.author_order
       FROM paper_authors pa JOIN authors a ON a.author_id = pa.author_id
       WHERE pa.paper_id = $1 ORDER BY pa.author_order`,
      [paperId],
    ),
    // Papers this paper cites (uses the primary key, which starts with citing_paper_id).
    query(
      `SELECT p.paper_id, p.title, p.year, p.citation_count
       FROM citations c JOIN papers p ON p.paper_id = c.cited_paper_id
       WHERE c.citing_paper_id = $1 ORDER BY p.citation_count DESC, p.paper_id`,
      [paperId],
    ),
    // Papers citing this one (uses idx_citations_cited_paper_id).
    query(
      `SELECT p.paper_id, p.title, p.year, p.citation_count
       FROM citations c JOIN papers p ON p.paper_id = c.citing_paper_id
       WHERE c.cited_paper_id = $1 ORDER BY p.citation_count DESC, p.paper_id`,
      [paperId],
    ),
  ]);

  return {
    paper_id: paper.paper_id,
    title: paper.title,
    abstract: paper.abstract,
    year: paper.year,
    doi: paper.doi,
    citation_count: paper.citation_count,
    embedding_status: paper.embedding_status,
    created_at: paper.created_at,
    conference:
      paper.conference_id === null
        ? null
        : {
            conference_id: paper.conference_id,
            name: paper.conference_name,
            acronym: paper.conference_acronym,
            year: paper.conference_year,
            location: paper.conference_location,
          },
    authors,
    references,
    cited_by: citedBy,
  };
}
