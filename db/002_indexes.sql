-- =====================================================================
-- 002_indexes.sql : indexes for the queries the app runs most often
--
-- PostgreSQL already creates a B-tree index for every PRIMARY KEY and
-- UNIQUE constraint (users.email, papers.doi, the composite keys, ...),
-- so only the access paths NOT covered by those are added here.
-- Every index speeds up reads but costs a little on each write, so each
-- one below is tied to a specific query.
-- =====================================================================


-- Keyword search: "WHERE search_tsv @@ websearch_to_tsquery(...)".
-- A GIN (Generalized Inverted Index) maps every word to the list of papers
-- containing it, so a search reads only those papers instead of scanning
-- and parsing every row. Without it, every search is a full table scan.
CREATE INDEX idx_papers_search_tsv ON papers USING GIN (search_tsv);

-- Year filter on search and paper lists ("WHERE year = 2020"), and the
-- GROUP BY year in the papers-per-year statistics.
CREATE INDEX idx_papers_year ON papers (year);

-- Foreign key papers.conference_id: used for joins from conferences to
-- their papers (conference page, conference statistics). It also stops a
-- conference delete from scanning all papers to apply ON DELETE SET NULL.
-- PostgreSQL does NOT index foreign-key columns automatically.
CREATE INDEX idx_papers_conference_id ON papers (conference_id);

-- "Cited by" lookups: WHERE cited_paper_id = ?.
-- The primary key (citing_paper_id, cited_paper_id) can only be searched by
-- its first column, so it answers "what does this paper cite?" but not
-- "who cites this paper?". The citation-count triggers and the
-- ON DELETE CASCADE from papers use this index too.
CREATE INDEX idx_citations_cited_paper_id ON citations (cited_paper_id);

-- Author page: "all papers by author X" (WHERE author_id = ?).
-- The primary key (paper_id, author_id) leads with paper_id, so it cannot
-- serve this lookup by itself. It also speeds up the author statistics view
-- and the cascade when an author is deleted.
CREATE INDEX idx_paper_authors_author_id ON paper_authors (author_id);

-- Fuzzy author-name search ("vaswan" finds "Ashish Vaswani").
-- pg_trgm splits text into 3-letter pieces (trigrams); a GIN index over
-- them makes ILIKE '%...%' and similarity searches fast. A normal B-tree
-- cannot help with a leading wildcard.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_authors_name_trgm ON authors USING GIN (name gin_trgm_ops);
