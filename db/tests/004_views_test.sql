-- =====================================================================
-- View tests: load the small seed (6 papers, 6 authors, 3 conferences,
-- 11 citations) and check that every view returns the expected rows.
--
-- Run:  bash scripts/run_tests.sh
-- =====================================================================

\echo
\echo '=== VIEW TESTS ==='

BEGIN;
\o /dev/null
-- Start from empty tables so the result is the same on an empty or a fully
-- loaded database. TRUNCATE is transactional in PostgreSQL: the ROLLBACK at
-- the end brings every real row back.
TRUNCATE users, conferences, papers, authors, audit_log CASCADE;
\i /db/seed/test_seed.sql

-- ---------- v_paper_details ----------
SELECT pg_temp.expect_eq('paper_details: one row per paper (joins add no duplicates)',
  (SELECT count(*) FROM v_paper_details), (SELECT count(*) FROM papers));
SELECT pg_temp.expect_eq('paper_details: authors joined in byline order',
  (SELECT authors FROM v_paper_details WHERE title LIKE 'P2 %'), 'Ben Carter, Asha Rao');
SELECT pg_temp.expect_eq('paper_details: author array in byline order',
  (SELECT author_list FROM v_paper_details WHERE title LIKE 'P4 %'),
  ARRAY['Divya Nair', 'Chen Wei', 'Elena Rossi']);
SELECT pg_temp.expect_eq('paper_details: conference name attached',
  (SELECT conference_acronym FROM v_paper_details WHERE title LIKE 'P3 %'), 'EMNLP');
SELECT pg_temp.expect_eq('paper_details: paper without conference still listed',
  (SELECT conference_name IS NULL FROM v_paper_details WHERE title LIKE 'P6 %'), true);

-- ---------- v_top_cited_papers ----------
SELECT pg_temp.expect_eq('top_cited: rank 1 is P1 with 4 citations',
  (SELECT left(title, 2) || ' / ' || citation_count FROM v_top_cited_papers WHERE rank = 1), 'P1 / 4');
SELECT pg_temp.expect_eq('top_cited: counts in descending order',
  (SELECT array_agg(citation_count) FROM (SELECT citation_count FROM v_top_cited_papers) t),
  ARRAY[4, 3, 2, 1, 1, 0]);
SELECT pg_temp.expect_eq('top_cited: ties share a rank (P4, P5 both rank 4)',
  (SELECT array_agg(rank ORDER BY title) FROM v_top_cited_papers WHERE citation_count = 1),
  ARRAY[4::BIGINT, 4::BIGINT]);

-- ---------- v_papers_per_year ----------
SELECT pg_temp.expect_eq('papers_per_year: 2017=1, 2019=2, 2020=3',
  (SELECT string_agg(year || '=' || paper_count, ', ' ORDER BY year) FROM v_papers_per_year),
  '2017=1, 2019=2, 2020=3');

-- ---------- v_author_stats ----------
SELECT pg_temp.expect_eq('author_stats: Asha Rao 3 papers, 7 citations',
  (SELECT paper_count || ' papers, ' || total_citations || ' citations'
     FROM v_author_stats WHERE name = 'Asha Rao'), '3 papers, 7 citations');
SELECT pg_temp.expect_eq('author_stats: author with no papers shows 0, not missing',
  (SELECT paper_count || '/' || total_citations FROM v_author_stats WHERE name = 'Farah Khan'), '0/0');

-- ---------- v_conference_stats ----------
SELECT pg_temp.expect_eq('conference_stats: ACL 2019 has 2 papers, 4 citations',
  (SELECT paper_count || ' papers, ' || total_citations || ' citations'
     FROM v_conference_stats WHERE acronym = 'ACL'), '2 papers, 4 citations');
SELECT pg_temp.expect_eq('conference_stats: one row per conference',
  (SELECT count(*) FROM v_conference_stats), 3::BIGINT);

\o
\echo
\echo 'v_paper_details:'
SELECT paper_id, left(title, 40) AS title, year, conference_acronym AS conf, authors, citation_count AS cites
FROM v_paper_details ORDER BY paper_id;
\echo 'v_top_cited_papers:'
SELECT rank, left(title, 40) AS title, year, citation_count AS cites FROM v_top_cited_papers;
\echo 'v_papers_per_year:'
SELECT * FROM v_papers_per_year;
\echo 'v_author_stats:'
SELECT name, affiliation, paper_count, total_citations, first_year, last_year
FROM v_author_stats ORDER BY total_citations DESC, name;
\echo 'v_conference_stats:'
SELECT acronym, year, location, paper_count, total_citations, avg_citations
FROM v_conference_stats ORDER BY total_citations DESC;

-- ---------- views follow live data ----------
\o /dev/null
DELETE FROM citations
WHERE citing_paper_id = (SELECT paper_id FROM papers WHERE title LIKE 'P6 %')
  AND cited_paper_id  = (SELECT paper_id FROM papers WHERE title LIKE 'P1 %');
SELECT pg_temp.expect_eq('views are live: P1 drops to 3 after a citation is removed',
  (SELECT citation_count FROM v_top_cited_papers WHERE title LIKE 'P1 %'), 3);
\o

SELECT * FROM pg_temp.report();
SELECT pg_temp.summary() AS summary;

ROLLBACK;
