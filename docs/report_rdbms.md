# Relational Database Design and Implementation (report draft)

*Draft section for the project report, covering the PostgreSQL half. Figures come from the loaded dataset of 4,000 papers. The ER diagram is in `docs/er_diagram.md`, ready to export from mermaid.live.*

---

## 1. Role of the relational database

PostgreSQL 16 is the **single source of truth** of the system. Every structured fact lives here: papers, authors, conferences, citations, users, bookmarks and the audit trail. The integrity rules are enforced by the database itself, not only by the application, so no client can store inconsistent data. That includes the web API, the ingestion script and a person typing in `psql`.

The vector database (Qdrant) only holds embeddings keyed by `paper_id`. Search results from it are always re-read from PostgreSQL.

The two databases are linked by one column, `papers.embedding_status` (`pending` → `done` / `failed`). Every new or edited paper is `pending` until its vector has been stored.

## 2. Schema

The schema has eight tables, created by the migration `db/001_schema.sql`.

| Table | Purpose | Key constraints |
|---|---|---|
| `users` | Login accounts | PK `user_id`; `email` UNIQUE, NOT NULL, lowercase; `role` CHECK in (`researcher`, `admin`); `password_hash` NOT NULL (bcrypt) |
| `conferences` | One row per venue edition (e.g. ACL 2019) | PK; `name` NOT NULL; `UNIQUE NULLS NOT DISTINCT (name, year)` |
| `papers` | The central entity | PK; `title` NOT NULL and not blank; `doi` UNIQUE (normalised, starts with `10.`); `conference_id` FK `ON DELETE SET NULL`; `citation_count` NOT NULL DEFAULT 0 CHECK ≥ 0; `embedding_status` CHECK in (`pending`, `done`, `failed`); generated `search_tsv` |
| `authors` | People who write papers | PK; `name` NOT NULL |
| `paper_authors` | Paper–author M:N | Composite PK `(paper_id, author_id)`; both FKs `ON DELETE CASCADE`; `author_order` ≥ 1 and `UNIQUE (paper_id, author_order)` |
| `citations` | Paper cites paper (recursive M:N) | Composite PK `(citing_paper_id, cited_paper_id)`; both FKs `ON DELETE CASCADE`; `CHECK (citing_paper_id <> cited_paper_id)` |
| `bookmarks` | Papers a user has saved | Composite PK `(user_id, paper_id)`; both FKs `ON DELETE CASCADE` |
| `audit_log` | Record of paper deletions | PK; filled only by a trigger; `paper_id` deliberately **not** an FK |

Two columns support data ingestion: `papers.openalex_id` and `authors.openalex_id`, both `TEXT UNIQUE`. They let the loader be re-run without creating duplicates.

### Choice of referential actions

- **`ON DELETE CASCADE` on the junction tables** (`paper_authors`, `citations`, `bookmarks`). A link row has no meaning once either end is gone, so removing a paper also removes its authorship links, its citations and the bookmarks pointing at it.
- **`ON DELETE SET NULL` on `papers.conference_id`.** Deleting a conference must not delete the research published there. The papers simply lose the link.
- **`audit_log.paper_id` has no foreign key.** The log must describe a paper *after* it has been deleted. A foreign key would either block the deletion (RESTRICT) or erase the history (CASCADE). `audit_log.admin_id` does reference `users`, with `SET NULL`, so the history survives even if an admin account is removed.

### Normalisation

The schema is in **third normal form**:
- **1NF.** Every column is single-valued. Authors and citations are separate rows, not lists inside a paper row.
- **2NF.** In the tables with composite keys, `author_order` and `bookmarks.created_at` depend on the *whole* key, and author details live in `authors`.
- **3NF.** Conference details are stored once in `conferences` and referenced by id, so no non-key column depends on another non-key column.

The one deliberate redundancy is `papers.citation_count`, which equals the number of `citations` rows pointing at the paper. It is kept for read speed, because search results and the dashboard sort by it constantly, and it is maintained automatically by triggers (Section 4) so it can never drift.

### Full-text search column

```sql
search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(abstract, '')), 'B')
) STORED
```

- **Generated and stored.** PostgreSQL recomputes the column on every insert or update, so it can never be out of date with the title or abstract.
- **`to_tsvector('english', …)`** splits text into stemmed words ("translations" becomes `translat`) and drops stop words.
- **Weights.** Title words get weight A and abstract words weight B, so a title match ranks above an abstract-only match.

## 3. Indexes

Created in `db/002_indexes.sql`. Primary keys and UNIQUE constraints already have B-tree indexes, so only the access paths they do not cover were added.

| Index | Type | Why it exists |
|---|---|---|
| `idx_papers_search_tsv` on `papers(search_tsv)` | GIN | Keyword search, `search_tsv @@ query`. An inverted index from each word to the papers containing it. |
| `idx_papers_year` on `papers(year)` | B-tree | Year filter; papers-per-year statistics |
| `idx_papers_conference_id` on `papers(conference_id)` | B-tree | Conference pages and statistics. PostgreSQL does not index foreign keys automatically. |
| `idx_citations_cited_paper_id` on `citations(cited_paper_id)` | B-tree | "Cited by" lists, the citation triggers, and cascades. The composite PK only searches by its first column (`citing_paper_id`). |
| `idx_paper_authors_author_id` on `paper_authors(author_id)` | B-tree | An author's papers. The PK starts with `paper_id`. |
| `idx_authors_name_trgm` on `authors(name)` | GIN, `pg_trgm` | Fuzzy author search with `ILIKE '%…%'`, which a B-tree cannot serve |

**Measured effect** (`EXPLAIN ANALYZE`, average of 20 runs; full plans in `docs/explain_evidence.md`). Each index was dropped inside a transaction and restored with `ROLLBACK`.

| Query | With index | Without | Speed-up |
|---|---:|---:|---:|
| Keyword search "neural machine translation" (320 matches) | 3.38 ms | 13.92 ms | 4.1× |
| Keyword search "coreference resolution" (84 matches) | 0.55 ms | 11.54 ms | 20.9× |
| Papers citing the most-cited paper (530 of 37,988 rows) | 0.27 ms | 2.09 ms | 7.7× |

Without the GIN index the planner falls back to a **Seq Scan** that tests all 4,000 rows. The plan reports "Rows Removed by Filter: 3680" and 12,123 pages read. With the index, a **Bitmap Index Scan** reads 31 index pages and fetches only the 320 matching rows, 777 pages in total. The speed-up grows as the query gets more selective and as the table grows, because a sequential scan always reads everything.

## 4. Triggers

Created in `db/003_triggers.sql`.

| Trigger | Event | Action |
|---|---|---|
| `trg_citation_insert` | AFTER INSERT ON `citations`, for each row | `citation_count + 1` on the cited paper |
| `trg_citation_delete` | AFTER DELETE ON `citations`, for each row | `citation_count - 1`, never below 0 (`GREATEST(…, 0)`) |
| `trg_citation_update` | AFTER UPDATE OF `cited_paper_id` | Moves one count from the old cited paper to the new one |
| `trg_paper_audit_delete` | BEFORE DELETE ON `papers`, for each row | Inserts `('DELETE_PAPER', paper_id, admin_id)` into `audit_log` |

**Design points:**
- **The counter triggers are `AFTER` and row-level.** They only run once the citation row has passed every constraint, and a multi-row `INSERT` is counted row by row.
- **They also fire for cascaded deletes.** When a paper is deleted, `ON DELETE CASCADE` removes its citation rows, and the delete trigger fires for each one:
  - the papers it cited are decremented correctly;
  - the update aimed at the deleted paper itself matches no row, which is harmless.
- **The audit trigger is `BEFORE DELETE`.** It runs in the same transaction as the delete: if logging fails, the delete is rolled back too, so no paper disappears without a trace.
- **The admin is identified by a transaction-local setting.** The API runs `SELECT set_config('app.admin_id', '<id>', true)` before the delete. `true` makes the setting local to the transaction, so it cannot leak to another request on a pooled connection. `current_setting('app.admin_id', true)` returns NULL when nothing was set, for example for a manual delete.

**Evidence:**
- `db/tests/003_triggers_test.sql` (17 checks) prints every paper's counter after each step: inserts, deletes, a multi-row insert, an update, a cascaded paper delete, and the floor at 0.
- After bulk-loading 37,988 citation edges, `ingest/verify_load.py` confirmed that **0 of 4,000 papers** have a `citation_count` different from `COUNT(*)` of their citations.

## 5. Views

Created in `db/004_views.sql`. They feed the detail page and the statistics dashboard.

| View | Contents | Techniques |
|---|---|---|
| `v_paper_details` | Paper + conference + authors in byline order (as text and as an array) | LEFT JOIN, LATERAL subquery, `string_agg(… ORDER BY author_order)`, `array_agg` |
| `v_top_cited_papers` | Papers ranked by citations | Window function `RANK() OVER (ORDER BY citation_count DESC)` (ties share a rank) |
| `v_papers_per_year` | Paper count, total and average citations per year | GROUP BY |
| `v_author_stats` | Paper count, total citations, first and last year per author | LEFT JOINs keep authors with 0 papers |
| `v_conference_stats` | Paper count, total and average citations per conference edition | LEFT JOIN, GROUP BY |

A view stores the *query*, not the data, so it always reflects the current tables. `db/tests/004_views_test.sql` (14 checks) verifies each view on a small hand-made seed, including:
- the byline order;
- tied ranks;
- an author with no papers;
- that a view changes as soon as the data does.

## 6. Transactions: atomic paper insertion

`add_paper(title, abstract, year, doi, conference_id, authors JSONB, cited_paper_ids INT[])` is a PL/pgSQL function in `db/005_functions.sql`. In one unit of work it:
1. validates the input;
2. inserts the paper with `embedding_status = 'pending'`;
3. for each author, in order, **finds or creates** the author (same name, case-insensitive, and same affiliation) and links it with its `author_order`;
4. inserts the citations, which fires the counter triggers.

A function always executes inside the caller's transaction, and any error aborts the whole statement. So if any step fails, **every** change made by the call is undone. The failing step could be a cited paper that does not exist, a duplicate DOI, or a blank author name. The web API's `POST /api/papers` calls this function, so it inherits the same guarantee.

**Demonstration** (`db/tests/005_add_paper_test.sql`, 19 checks, and the live script `db/demo/add_paper_rollback_demo.sql`):
- **A successful call** inserts one paper, links an existing and a new author in order, stores two citations, and raises both cited papers' `citation_count` by one.
- **A call with a brand-new author that cites paper 999999** fails with a foreign-key violation on `citations`. The row counts of `papers`, `authors`, `paper_authors` and `citations` are **identical** before and after. Even the new author, inserted before the bad citation was reached, is gone.

The web API uses explicit transactions too:
- **`DELETE /api/papers/:id`** sets the admin id and deletes in one transaction.
- **`PATCH /api/papers/:id`** locks the row with `SELECT … FOR UPDATE`, so two admins cannot overwrite each other half-way. If the title or abstract changed, it resets `embedding_status` to `pending` so the paper is re-embedded.

## 7. Keyword search

`search_papers_keyword(q, year, limit, offset)` in `db/006_search.sql`:
- **`websearch_to_tsquery('english', q)`** converts what the user typed, using web-search syntax:
  - `"exact phrase"` becomes a phrase query;
  - `-word` excludes a word;
  - `or` gives alternatives.

  It never raises a syntax error on odd input.
- **`search_tsv @@ query`** selects the matching papers, using the GIN index.
- **`ts_rank_cd`** (cover density) ranks them. It rewards query words that appear, appear close together, and appear in the higher-weighted title. Ties are broken by citation count.
- **`count(*) OVER ()`**, a window function, returns the total number of matches for pagination in the same query, before `LIMIT`/`OFFSET` cut out the page.
- **`ts_headline`** produces a plain-text snippet of the most relevant part of the abstract. It is computed only for the 10 rows on the page.

The API route `GET /api/search?q=…&mode=keyword&page=…&year=…` returns `{ results: [{paper_id, title, abstract_snippet, year, conference, authors[], citation_count, score}], total }`. Example: "neural machine translation" finds 320 of the 4,000 papers in about 4 ms.

## 8. Dataset and ingestion

The data is the 4,000 most-cited works from **OpenAlex** whose primary topic is "Natural Language Processing Techniques", all with abstracts. The Python scripts are in `ingest/`.

- **Abstracts** arrive as an inverted index (`{word: [positions]}`) and are rebuilt into text.
- **Duplicates.** Duplicate works (a preprint plus its published version) are merged by title, and works with missing or junk abstracts are skipped.
- **Two passes.** First conferences, papers, authors and authorship links, in batches of 500 per transaction. Then citations, keeping an edge **only when both papers are in the dataset**, so every foreign key holds.
- **Re-runnable.** Every insert uses `ON CONFLICT DO NOTHING` on the unique `openalex_id`. Running the loader twice leaves identical row counts.
- **Triggers are not bypassed.** Citations are inserted with ordinary `INSERT`s, so the triggers maintain `citation_count`.

| Result | Count |
|---|---:|
| Papers (all `pending`) | 4,000 |
| Authors | 5,388 |
| Authorship links | 12,416 |
| Venue editions | 740 |
| Internal citation edges | 37,988 |

## 9. Security in the database layer

- **Passwords** are stored only as bcrypt hashes (cost 10).
- **Every SQL statement is parameterised** (`$1, $2, …`), so user input is never spliced into SQL, which rules out SQL injection.
- **Roles are enforced in two places.** The `CHECK` constraint allows only the two roles, and the API's `requireRole('admin')` guard reads the role fresh from the database on every request.
- **Only the admin seed script creates admins.** Registration always creates a `researcher`.

## 10. Testing summary

| Suite | Checks | Result |
|---|---:|---|
| Schema constraints (`001_schema_test.sql`) | 37 | all pass |
| Indexes exist and are used (`002_indexes_test.sql`) | 13 | all pass |
| Triggers (`003_triggers_test.sql`) | 17 | all pass |
| Views (`004_views_test.sql`) | 14 | all pass |
| Atomic `add_paper()` and rollback (`005_add_paper_test.sql`) | 19 | all pass |
| Keyword search (`006_search_test.sql`) | 13 | all pass |
| Ingestion helpers (`ingest/test_common.py`) | 10 | all pass |
| Authentication over HTTP (`web/tests/auth_curl.sh`) | 20 | all pass |
| All API routes + contract field names (`web/tests/api.test.mjs`) | 32 | all pass |

The SQL tests run inside a transaction that ends in `ROLLBACK`. They start from emptied tables (TRUNCATE is transactional in PostgreSQL), so they give the same result on an empty or a fully loaded database and never change real data.
