-- =====================================================================
-- 006_search.sql : keyword (full-text) search
--
-- search_papers_keyword(q, year, limit, offset) returns one page of
-- results in exactly the shape the API sends back, plus the total number
-- of matches for pagination.
--
--   websearch_to_tsquery  turns what the user typed into a tsquery, the
--                         same way a web search box does, and never
--                         raises a syntax error on odd input:
--                           neural translation      -> neural & translat
--                           "machine translation"   -> machin <-> translat (phrase)
--                           bert -roberta           -> bert & !roberta
--                           bert or gpt             -> bert | gpt
--   @@                    "does this paper's search_tsv match the query?"
--                         This is what the GIN index on search_tsv speeds up.
--   ts_rank_cd            relevance score (cover density): higher when the
--                         query words appear, appear close together, and
--                         appear in the title (weight A) rather than only in
--                         the abstract (weight B).
--   count(*) OVER ()      a window function: the total number of matches,
--                         computed before LIMIT/OFFSET cut out the page.
-- =====================================================================

CREATE FUNCTION search_papers_keyword(
    p_query   TEXT,
    p_year    INT DEFAULT NULL,
    p_limit   INT DEFAULT 10,
    p_offset  INT DEFAULT 0
) RETURNS TABLE (
    paper_id          INT,
    title             TEXT,
    abstract_snippet  TEXT,
    year              INT,
    conference        TEXT,
    authors           TEXT[],
    citation_count    INT,
    score             REAL,
    total             BIGINT
)
LANGUAGE sql STABLE AS $$
    WITH q AS (
        SELECT websearch_to_tsquery('english', p_query) AS query
    ),
    page AS (
        SELECT p.paper_id,
               ts_rank_cd(p.search_tsv, q.query) AS score,
               count(*) OVER () AS total
        FROM papers p, q
        WHERE p.search_tsv @@ q.query
          AND (p_year IS NULL OR p.year = p_year)
        -- Ties on relevance: more-cited papers first, then a stable order.
        ORDER BY score DESC, p.citation_count DESC, p.paper_id
        LIMIT p_limit OFFSET p_offset
    )
    SELECT d.paper_id,
           d.title,
           -- The most relevant ~35-word passage of the abstract, without markup.
           -- Only computed for the rows on this page, so it stays cheap.
           ts_headline('english', coalesce(d.abstract, ''), q.query,
                       'MaxWords=35, MinWords=20, MaxFragments=1, StartSel="", StopSel=""'),
           d.year,
           d.conference_name,
           d.author_list,
           d.citation_count,
           page.score,
           page.total
    FROM page
    JOIN v_paper_details d ON d.paper_id = page.paper_id
    CROSS JOIN q
    ORDER BY page.score DESC, d.citation_count DESC, d.paper_id
$$;
