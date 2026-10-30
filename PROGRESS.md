# Progress: RDBMS half

Status: `done` = built and proven by the command in the last column; `todo` = not started.

## Foundation

| Task | Status | Date | Proof (run from the repo root) |
|---|---|---|---|
| Repo layout, Docker (Postgres 16 + empty Qdrant), `.env.example`, API contract | done | 2026-10-30 | `docker compose up -d --wait` then `bash scripts/psql.sh -c "select version()"` and `curl http://localhost:6333/collections` (returns `"collections":[]`) |
| Core schema with all constraints, ER diagram, one-command rebuild | done | 2026-10-30 | `bash scripts/rebuild_db.sh` then `bash scripts/run_tests.sh` (37 passed, 0 failed; PowerShell: `scripts\rebuild_db.ps1`, `scripts\run_tests.ps1`) |

## Database features

| Task | Status | Date | Proof |
|---|---|---|---|
| Indexes (GIN full-text, B-tree on FK/year, trigram on author names) | done | 2026-10-30 | `bash scripts/rebuild_db.sh` then `bash scripts/run_tests.sh` (002_indexes_test: 13 passed; checks each index exists and the planner can use it) |
| Triggers (citation_count up/down, audit log on paper delete) | done | 2026-10-30 | `bash scripts/run_tests.sh` (003_triggers_test: 17 passed; prints citation_count after every step and the audit_log rows) |
| Views (paper details, top cited, papers per year, author stats, conference stats) | done | 2026-10-30 | `bash scripts/run_tests.sh` (004_views_test: 14 passed on the seed in db/seed/test_seed.sql; prints every view) |
| Transactional `add_paper()` with rollback demo | done | 2026-10-30 | `bash scripts/run_tests.sh` (005_add_paper_test: 19 passed); live demo: `bash scripts/psql.sh -f /db/demo/add_paper_rollback_demo.sql` |

## Data and APIs

| Task | Status | Date | Proof |
|---|---|---|---|
| OpenAlex ingestion (2,000+ NLP/ML papers) | done | 2026-10-30 | `py -3.11 ingest/fetch_openalex.py`, `py -3.11 ingest/load_papers.py` (run twice: identical counts), `py -3.11 ingest/verify_load.py` (4000 papers, 37988 citations, 0 counter mismatches, all pending); helpers: `py -3.11 ingest/test_common.py` (10 passed) |
| Keyword search function + `/api/search?mode=keyword` | done | 2026-10-30 | `bash scripts/run_tests.sh` (006_search_test: 13 passed); with the app running: `curl "http://localhost:3000/api/search?q=neural%20machine%20translation"` (total 320), `&mode=semantic` returns 501 |
| Authentication API (register, login, logout, me, role guard) | todo | | |
| Remaining API routes (papers, authors, conferences, bookmarks, stats) | todo | | |
| EXPLAIN ANALYZE evidence, README, handoff note, report draft | todo | | |
