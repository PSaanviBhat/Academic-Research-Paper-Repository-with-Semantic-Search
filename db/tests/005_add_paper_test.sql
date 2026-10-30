-- =====================================================================
-- add_paper() transaction demo
--
--   Part 1: a successful call adds the paper, authors and citations
--           together, and the paper starts as 'pending'.
--   Part 2: a call that cites a paper which does not exist fails, and
--           NOTHING from that call is left behind (not even the new author
--           it created before reaching the bad citation).
--
-- Run:  bash scripts/run_tests.sh
-- =====================================================================

\echo
\echo '=== add_paper() TRANSACTION TESTS ==='

BEGIN;
\o /dev/null
-- Start from empty tables so the result is the same on an empty or a fully
-- loaded database. TRUNCATE is transactional in PostgreSQL: the ROLLBACK at
-- the end brings every real row back.
TRUNCATE users, conferences, papers, authors, audit_log CASCADE;
\i /db/seed/test_seed.sql

-- Row counts of every table add_paper() writes to.
CREATE FUNCTION pg_temp.row_counts() RETURNS TABLE (papers BIGINT, authors BIGINT, paper_authors BIGINT, citations BIGINT)
LANGUAGE sql AS $$
    SELECT (SELECT count(*) FROM papers), (SELECT count(*) FROM authors),
           (SELECT count(*) FROM paper_authors), (SELECT count(*) FROM citations)
$$;
CREATE TEMP TABLE counts_log (n SERIAL, moment TEXT, papers BIGINT, authors BIGINT, paper_authors BIGINT, citations BIGINT);

CREATE FUNCTION pg_temp.pid(p_prefix TEXT) RETURNS INT
LANGUAGE sql AS $$ SELECT paper_id FROM papers WHERE title LIKE p_prefix || ' %' $$;

-- =====================================================================
-- Part 1: success
-- =====================================================================
INSERT INTO counts_log (moment, papers, authors, paper_authors, citations)
SELECT 'Part 1: before successful call', * FROM pg_temp.row_counts();

SELECT add_paper(
    'Retrieval-Augmented Generation for Scientific Question Answering',
    'We combine a dense retriever with a sequence-to-sequence generator to answer questions about research papers.',
    2024,
    'https://doi.org/10.5555/NEW.1',              -- will be normalised
    (SELECT conference_id FROM conferences WHERE acronym = 'ACL'),
    '[{"name": "Asha Rao",   "affiliation": "Indian Institute of Science"},
      {"name": "Gita Menon", "affiliation": "PES University"}]'::jsonb,
    ARRAY[pg_temp.pid('P1'), pg_temp.pid('P3')]
) AS new_id \gset

INSERT INTO counts_log (moment, papers, authors, paper_authors, citations)
SELECT 'Part 1: after successful call', * FROM pg_temp.row_counts();

SELECT pg_temp.expect_eq('success: returns the new paper_id',
  (SELECT title FROM papers WHERE paper_id = :new_id),
  'Retrieval-Augmented Generation for Scientific Question Answering');
SELECT pg_temp.expect_eq('success: embedding_status is pending',
  (SELECT embedding_status FROM papers WHERE paper_id = :new_id), 'pending');
SELECT pg_temp.expect_eq('success: DOI normalised',
  (SELECT doi FROM papers WHERE paper_id = :new_id), '10.5555/new.1');
SELECT pg_temp.expect_eq('success: authors linked in order',
  (SELECT authors FROM v_paper_details WHERE paper_id = :new_id), 'Asha Rao, Gita Menon');
SELECT pg_temp.expect_eq('success: existing author reused, only 1 new author',
  (SELECT count(*) FROM authors WHERE name IN ('Asha Rao', 'Gita Menon')), 2::BIGINT);
SELECT pg_temp.expect_eq('success: 2 citations stored',
  (SELECT count(*) FROM citations WHERE citing_paper_id = :new_id), 2::BIGINT);
SELECT pg_temp.expect_eq('success: trigger raised P1 count 4 -> 5',
  (SELECT citation_count FROM papers WHERE paper_id = pg_temp.pid('P1')), 5);
SELECT pg_temp.expect_eq('success: trigger raised P3 count 2 -> 3',
  (SELECT citation_count FROM papers WHERE paper_id = pg_temp.pid('P3')), 3);

-- =====================================================================
-- Part 2: deliberate failure
-- Author "Brand New Author" is created first (step 3 of the function),
-- then the citation to paper 999999 breaks the foreign key (step 4).
-- The whole call must be undone, including that new author.
-- =====================================================================
INSERT INTO counts_log (moment, papers, authors, paper_authors, citations)
SELECT 'Part 2: before failing call', * FROM pg_temp.row_counts();

SELECT pg_temp.expect_error('failure: citing a paper that does not exist is rejected',
  $$SELECT add_paper('This paper should never appear', 'Abstract', 2024, '10.5555/fail.1', NULL,
                     '[{"name": "Brand New Author"}]'::jsonb,
                     ARRAY[(SELECT paper_id FROM papers WHERE title LIKE 'P1 %'), 999999])$$,
  '23503');

INSERT INTO counts_log (moment, papers, authors, paper_authors, citations)
SELECT 'Part 2: after failing call', * FROM pg_temp.row_counts();

SELECT pg_temp.expect_eq('rollback: paper not inserted',
  (SELECT count(*) FROM papers WHERE title = 'This paper should never appear'), 0::BIGINT);
SELECT pg_temp.expect_eq('rollback: new author not left behind',
  (SELECT count(*) FROM authors WHERE name = 'Brand New Author'), 0::BIGINT);
SELECT pg_temp.expect_eq('rollback: P1 citation_count unchanged (5)',
  (SELECT citation_count FROM papers WHERE paper_id = pg_temp.pid('P1')), 5);
SELECT pg_temp.expect_eq('rollback: all row counts identical before and after',
  (SELECT (papers, authors, paper_authors, citations)::TEXT FROM counts_log WHERE moment = 'Part 2: after failing call'),
  (SELECT (papers, authors, paper_authors, citations)::TEXT FROM counts_log WHERE moment = 'Part 2: before failing call'));

-- Other failures are rolled back the same way
SELECT pg_temp.expect_error('failure: duplicate DOI',
  $$SELECT add_paper('Copy', NULL, 2024, '10.5555/seed.1', NULL, '[{"name": "X"}]'::jsonb)$$, '23505');
SELECT pg_temp.expect_error('failure: no authors',
  $$SELECT add_paper('No authors', NULL, 2024, NULL, NULL, '[]'::jsonb)$$, '22023');
SELECT pg_temp.expect_error('failure: blank author name',
  $$SELECT add_paper('Blank author', NULL, 2024, NULL, NULL, '[{"name": "A"}, {"name": "  "}]'::jsonb)$$, '22023');
SELECT pg_temp.expect_error('failure: blank title',
  $$SELECT add_paper('   ', NULL, 2024, NULL, NULL, '[{"name": "A"}]'::jsonb)$$, '22023');
SELECT pg_temp.expect_error('failure: conference that does not exist',
  $$SELECT add_paper('Bad conf', NULL, 2024, NULL, 999999, '[{"name": "A"}]'::jsonb)$$, '23503');
SELECT pg_temp.expect_eq('rollback: none of the failed calls left a paper',
  (SELECT count(*) FROM papers), (SELECT papers FROM counts_log WHERE moment = 'Part 2: before failing call'));

\o
\echo
\echo 'Part 1: the paper added by add_paper():'
SELECT paper_id, left(title, 45) AS title, doi, conference_acronym AS conf, authors, embedding_status
FROM v_paper_details WHERE paper_id = :new_id;
\echo 'Part 1: its citations (citation_count of the cited papers went up via the trigger):'
SELECT c.citing_paper_id, c.cited_paper_id, left(p.title, 45) AS cited_title, p.citation_count
FROM citations c JOIN papers p ON p.paper_id = c.cited_paper_id
WHERE c.citing_paper_id = :new_id ORDER BY c.cited_paper_id;
\echo 'Row counts around each call (Part 2: the failed call changed nothing):'
SELECT moment, papers, authors, paper_authors, citations FROM counts_log ORDER BY n;

SELECT * FROM pg_temp.report();
SELECT pg_temp.summary() AS summary;

ROLLBACK;
