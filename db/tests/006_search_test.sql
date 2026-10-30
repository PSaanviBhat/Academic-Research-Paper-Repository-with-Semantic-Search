-- =====================================================================
-- Keyword search tests on the small seed (6 papers).
--
-- Run:  bash scripts/run_tests.sh
-- =====================================================================

\echo
\echo '=== KEYWORD SEARCH TESTS ==='

BEGIN;
\o /dev/null
-- Start from empty tables so the result is the same on an empty or a fully
-- loaded database. TRUNCATE is transactional in PostgreSQL: the ROLLBACK at
-- the end brings every real row back.
TRUNCATE users, conferences, papers, authors, audit_log CASCADE;
\i /db/seed/test_seed.sql

SELECT pg_temp.expect_eq('finds a paper by a title word (stemming: "translations")',
  (SELECT left(title, 2) FROM search_papers_keyword('translations')), 'P4');
SELECT pg_temp.expect_eq('title match ranks above abstract-only match',
  (SELECT left(title, 2) FROM search_papers_keyword('retrieval') LIMIT 1), 'P3');
SELECT pg_temp.expect_eq('total counts all matches, not just the page',
  (SELECT DISTINCT total FROM search_papers_keyword('language', NULL, 1, 0)),
  (SELECT count(*) FROM papers WHERE search_tsv @@ websearch_to_tsquery('english', 'language')));
SELECT pg_temp.expect_eq('page size is respected',
  (SELECT count(*) FROM search_papers_keyword('language', NULL, 1, 0)), 1::BIGINT);
SELECT pg_temp.expect_eq('second page continues where the first stopped',
  (SELECT paper_id FROM search_papers_keyword('language', NULL, 1, 1)),
  (SELECT paper_id FROM search_papers_keyword('language', NULL, 2, 0) OFFSET 1));
SELECT pg_temp.expect_eq('year filter',
  (SELECT array_agg(DISTINCT year) FROM search_papers_keyword('language', 2019)), ARRAY[2019]);
SELECT pg_temp.expect_eq('quoted phrase must appear as a phrase',
  (SELECT count(*) FROM search_papers_keyword('"machine translation"')), 1::BIGINT);
SELECT pg_temp.expect_eq('minus excludes a word',
  (SELECT count(*) FROM search_papers_keyword('language -survey')),
  (SELECT count(*) FROM search_papers_keyword('language')) - 1);
SELECT pg_temp.expect_eq('no match returns no rows',
  (SELECT count(*) FROM search_papers_keyword('quantum chromodynamics')), 0::BIGINT);
SELECT pg_temp.expect_eq('odd input is not a syntax error',
  (SELECT count(*) >= 0 FROM search_papers_keyword('((( & | !')), true);
SELECT pg_temp.expect_eq('authors returned as an ordered array',
  (SELECT authors FROM search_papers_keyword('bidirectional')), ARRAY['Ben Carter', 'Asha Rao']);
SELECT pg_temp.expect_eq('snippet is plain text from the abstract',
  (SELECT abstract_snippet LIKE '%Siamese%' AND abstract_snippet NOT LIKE '%<b>%'
     FROM search_papers_keyword('siamese')), true);
SELECT pg_temp.expect_eq('scores are in descending order',
  (SELECT bool_and(score >= next_score) FROM (
     SELECT score, lead(score, 1, 0) OVER () AS next_score FROM search_papers_keyword('language')) s), true);

\o
\echo
\echo 'Example: search_papers_keyword(''language models'')'
SELECT paper_id, left(title, 45) AS title, year, conference, citation_count AS cites,
       round(score::NUMERIC, 4) AS score, total
FROM search_papers_keyword('language models');

SELECT * FROM pg_temp.report();
SELECT pg_temp.summary() AS summary;

ROLLBACK;
