-- =====================================================================
-- 003_triggers.sql : keep derived data correct automatically
--
-- 1. papers.citation_count must always equal the number of rows in
--    citations that point at the paper. Instead of running COUNT(*) on
--    every page view, triggers adjust the counter whenever a citation is
--    added, removed or changed, inside the same transaction as the change.
--    So the counter can never disagree with the citations table, no
--    matter which client wrote the data.
-- 2. Every paper deletion leaves a row in audit_log.
-- =====================================================================


-- ---------------------------------------------------------------------
-- New citation: the cited paper gains one citation.
-- AFTER INSERT so it only runs once the row has passed all constraints
-- (FKs, no self-citation, no duplicate). FOR EACH ROW so a multi-row
-- INSERT counts every row.
-- ---------------------------------------------------------------------
CREATE FUNCTION citation_count_increment() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE papers
    SET citation_count = citation_count + 1
    WHERE paper_id = NEW.cited_paper_id;
    RETURN NULL;  -- return value is ignored for AFTER triggers
END $$;

CREATE TRIGGER trg_citation_insert
AFTER INSERT ON citations
FOR EACH ROW EXECUTE FUNCTION citation_count_increment();


-- ---------------------------------------------------------------------
-- Removed citation: the cited paper loses one citation, never going below 0.
-- This also fires for citation rows removed by ON DELETE CASCADE when a
-- paper is deleted:
--   * rows where the deleted paper was the CITING paper: the papers it
--     cited are decremented, which is correct since they still exist;
--   * rows where the deleted paper was the CITED paper: the UPDATE matches
--     no row (that paper is already gone), which is harmless.
-- ---------------------------------------------------------------------
CREATE FUNCTION citation_count_decrement() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE papers
    SET citation_count = GREATEST(citation_count - 1, 0)
    WHERE paper_id = OLD.cited_paper_id;
    RETURN NULL;
END $$;

CREATE TRIGGER trg_citation_delete
AFTER DELETE ON citations
FOR EACH ROW EXECUTE FUNCTION citation_count_decrement();


-- ---------------------------------------------------------------------
-- Changed citation: if a citation is re-pointed to a different paper,
-- move one count from the old cited paper to the new one. Without this,
-- an UPDATE would silently leave both counters wrong.
-- ---------------------------------------------------------------------
CREATE FUNCTION citation_count_move() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE papers
    SET citation_count = GREATEST(citation_count - 1, 0)
    WHERE paper_id = OLD.cited_paper_id;

    UPDATE papers
    SET citation_count = citation_count + 1
    WHERE paper_id = NEW.cited_paper_id;
    RETURN NULL;
END $$;

CREATE TRIGGER trg_citation_update
AFTER UPDATE OF cited_paper_id ON citations
FOR EACH ROW
WHEN (OLD.cited_paper_id IS DISTINCT FROM NEW.cited_paper_id)
EXECUTE FUNCTION citation_count_move();


-- ---------------------------------------------------------------------
-- Audit trail for paper deletions.
-- BEFORE DELETE so the log row is written while the paper still exists,
-- in the same transaction: if logging fails, the delete is rolled back,
-- so no paper can disappear without a trace.
--
-- Who deleted it? The API runs, in the same transaction as the DELETE:
--     SELECT set_config('app.admin_id', '<user_id>', true);
-- current_setting(..., true) returns NULL instead of raising an error
-- when the setting was never set (for example a manual delete in psql),
-- so admin_id is then recorded as NULL.
-- ---------------------------------------------------------------------
CREATE FUNCTION log_paper_delete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO audit_log (action, paper_id, admin_id)
    VALUES ('DELETE_PAPER',
            OLD.paper_id,
            NULLIF(current_setting('app.admin_id', true), '')::INT);
    RETURN OLD;  -- returning OLD lets the delete go ahead (NULL would cancel it)
END $$;

CREATE TRIGGER trg_paper_audit_delete
BEFORE DELETE ON papers
FOR EACH ROW EXECUTE FUNCTION log_paper_delete();
