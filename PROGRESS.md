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
| Views (paper details, top cited, papers per year, author stats, conference stats) | todo | | |
| Transactional `add_paper()` with rollback demo | todo | | |

## Data and APIs

| Task | Status | Date | Proof |
|---|---|---|---|
| OpenAlex ingestion (2,000+ NLP/ML papers) | todo | | |
| Keyword search function + `/api/search?mode=keyword` | todo | | |
| Authentication API (register, login, logout, me, role guard) | todo | | |
| Remaining API routes (papers, authors, conferences, bookmarks, stats) | todo | | |
| EXPLAIN ANALYZE evidence, README, handoff note, report draft | todo | | |
