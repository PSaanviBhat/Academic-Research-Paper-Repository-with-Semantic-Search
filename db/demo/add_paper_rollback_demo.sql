-- =====================================================================
-- Live viva demo: a failing add_paper() leaves nothing behind.
-- Unlike the test, the error is NOT caught here, so PostgreSQL prints its
-- real ERROR message. It runs on whatever data is loaded (the real OpenAlex
-- papers, or nothing) inside BEGIN ... ROLLBACK, so the database is unchanged
-- afterwards.
--
-- Run:  bash scripts/psql.sh -f /db/demo/add_paper_rollback_demo.sql
-- =====================================================================
\set ON_ERROR_STOP 0
\pset footer off
\set QUIET on

BEGIN;
\set QUIET off

\echo
\echo '1) Row counts BEFORE the call:'
SELECT (SELECT count(*) FROM papers) AS papers, (SELECT count(*) FROM authors) AS authors,
       (SELECT count(*) FROM paper_authors) AS paper_authors, (SELECT count(*) FROM citations) AS citations;

SAVEPOINT before_call;

\echo '2) Add a paper with a NEW author that cites a real paper AND paper 999999 (does not exist):'
SELECT add_paper('This paper should never appear', 'Abstract', 2024, '10.5555/demo.1', NULL,
                 '[{"name": "Brand New Author"}]'::jsonb,
                 ARRAY[(SELECT min(paper_id) FROM papers), 999999]);

\echo '3) The transaction is now aborted; undo the failed call:'
ROLLBACK TO SAVEPOINT before_call;

\echo '4) Row counts AFTER the failed call (identical: nothing was left behind):'
SELECT (SELECT count(*) FROM papers) AS papers, (SELECT count(*) FROM authors) AS authors,
       (SELECT count(*) FROM paper_authors) AS paper_authors, (SELECT count(*) FROM citations) AS citations;

\echo '5) Was "Brand New Author" (created before the bad citation) kept?'
SELECT count(*) AS brand_new_author_rows FROM authors WHERE name = 'Brand New Author';

ROLLBACK;
