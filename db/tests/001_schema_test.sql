-- =====================================================================
-- Schema constraint tests
-- Inserts a few valid rows, then tries to break every rule in the schema.
-- Each bad row must be rejected with the right kind of error.
-- Everything runs in one transaction that is ROLLED BACK at the end,
-- so the database is left exactly as it was.
--
-- Run:  bash scripts/run_tests.sh
-- or:   cat db/tests/_helpers.sql db/tests/001_schema_test.sql | bash scripts/psql.sh
-- =====================================================================

\echo
\echo '=== SCHEMA CONSTRAINT TESTS ==='

BEGIN;
\o /dev/null

-- ---------- valid sample data ----------
INSERT INTO users (name, email, password_hash)
VALUES ('Test Researcher', 'researcher@test.com', 'hash');

INSERT INTO conferences (name, acronym, year, location)
VALUES ('Test Conference on NLP', 'TCNLP', 2024, 'Bengaluru');

INSERT INTO papers (title, abstract, year, doi, conference_id, openalex_id)
VALUES ('Transformers for language understanding',
        'We study attention-based models for text.',
        2024, '10.1000/p1',
        (SELECT conference_id FROM conferences WHERE acronym = 'TCNLP'),
        'W1'),
       ('Graph neural networks', 'Message passing on graphs.', 2023, '10.1000/p2', NULL, 'W2');

INSERT INTO authors (name, affiliation) VALUES ('Author One', 'PES University'), ('Author Two', NULL);

INSERT INTO paper_authors (paper_id, author_id, author_order)
SELECT p.paper_id, a.author_id, 1
FROM papers p, authors a WHERE p.doi = '10.1000/p1' AND a.name = 'Author One';

-- p2 cites p1
INSERT INTO citations (citing_paper_id, cited_paper_id)
SELECT (SELECT paper_id FROM papers WHERE doi = '10.1000/p2'),
       (SELECT paper_id FROM papers WHERE doi = '10.1000/p1');

INSERT INTO bookmarks (user_id, paper_id)
SELECT (SELECT user_id FROM users WHERE email = 'researcher@test.com'),
       (SELECT paper_id FROM papers WHERE doi = '10.1000/p1');

-- ---------- users ----------
SELECT pg_temp.expect_error('users: duplicate email',
  $$INSERT INTO users (name, email, password_hash) VALUES ('X', 'researcher@test.com', 'h')$$, '23505');
SELECT pg_temp.expect_error('users: uppercase email (case duplicate)',
  $$INSERT INTO users (name, email, password_hash) VALUES ('X', 'Researcher@test.com', 'h')$$, '23514');
SELECT pg_temp.expect_error('users: role not researcher/admin',
  $$INSERT INTO users (name, email, password_hash, role) VALUES ('X', 'x@test.com', 'h', 'superuser')$$, '23514');
SELECT pg_temp.expect_error('users: missing password_hash',
  $$INSERT INTO users (name, email) VALUES ('X', 'y@test.com')$$, '23502');
SELECT pg_temp.expect_error('users: missing email',
  $$INSERT INTO users (name, password_hash) VALUES ('X', 'h')$$, '23502');

-- ---------- conferences ----------
SELECT pg_temp.expect_error('conferences: duplicate (name, year)',
  $$INSERT INTO conferences (name, year) VALUES ('Test Conference on NLP', 2024)$$, '23505');
SELECT pg_temp.expect_ok('conferences: same name, different year is fine',
  $$INSERT INTO conferences (name, year) VALUES ('Test Conference on NLP', 2025)$$);
SELECT pg_temp.expect_ok('conferences: name with unknown year',
  $$INSERT INTO conferences (name) VALUES ('Workshop X')$$);
SELECT pg_temp.expect_error('conferences: same name + unknown year again',
  $$INSERT INTO conferences (name) VALUES ('Workshop X')$$, '23505');

-- ---------- papers ----------
SELECT pg_temp.expect_error('papers: missing title',
  $$INSERT INTO papers (abstract) VALUES ('no title')$$, '23502');
SELECT pg_temp.expect_error('papers: blank title',
  $$INSERT INTO papers (title) VALUES ('   ')$$, '23514');
SELECT pg_temp.expect_error('papers: negative citation_count',
  $$INSERT INTO papers (title, citation_count) VALUES ('Bad count', -1)$$, '23514');
SELECT pg_temp.expect_error('papers: unknown embedding_status',
  $$INSERT INTO papers (title, embedding_status) VALUES ('Bad status', 'processing')$$, '23514');
SELECT pg_temp.expect_error('papers: duplicate DOI',
  $$INSERT INTO papers (title, doi) VALUES ('Copy', '10.1000/p1')$$, '23505');
SELECT pg_temp.expect_error('papers: malformed DOI',
  $$INSERT INTO papers (title, doi) VALUES ('Bad DOI', 'https://doi.org/10.1/x')$$, '23514');
SELECT pg_temp.expect_error('papers: year out of range',
  $$INSERT INTO papers (title, year) VALUES ('Old', 1800)$$, '23514');
SELECT pg_temp.expect_error('papers: conference that does not exist',
  $$INSERT INTO papers (title, conference_id) VALUES ('Orphan', 999999)$$, '23503');
SELECT pg_temp.expect_error('papers: duplicate openalex_id',
  $$INSERT INTO papers (title, openalex_id) VALUES ('Copy', 'W1')$$, '23505');

-- ---------- paper_authors ----------
SELECT pg_temp.expect_error('paper_authors: same author twice on a paper',
  $$INSERT INTO paper_authors SELECT p.paper_id, a.author_id, 2
    FROM papers p, authors a WHERE p.doi = '10.1000/p1' AND a.name = 'Author One'$$, '23505');
SELECT pg_temp.expect_error('paper_authors: two authors in the same position',
  $$INSERT INTO paper_authors SELECT p.paper_id, a.author_id, 1
    FROM papers p, authors a WHERE p.doi = '10.1000/p1' AND a.name = 'Author Two'$$, '23505');
SELECT pg_temp.expect_error('paper_authors: author_order 0',
  $$INSERT INTO paper_authors SELECT p.paper_id, a.author_id, 0
    FROM papers p, authors a WHERE p.doi = '10.1000/p2' AND a.name = 'Author Two'$$, '23514');
SELECT pg_temp.expect_error('paper_authors: author that does not exist',
  $$INSERT INTO paper_authors SELECT paper_id, 999999, 1 FROM papers WHERE doi = '10.1000/p2'$$, '23503');

-- ---------- citations ----------
SELECT pg_temp.expect_error('citations: paper cites itself',
  $$INSERT INTO citations SELECT paper_id, paper_id FROM papers WHERE doi = '10.1000/p1'$$, '23514');
SELECT pg_temp.expect_error('citations: same citation twice',
  $$INSERT INTO citations SELECT (SELECT paper_id FROM papers WHERE doi = '10.1000/p2'),
                                 (SELECT paper_id FROM papers WHERE doi = '10.1000/p1')$$, '23505');
SELECT pg_temp.expect_error('citations: cited paper does not exist',
  $$INSERT INTO citations SELECT paper_id, 999999 FROM papers WHERE doi = '10.1000/p1'$$, '23503');

-- ---------- bookmarks ----------
SELECT pg_temp.expect_error('bookmarks: same paper bookmarked twice',
  $$INSERT INTO bookmarks (user_id, paper_id)
    SELECT (SELECT user_id FROM users WHERE email = 'researcher@test.com'),
           (SELECT paper_id FROM papers WHERE doi = '10.1000/p1')$$, '23505');

-- ---------- defaults and generated column ----------
SELECT pg_temp.expect_eq('papers: new paper starts as pending',
  (SELECT embedding_status FROM papers WHERE doi = '10.1000/p2'), 'pending');
SELECT pg_temp.expect_eq('papers: citation_count defaults to 0',
  (SELECT citation_count FROM papers WHERE doi = '10.1000/p2'), 0);
SELECT pg_temp.expect_eq('search_tsv: title words have weight A',
  (SELECT ts_filter(search_tsv, '{a}') @@ to_tsquery('english', 'transformers')
     FROM papers WHERE doi = '10.1000/p1'), true);
SELECT pg_temp.expect_eq('search_tsv: abstract words have weight B',
  (SELECT ts_filter(search_tsv, '{b}') @@ to_tsquery('english', 'attention')
     FROM papers WHERE doi = '10.1000/p1'), true);
UPDATE papers SET title = 'Diffusion models' WHERE doi = '10.1000/p2';
SELECT pg_temp.expect_eq('search_tsv: recomputed after title update',
  (SELECT search_tsv @@ to_tsquery('english', 'diffusion') FROM papers WHERE doi = '10.1000/p2'), true);

-- ---------- referential actions ----------
DELETE FROM conferences WHERE acronym = 'TCNLP';
SELECT pg_temp.expect_eq('delete conference: paper kept, conference_id set to NULL',
  (SELECT conference_id IS NULL FROM papers WHERE doi = '10.1000/p1'), true);

DELETE FROM papers WHERE doi = '10.1000/p1';
SELECT pg_temp.expect_eq('delete paper: author links cascaded',
  (SELECT count(*) FROM paper_authors pa
     WHERE NOT EXISTS (SELECT 1 FROM papers p WHERE p.paper_id = pa.paper_id)), 0::BIGINT);
SELECT pg_temp.expect_eq('delete paper: citations cascaded',
  (SELECT count(*) FROM citations), 0::BIGINT);
SELECT pg_temp.expect_eq('delete paper: bookmarks cascaded',
  (SELECT count(*) FROM bookmarks), 0::BIGINT);
SELECT pg_temp.expect_eq('delete paper: the author row itself is kept',
  (SELECT count(*) FROM authors WHERE name = 'Author One'), 1::BIGINT);

-- ---------- structure ----------
SELECT pg_temp.expect_eq('all 8 tables exist',
  (SELECT count(*) FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       AND table_name IN ('users', 'conferences', 'papers', 'authors', 'paper_authors',
                          'citations', 'bookmarks', 'audit_log')), 8::BIGINT);

\o
SELECT * FROM pg_temp.report();
SELECT pg_temp.summary() AS summary;

ROLLBACK;
