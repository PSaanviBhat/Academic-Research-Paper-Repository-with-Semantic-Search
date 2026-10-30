-- =====================================================================
-- Trigger tests: citation_count maintenance and the delete audit log
--
-- Four papers A, B, C, D. Each step changes the citations and the
-- table at the end shows every paper's citation_count after each step.
--
-- Run:  bash scripts/run_tests.sh
-- =====================================================================

\echo
\echo '=== TRIGGER TESTS ==='

BEGIN;
\o /dev/null

INSERT INTO users (name, email, password_hash, role)
VALUES ('Test Admin', 'admin@test.com', 'hash', 'admin');

INSERT INTO papers (title) VALUES ('Paper A'), ('Paper B'), ('Paper C'), ('Paper D');

-- Shortcut: paper_id from the letter.
CREATE FUNCTION pg_temp.pid(p_letter TEXT) RETURNS INT
LANGUAGE sql AS $$ SELECT paper_id FROM papers WHERE title = 'Paper ' || p_letter $$;

-- Current counter for a paper (NULL once deleted).
CREATE FUNCTION pg_temp.cc(p_letter TEXT) RETURNS INT
LANGUAGE sql AS $$ SELECT citation_count FROM papers WHERE title = 'Paper ' || p_letter $$;

-- Snapshot of all four counters, printed as one table at the end.
CREATE TEMP TABLE snapshots (n SERIAL, step TEXT, a INT, b INT, c INT, d INT);
CREATE FUNCTION pg_temp.snap(p_step TEXT) RETURNS VOID
LANGUAGE sql AS $$
    INSERT INTO snapshots (step, a, b, c, d)
    VALUES (p_step, pg_temp.cc('A'), pg_temp.cc('B'), pg_temp.cc('C'), pg_temp.cc('D'))
$$;

-- Number of papers whose counter disagrees with COUNT(*) of citations.
CREATE FUNCTION pg_temp.mismatches() RETURNS BIGINT
LANGUAGE sql AS $$
    SELECT count(*) FROM papers p
    WHERE p.citation_count <> (SELECT count(*) FROM citations c WHERE c.cited_paper_id = p.paper_id)
$$;

SELECT pg_temp.snap('0. start');

-- 1. Insert citations one at a time: B->A, C->A, D->A, C->B
INSERT INTO citations VALUES (pg_temp.pid('B'), pg_temp.pid('A'));
INSERT INTO citations VALUES (pg_temp.pid('C'), pg_temp.pid('A'));
INSERT INTO citations VALUES (pg_temp.pid('D'), pg_temp.pid('A'));
INSERT INTO citations VALUES (pg_temp.pid('C'), pg_temp.pid('B'));
SELECT pg_temp.snap('1. insert B->A, C->A, D->A, C->B');
SELECT pg_temp.expect_eq('insert: A cited 3 times', pg_temp.cc('A'), 3);
SELECT pg_temp.expect_eq('insert: B cited once', pg_temp.cc('B'), 1);

-- 2. Delete one citation
DELETE FROM citations WHERE citing_paper_id = pg_temp.pid('D') AND cited_paper_id = pg_temp.pid('A');
SELECT pg_temp.snap('2. delete D->A');
SELECT pg_temp.expect_eq('delete: A drops to 2', pg_temp.cc('A'), 2);

-- 3. One INSERT with several rows: the row-level trigger counts each row
INSERT INTO citations VALUES (pg_temp.pid('D'), pg_temp.pid('B')), (pg_temp.pid('D'), pg_temp.pid('C'));
SELECT pg_temp.snap('3. multi-row insert D->B, D->C');
SELECT pg_temp.expect_eq('multi-row insert: B = 2', pg_temp.cc('B'), 2);
SELECT pg_temp.expect_eq('multi-row insert: C = 1', pg_temp.cc('C'), 1);

-- 4. Re-point a citation: C->B becomes C->D
UPDATE citations SET cited_paper_id = pg_temp.pid('D')
WHERE citing_paper_id = pg_temp.pid('C') AND cited_paper_id = pg_temp.pid('B');
SELECT pg_temp.snap('4. update C->B into C->D');
SELECT pg_temp.expect_eq('update: B loses one (1)', pg_temp.cc('B'), 1);
SELECT pg_temp.expect_eq('update: D gains one (1)', pg_temp.cc('D'), 1);

-- 5. Delete paper C as an admin. C cites A and D, and is cited by D.
--    ON DELETE CASCADE removes all three citation rows; the delete
--    trigger must fire for each one.
SELECT set_config('app.admin_id', (SELECT user_id FROM users WHERE email = 'admin@test.com')::TEXT, true);
SELECT pg_temp.pid('C') AS deleted_c \gset
DELETE FROM papers WHERE title = 'Paper C';
SELECT pg_temp.snap('5. admin deletes paper C (cascade)');
SELECT pg_temp.expect_eq('cascade: A loses C''s citation (1)', pg_temp.cc('A'), 1);
SELECT pg_temp.expect_eq('cascade: D loses C''s citation (0)', pg_temp.cc('D'), 0);
SELECT pg_temp.expect_eq('cascade: B unchanged (1)', pg_temp.cc('B'), 1);
SELECT pg_temp.expect_eq('cascade: no citation rows left for C',
  (SELECT count(*) FROM citations WHERE :deleted_c IN (citing_paper_id, cited_paper_id)), 0::BIGINT);
SELECT pg_temp.expect_eq('audit: one DELETE_PAPER row for C',
  (SELECT count(*) FROM audit_log WHERE action = 'DELETE_PAPER' AND paper_id = :deleted_c), 1::BIGINT);
SELECT pg_temp.expect_eq('audit: admin_id recorded',
  (SELECT u.email FROM audit_log l JOIN users u ON u.user_id = l.admin_id WHERE l.paper_id = :deleted_c),
  'admin@test.com');

-- 6. Counter never goes below 0, even if it was already wrong
UPDATE papers SET citation_count = 0 WHERE title = 'Paper A';
DELETE FROM citations WHERE citing_paper_id = pg_temp.pid('B') AND cited_paper_id = pg_temp.pid('A');
SELECT pg_temp.snap('6. force A to 0, then delete B->A');
SELECT pg_temp.expect_eq('floor: A stays at 0, not -1', pg_temp.cc('A'), 0);

-- 7. Delete without an admin set (e.g. by hand in psql): admin_id is NULL
SELECT set_config('app.admin_id', '', true);
SELECT pg_temp.pid('D') AS deleted_d \gset
DELETE FROM papers WHERE title = 'Paper D';
SELECT pg_temp.snap('7. delete paper D, no admin set');
SELECT pg_temp.expect_eq('audit: delete with no admin logs NULL admin_id',
  (SELECT admin_id IS NULL FROM audit_log WHERE paper_id = :deleted_d), true);
SELECT pg_temp.expect_eq('cascade: B loses D''s citation (0)', pg_temp.cc('B'), 0);

-- Final: every counter matches COUNT(*) from citations
SELECT pg_temp.expect_eq('every citation_count = COUNT(*) of citations', pg_temp.mismatches(), 0::BIGINT);

\o
\echo
\echo 'citation_count of each paper after every step (deleted = paper no longer exists):'
SELECT step,
       coalesce(a::TEXT, 'deleted') AS "A",
       coalesce(b::TEXT, 'deleted') AS "B",
       coalesce(c::TEXT, 'deleted') AS "C",
       coalesce(d::TEXT, 'deleted') AS "D"
FROM snapshots ORDER BY n;

\echo 'audit_log rows written by the delete trigger:'
SELECT l.action, l.paper_id, coalesce(u.email, 'NULL (no admin set)') AS admin
FROM audit_log l LEFT JOIN users u ON u.user_id = l.admin_id
ORDER BY l.log_id;

SELECT * FROM pg_temp.report();
SELECT pg_temp.summary() AS summary;

ROLLBACK;
