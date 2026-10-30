-- Shared helpers for the SQL tests. scripts/run_tests.sh pipes this file in
-- before every test file. Everything here is TEMPORARY (pg_temp schema):
-- it vanishes when the session ends and never touches the real schema.

\set QUIET on
\pset footer off

-- One row per check; printed as a single table at the end of each test file.
CREATE TEMP TABLE test_results (
    n         SERIAL,
    test      TEXT,
    expected  TEXT,
    got       TEXT,
    result    TEXT
);

-- Readable names for the SQLSTATE codes that constraints raise.
CREATE FUNCTION pg_temp.state_name(p_state TEXT) RETURNS TEXT
LANGUAGE sql AS $$
    SELECT CASE p_state
        WHEN '23505' THEN 'unique_violation'
        WHEN '23514' THEN 'check_violation'
        WHEN '23503' THEN 'foreign_key_violation'
        WHEN '23502' THEN 'not_null_violation'
        WHEN 'P0001' THEN 'raise_exception'
        WHEN '22023' THEN 'invalid_parameter_value'
        ELSE p_state
    END
$$;

-- Run a statement that MUST fail with the given SQLSTATE.
-- The inner BEGIN ... EXCEPTION block is a savepoint, so the failure is
-- caught and the surrounding test transaction keeps going.
CREATE FUNCTION pg_temp.expect_error(p_test TEXT, p_sql TEXT, p_state TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_state TEXT;
    v_constraint TEXT;
BEGIN
    BEGIN
        EXECUTE p_sql;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE,
                                v_constraint = CONSTRAINT_NAME;
        INSERT INTO test_results (test, expected, got, result)
        VALUES (p_test,
                pg_temp.state_name(p_state),
                pg_temp.state_name(v_state) || coalesce(' [' || nullif(v_constraint, '') || ']', ''),
                CASE WHEN v_state = p_state THEN 'PASS' ELSE 'FAIL' END);
        RETURN;
    END;
    INSERT INTO test_results (test, expected, got, result)
    VALUES (p_test, pg_temp.state_name(p_state), 'no error: bad row was accepted', 'FAIL');
END $$;

-- Run a statement that MUST succeed.
CREATE FUNCTION pg_temp.expect_ok(p_test TEXT, p_sql TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE p_sql;
    INSERT INTO test_results (test, expected, got, result)
    VALUES (p_test, 'success', 'success', 'PASS');
EXCEPTION WHEN OTHERS THEN
    INSERT INTO test_results (test, expected, got, result)
    VALUES (p_test, 'success', 'error: ' || SQLERRM, 'FAIL');
END $$;

-- Compare an actual value with the expected one (both as text).
CREATE FUNCTION pg_temp.expect_eq(p_test TEXT, p_got ANYELEMENT, p_expected ANYELEMENT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO test_results (test, expected, got, result)
    VALUES (p_test, coalesce(p_expected::TEXT, 'NULL'), coalesce(p_got::TEXT, 'NULL'),
            CASE WHEN p_got IS NOT DISTINCT FROM p_expected THEN 'PASS' ELSE 'FAIL' END);
END $$;

-- Print the results table plus a one-line summary.
CREATE FUNCTION pg_temp.report() RETURNS TABLE ("#" INT, test TEXT, expected TEXT, got TEXT, result TEXT)
LANGUAGE sql AS $$
    SELECT n, test, expected, got, result FROM test_results ORDER BY n
$$;

CREATE FUNCTION pg_temp.summary() RETURNS TEXT
LANGUAGE sql AS $$
    SELECT count(*) FILTER (WHERE result = 'PASS') || ' passed, '
        || count(*) FILTER (WHERE result <> 'PASS') || ' failed'
    FROM test_results
$$;

\set QUIET off
