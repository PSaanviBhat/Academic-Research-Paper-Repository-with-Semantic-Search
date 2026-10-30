-- =====================================================================
-- Index tests
-- 1. Every planned index exists, with the right access method.
-- 2. The planner can actually USE each one (checked with EXPLAIN while
--    sequential scans are switched off, because on a tiny test table a
--    full scan would otherwise always be cheaper).
-- Real timings on the full dataset are in docs/explain_evidence.md.
--
-- Run:  bash scripts/run_tests.sh
-- =====================================================================

\echo
\echo '=== INDEX TESTS ==='

BEGIN;
\o /dev/null
-- Start from empty tables so the result is the same on an empty or a fully
-- loaded database. TRUNCATE is transactional in PostgreSQL: the ROLLBACK at
-- the end brings every real row back.
TRUNCATE users, conferences, papers, authors, audit_log CASCADE;

-- Does the named index exist, using the expected method (gin / btree)?
CREATE FUNCTION pg_temp.index_method(p_index TEXT) RETURNS TEXT
LANGUAGE sql AS $$
    SELECT am.amname::TEXT
    FROM pg_class c JOIN pg_am am ON am.oid = c.relam
    WHERE c.relname = p_index AND c.relkind = 'i'
$$;

-- Does the plan for this query mention the given index?
CREATE FUNCTION pg_temp.plan_uses(p_sql TEXT, p_index TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
    v_line TEXT;
    v_found BOOLEAN := false;
BEGIN
    FOR v_line IN EXECUTE 'EXPLAIN ' || p_sql LOOP
        IF position(p_index IN v_line) > 0 THEN v_found := true; END IF;
    END LOOP;
    RETURN v_found;
END $$;

SELECT pg_temp.expect_eq('exists: GIN on papers.search_tsv',          pg_temp.index_method('idx_papers_search_tsv'), 'gin');
SELECT pg_temp.expect_eq('exists: B-tree on papers.year',             pg_temp.index_method('idx_papers_year'), 'btree');
SELECT pg_temp.expect_eq('exists: B-tree on papers.conference_id',    pg_temp.index_method('idx_papers_conference_id'), 'btree');
SELECT pg_temp.expect_eq('exists: B-tree on citations.cited_paper_id', pg_temp.index_method('idx_citations_cited_paper_id'), 'btree');
SELECT pg_temp.expect_eq('exists: B-tree on paper_authors.author_id', pg_temp.index_method('idx_paper_authors_author_id'), 'btree');
SELECT pg_temp.expect_eq('exists: trigram GIN on authors.name',       pg_temp.index_method('idx_authors_name_trgm'), 'gin');
SELECT pg_temp.expect_eq('extension pg_trgm installed',
  (SELECT count(*) FROM pg_extension WHERE extname = 'pg_trgm'), 1::BIGINT);

-- Force index use where possible so we can see that each index is usable.
SET LOCAL enable_seqscan = off;

SELECT pg_temp.expect_eq('planner uses GIN for keyword search',
  pg_temp.plan_uses($$SELECT paper_id FROM papers
                      WHERE search_tsv @@ websearch_to_tsquery('english', 'neural translation')$$,
                    'idx_papers_search_tsv'), true);
SELECT pg_temp.expect_eq('planner uses year index for year filter',
  pg_temp.plan_uses($$SELECT paper_id FROM papers WHERE year = 2020$$, 'idx_papers_year'), true);
SELECT pg_temp.expect_eq('planner uses conference index',
  pg_temp.plan_uses($$SELECT paper_id FROM papers WHERE conference_id = 1$$, 'idx_papers_conference_id'), true);
SELECT pg_temp.expect_eq('planner uses cited_paper_id index for cited-by',
  pg_temp.plan_uses($$SELECT citing_paper_id FROM citations WHERE cited_paper_id = 1$$,
                    'idx_citations_cited_paper_id'), true);
SELECT pg_temp.expect_eq('planner uses author_id index for author papers',
  pg_temp.plan_uses($$SELECT paper_id FROM paper_authors WHERE author_id = 1$$,
                    'idx_paper_authors_author_id'), true);
SELECT pg_temp.expect_eq('planner uses trigram index for name search',
  pg_temp.plan_uses($$SELECT author_id FROM authors WHERE name ILIKE '%vaswan%'$$,
                    'idx_authors_name_trgm'), true);

\o
SELECT * FROM pg_temp.report();
SELECT pg_temp.summary() AS summary;

ROLLBACK;
