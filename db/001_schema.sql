-- =====================================================================
-- 001_schema.sql : core tables and integrity constraints
--
-- PostgreSQL is the single source of truth for every structured record.
-- Every rule that must ALWAYS hold is enforced here in the database, not
-- only in the application, so no client (API, ingestion script, psql)
-- can store inconsistent data.
--
-- Primary keys use GENERATED ALWAYS AS IDENTITY: the SQL-standard
-- replacement for SERIAL. "ALWAYS" stops clients from inventing their own
-- IDs by accident.
-- =====================================================================


-- ---------------------------------------------------------------------
-- users: people who log in to the web app
-- ---------------------------------------------------------------------
CREATE TABLE users (
    user_id        INT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name           TEXT NOT NULL CHECK (btrim(name) <> ''),
    -- UNIQUE: one account per email address, so login is unambiguous.
    -- The lowercase CHECK stops "A@x.com" and "a@x.com" becoming two accounts.
    email          TEXT NOT NULL UNIQUE
                   CHECK (email = lower(email) AND position('@' IN email) > 1),
    -- Only the bcrypt hash is stored, never the plain password.
    password_hash  TEXT NOT NULL,
    -- Role drives authorisation; the CHECK allows only the two known roles.
    role           TEXT NOT NULL DEFAULT 'researcher'
                   CHECK (role IN ('researcher', 'admin')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------
-- conferences: one row per edition of a venue (e.g. ACL 2020, ACL 2021)
-- ---------------------------------------------------------------------
CREATE TABLE conferences (
    conference_id  INT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name           TEXT NOT NULL CHECK (btrim(name) <> ''),
    acronym        TEXT,
    year           INT  CHECK (year BETWEEN 1900 AND 2100),
    location       TEXT,
    -- The same conference cannot be entered twice for the same year.
    -- NULLS NOT DISTINCT (PostgreSQL 15+) also treats two rows with the
    -- same name and an unknown (NULL) year as duplicates.
    CONSTRAINT conferences_name_year_key UNIQUE NULLS NOT DISTINCT (name, year)
);


-- ---------------------------------------------------------------------
-- papers: the central entity
-- ---------------------------------------------------------------------
CREATE TABLE papers (
    paper_id          INT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title             TEXT NOT NULL CHECK (btrim(title) <> ''),
    abstract          TEXT,
    year              INT  CHECK (year BETWEEN 1900 AND 2100),
    -- A DOI identifies exactly one paper, so it must be unique.
    -- Stored lowercase without the "https://doi.org/" prefix; every DOI starts with "10.".
    doi               TEXT UNIQUE CHECK (doi = lower(doi) AND doi LIKE '10.%'),
    -- SET NULL: deleting a conference must not delete its papers;
    -- they simply lose the link.
    conference_id     INT REFERENCES conferences (conference_id) ON DELETE SET NULL,
    -- Number of papers that cite this one. Kept up to date by triggers on
    -- the citations table, so reads never need COUNT(*). Can never go negative.
    citation_count    INT  NOT NULL DEFAULT 0 CHECK (citation_count >= 0),
    -- Link to the vector database: every new paper is 'pending' until its
    -- embedding is stored in Qdrant ('done') or the attempt fails ('failed').
    embedding_status  TEXT NOT NULL DEFAULT 'pending'
                      CHECK (embedding_status IN ('pending', 'done', 'failed')),
    -- OpenAlex work ID (e.g. 'W2741809807'). UNIQUE makes the ingestion
    -- script re-runnable: a second run skips papers already loaded.
    openalex_id       TEXT UNIQUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Full-text search document, computed by PostgreSQL itself.
    -- GENERATED ... STORED means it is recalculated on every insert/update,
    -- so it can never be out of sync with title/abstract.
    -- Weight 'A' for the title and 'B' for the abstract makes title matches
    -- rank higher than abstract matches.
    search_tsv        TSVECTOR GENERATED ALWAYS AS (
                          setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                          setweight(to_tsvector('english', coalesce(abstract, '')), 'B')
                      ) STORED
);


-- ---------------------------------------------------------------------
-- authors
-- ---------------------------------------------------------------------
CREATE TABLE authors (
    author_id    INT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         TEXT NOT NULL CHECK (btrim(name) <> ''),
    affiliation  TEXT,
    -- OpenAlex author ID; UNIQUE so re-running ingestion does not duplicate authors.
    openalex_id  TEXT UNIQUE
);


-- ---------------------------------------------------------------------
-- paper_authors: resolves the many-to-many between papers and authors
-- (a paper has many authors, an author writes many papers)
-- ---------------------------------------------------------------------
CREATE TABLE paper_authors (
    -- CASCADE: a link row means nothing once either side is gone.
    paper_id      INT NOT NULL REFERENCES papers  (paper_id)  ON DELETE CASCADE,
    author_id     INT NOT NULL REFERENCES authors (author_id) ON DELETE CASCADE,
    -- Position in the byline: 1 = first author.
    author_order  INT NOT NULL CHECK (author_order >= 1),
    -- Composite PK: the same author cannot be linked to the same paper twice.
    PRIMARY KEY (paper_id, author_id),
    -- Two authors cannot share the same position on one paper.
    CONSTRAINT paper_authors_order_key UNIQUE (paper_id, author_order)
);


-- ---------------------------------------------------------------------
-- citations: a self-referencing many-to-many on papers
-- (citing_paper_id cites cited_paper_id)
-- ---------------------------------------------------------------------
CREATE TABLE citations (
    citing_paper_id  INT NOT NULL REFERENCES papers (paper_id) ON DELETE CASCADE,
    cited_paper_id   INT NOT NULL REFERENCES papers (paper_id) ON DELETE CASCADE,
    -- Composite PK: a paper can cite another paper only once.
    PRIMARY KEY (citing_paper_id, cited_paper_id),
    -- A paper cannot cite itself.
    CONSTRAINT citations_no_self_citation CHECK (citing_paper_id <> cited_paper_id)
);


-- ---------------------------------------------------------------------
-- bookmarks: papers a user has saved
-- ---------------------------------------------------------------------
CREATE TABLE bookmarks (
    -- CASCADE: deleting a user or a paper removes their bookmarks too.
    user_id     INT NOT NULL REFERENCES users  (user_id)  ON DELETE CASCADE,
    paper_id    INT NOT NULL REFERENCES papers (paper_id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Composite PK: the same paper cannot be bookmarked twice by one user.
    PRIMARY KEY (user_id, paper_id)
);


-- ---------------------------------------------------------------------
-- audit_log: record of admin actions such as paper deletions
-- (rows are written by a trigger, not by the application)
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
    log_id     INT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    action     TEXT NOT NULL,
    -- Deliberately NOT a foreign key: the log must outlive the paper it
    -- describes. An FK would either block the delete or erase the history.
    paper_id   INT,
    -- SET NULL: removing an admin account keeps the history, just anonymised.
    admin_id   INT REFERENCES users (user_id) ON DELETE SET NULL,
    logged_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
