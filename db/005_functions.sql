-- =====================================================================
-- 005_functions.sql : atomic paper insertion
--
-- add_paper() adds a paper, its authors (in byline order) and the papers
-- it cites, as ONE unit of work. Several tables change together:
--     papers -> authors (find or create) -> paper_authors -> citations
-- If any step fails (a cited paper does not exist, a duplicate DOI, a
-- blank author name, ...), PostgreSQL rolls back EVERY change made by the
-- call. There is never a half-added paper with missing authors or
-- citations.
--
-- Why this is atomic: a function always runs inside the caller's
-- transaction, and an error raised anywhere inside it aborts the whole
-- statement. Called on its own (autocommit), the call is its own
-- transaction. Called inside BEGIN ... COMMIT, everything rolls back with
-- the rest of that transaction.
--
-- Example:
--   SELECT add_paper(
--       'My title', 'My abstract', 2024, '10.1234/abc', NULL,
--       '[{"name": "A. Author", "affiliation": "PES University"},
--         {"name": "B. Author"}]'::jsonb,
--       ARRAY[1, 2]);
-- =====================================================================

CREATE FUNCTION add_paper(
    p_title            TEXT,
    p_abstract         TEXT,
    p_year             INT,
    p_doi              TEXT,
    p_conference_id    INT,
    p_authors          JSONB,          -- [{"name": "...", "affiliation": "..."}, ...] in byline order
    p_cited_paper_ids  INT[] DEFAULT '{}'
) RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
    v_paper_id     INT;
    v_author_id    INT;
    v_author       JSONB;
    v_order        INT;
    v_name         TEXT;
    v_affiliation  TEXT;
BEGIN
    -- 1. Validate input up front, with clear messages.
    --    (The table constraints would catch most of this too, but a
    --    readable error is more helpful to the API and the user.)
    IF p_title IS NULL OR btrim(p_title) = '' THEN
        RAISE EXCEPTION 'add_paper: title is required' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_authors IS NULL OR jsonb_typeof(p_authors) <> 'array' OR jsonb_array_length(p_authors) = 0 THEN
        RAISE EXCEPTION 'add_paper: at least one author is required' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- 2. Insert the paper. embedding_status is set to 'pending' explicitly:
    --    the vector side picks up every pending paper after this commits.
    --    The DOI is normalised to the stored form (lowercase, no URL prefix).
    INSERT INTO papers (title, abstract, year, doi, conference_id, embedding_status)
    VALUES (btrim(p_title),
            nullif(btrim(p_abstract), ''),
            p_year,
            nullif(regexp_replace(lower(btrim(p_doi)), '^https?://(dx\.)?doi\.org/', ''), ''),
            p_conference_id,
            'pending')
    RETURNING paper_id INTO v_paper_id;

    -- 3. Authors, in the order given. An author is reused when the same
    --    name (case-insensitive) AND affiliation already exist; otherwise a
    --    new author row is created. Then the author is linked to the paper.
    FOR v_author, v_order IN
        SELECT value, ordinality FROM jsonb_array_elements(p_authors) WITH ORDINALITY
    LOOP
        v_name        := btrim(v_author ->> 'name');
        v_affiliation := nullif(btrim(v_author ->> 'affiliation'), '');

        IF v_name IS NULL OR v_name = '' THEN
            RAISE EXCEPTION 'add_paper: author % has no name', v_order
                USING ERRCODE = 'invalid_parameter_value';
        END IF;

        SELECT author_id INTO v_author_id
        FROM authors
        WHERE lower(name) = lower(v_name)
          AND affiliation IS NOT DISTINCT FROM v_affiliation
        ORDER BY author_id
        LIMIT 1;

        IF v_author_id IS NULL THEN
            INSERT INTO authors (name, affiliation)
            VALUES (v_name, v_affiliation)
            RETURNING author_id INTO v_author_id;
        END IF;

        INSERT INTO paper_authors (paper_id, author_id, author_order)
        VALUES (v_paper_id, v_author_id, v_order);
    END LOOP;

    -- 4. Citations. DISTINCT ignores an id listed twice. A non-existent id
    --    breaks the foreign key and rolls everything back. Each inserted row
    --    fires the citation trigger, so the cited papers' citation_count
    --    goes up automatically.
    INSERT INTO citations (citing_paper_id, cited_paper_id)
    SELECT DISTINCT v_paper_id, cited_id
    FROM unnest(coalesce(p_cited_paper_ids, '{}')) AS cited_id
    WHERE cited_id IS NOT NULL;

    RETURN v_paper_id;
END $$;
