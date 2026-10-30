-- =====================================================================
-- 004_views.sql : named, reusable queries for the detail page and the
-- statistics dashboard
--
-- A view stores the QUERY, not the data, so it is always up to date.
-- The API reads from these views instead of repeating the same joins in
-- several routes, and the joins are explained in one place.
-- =====================================================================


-- ---------------------------------------------------------------------
-- v_paper_details: one row per paper with its conference and authors.
-- LEFT JOINs keep papers that have no conference or no authors yet.
-- Authors are gathered in a LATERAL subquery (run once per paper) so the
-- outer query needs no GROUP BY over every paper column.
-- Two forms of the author list are provided: a display string
-- ("A, B, C", via string_agg) and an array (for the API's authors[]),
-- both in byline order.
-- ---------------------------------------------------------------------
CREATE VIEW v_paper_details AS
SELECT
    p.paper_id,
    p.title,
    p.abstract,
    p.year,
    p.doi,
    p.citation_count,
    p.embedding_status,
    p.created_at,
    p.conference_id,
    c.name      AS conference_name,
    c.acronym   AS conference_acronym,
    c.year      AS conference_year,
    c.location  AS conference_location,
    coalesce(au.authors, '')                 AS authors,
    coalesce(au.author_list, ARRAY[]::TEXT[]) AS author_list
FROM papers p
LEFT JOIN conferences c ON c.conference_id = p.conference_id
LEFT JOIN LATERAL (
    SELECT string_agg(a.name, ', ' ORDER BY pa.author_order) AS authors,
           array_agg(a.name ORDER BY pa.author_order)        AS author_list
    FROM paper_authors pa
    JOIN authors a ON a.author_id = pa.author_id
    WHERE pa.paper_id = p.paper_id
) au ON true;


-- ---------------------------------------------------------------------
-- v_top_cited_papers: papers ranked by citation_count.
-- RANK() is a window function: equal counts share a rank (1, 2, 2, 4).
-- The API adds LIMIT 10. Reading the trigger-maintained counter makes
-- this cheap, with no COUNT(*) over citations.
-- ---------------------------------------------------------------------
CREATE VIEW v_top_cited_papers AS
SELECT
    RANK() OVER (ORDER BY d.citation_count DESC) AS rank,
    d.paper_id,
    d.title,
    d.year,
    d.conference_name,
    d.authors,
    d.citation_count
FROM v_paper_details d
ORDER BY d.citation_count DESC, d.paper_id;


-- ---------------------------------------------------------------------
-- v_papers_per_year: publication trend for the dashboard chart.
-- ---------------------------------------------------------------------
CREATE VIEW v_papers_per_year AS
SELECT
    year,
    count(*)                              AS paper_count,
    sum(citation_count)                   AS total_citations,
    round(avg(citation_count), 2)         AS avg_citations
FROM papers
WHERE year IS NOT NULL
GROUP BY year
ORDER BY year;


-- ---------------------------------------------------------------------
-- v_author_stats: productivity and impact per author.
-- LEFT JOINs keep authors with no papers (shown with 0, not dropped).
-- total_citations = citations received by all of the author's papers.
-- ---------------------------------------------------------------------
CREATE VIEW v_author_stats AS
SELECT
    a.author_id,
    a.name,
    a.affiliation,
    count(p.paper_id)                     AS paper_count,
    coalesce(sum(p.citation_count), 0)    AS total_citations,
    min(p.year)                           AS first_year,
    max(p.year)                           AS last_year
FROM authors a
LEFT JOIN paper_authors pa ON pa.author_id = a.author_id
LEFT JOIN papers p         ON p.paper_id = pa.paper_id
GROUP BY a.author_id, a.name, a.affiliation;


-- ---------------------------------------------------------------------
-- v_conference_stats: size and impact of each conference edition.
-- ---------------------------------------------------------------------
CREATE VIEW v_conference_stats AS
SELECT
    c.conference_id,
    c.name,
    c.acronym,
    c.year,
    c.location,
    count(p.paper_id)                           AS paper_count,
    coalesce(sum(p.citation_count), 0)          AS total_citations,
    coalesce(round(avg(p.citation_count), 2), 0) AS avg_citations
FROM conferences c
LEFT JOIN papers p ON p.conference_id = c.conference_id
GROUP BY c.conference_id, c.name, c.acronym, c.year, c.location;
