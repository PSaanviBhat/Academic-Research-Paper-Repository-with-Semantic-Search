-- =====================================================================
-- Query-plan evidence: the same queries WITH and WITHOUT their index.
-- Each index is dropped inside a transaction and the transaction is
-- ROLLED BACK, so the index comes back untouched afterwards.
--
-- Run (needs the OpenAlex data loaded):
--   bash scripts/psql.sh -f /db/evidence/explain_indexes.sql
-- =====================================================================
\pset footer off
ANALYZE;   -- fresh table statistics, so the planner's estimates are realistic

-- The most-cited paper, used for the "cited by" lookups below.
SELECT paper_id AS top_id FROM papers ORDER BY citation_count DESC, paper_id LIMIT 1 \gset

-- Average time of a query over n runs, in milliseconds (temporary helper).
CREATE FUNCTION pg_temp.avg_ms(p_sql TEXT, p_runs INT DEFAULT 20) RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE t0 TIMESTAMPTZ; total INTERVAL := '0';
BEGIN
    FOR i IN 1..p_runs LOOP
        t0 := clock_timestamp();
        EXECUTE p_sql;
        total := total + (clock_timestamp() - t0);
    END LOOP;
    RETURN round((extract(epoch FROM total) * 1000 / p_runs)::NUMERIC, 3);
END $$;

\echo '##### 1. Keyword search WITH the GIN index on search_tsv #####'
-- Warm-up run so both measurements read from memory, not disk.
SELECT count(*) FROM papers WHERE search_tsv @@ websearch_to_tsquery('english', 'neural machine translation');
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT paper_id, ts_rank_cd(search_tsv, q) AS score
FROM papers, websearch_to_tsquery('english', 'neural machine translation') AS q
WHERE search_tsv @@ q
ORDER BY score DESC
LIMIT 10;

\echo '##### 2. Same keyword search WITHOUT the GIN index #####'
BEGIN;
DROP INDEX idx_papers_search_tsv;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT paper_id, ts_rank_cd(search_tsv, q) AS score
FROM papers, websearch_to_tsquery('english', 'neural machine translation') AS q
WHERE search_tsv @@ q
ORDER BY score DESC
LIMIT 10;
ROLLBACK;

\echo '##### 3. "Cited by" lookup WITH the B-tree index on citations(cited_paper_id) #####'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT citing_paper_id FROM citations
WHERE cited_paper_id = :top_id;

\echo '##### 4. Same lookup WITHOUT that index #####'
BEGIN;
DROP INDEX idx_citations_cited_paper_id;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT citing_paper_id FROM citations
WHERE cited_paper_id = :top_id;
ROLLBACK;


\echo '##### 5. Average time over 20 runs, with and without each index #####'
CREATE TEMP TABLE timings (query TEXT, with_index_ms NUMERIC, without_index_ms NUMERIC);
\set q_common 'SELECT paper_id FROM papers, websearch_to_tsquery(''english'', ''neural machine translation'') q WHERE search_tsv @@ q ORDER BY ts_rank_cd(search_tsv, q) DESC LIMIT 10'
\set q_rare 'SELECT paper_id FROM papers, websearch_to_tsquery(''english'', ''coreference resolution'') q WHERE search_tsv @@ q ORDER BY ts_rank_cd(search_tsv, q) DESC LIMIT 10'
\set q_cited 'SELECT citing_paper_id FROM citations WHERE cited_paper_id = ' :top_id
INSERT INTO timings VALUES ('keyword: "neural machine translation"', pg_temp.avg_ms(:'q_common'), NULL),
                           ('keyword: "coreference resolution"',    pg_temp.avg_ms(:'q_rare'), NULL),
                           ('cited-by lookup (most-cited paper)',   pg_temp.avg_ms(:'q_cited'), NULL);
BEGIN;
DROP INDEX idx_papers_search_tsv;
DROP INDEX idx_citations_cited_paper_id;
-- Keep the results in psql variables (\gset): anything written to a table
-- here would be undone by the ROLLBACK together with the DROP INDEX.
SELECT pg_temp.avg_ms(:'q_common') AS wo_common, pg_temp.avg_ms(:'q_rare') AS wo_rare,
       pg_temp.avg_ms(:'q_cited') AS wo_cited \gset
ROLLBACK;
UPDATE timings SET without_index_ms = :wo_common WHERE query LIKE '%neural%';
UPDATE timings SET without_index_ms = :wo_rare   WHERE query LIKE '%coreference%';
UPDATE timings SET without_index_ms = :wo_cited  WHERE query LIKE 'cited-by%';
SELECT query, with_index_ms, without_index_ms,
       round(without_index_ms / nullif(with_index_ms, 0), 1) || 'x' AS speed_up
FROM timings;
SELECT count(*) AS matches_coreference FROM papers WHERE search_tsv @@ websearch_to_tsquery('english', 'coreference resolution');

\echo '##### Indexes still present afterwards #####'
SELECT indexname FROM pg_indexes
WHERE indexname IN ('idx_papers_search_tsv', 'idx_citations_cited_paper_id') ORDER BY 1;
