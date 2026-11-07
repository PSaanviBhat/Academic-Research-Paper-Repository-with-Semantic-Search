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
| Authentication API (register, login, logout, me, role guard) | done | 2026-10-30 | with the app running: `npm --prefix web run seed:admin` then `bash web/tests/auth_curl.sh` (20 passed: 401 without session, 403 researcher on admin route, 200 admin, forged cookie rejected, bcrypt hash stored) |
| Remaining API routes (papers, authors, conferences, bookmarks, stats) | done | 2026-10-30 | with the app running: `npm --prefix web run test:api` (32 passed: every route, status codes, and exact contract field names); clickable collection: `web/tests/requests.http` |
| EXPLAIN ANALYZE evidence, README, handoff note, report draft | done | 2026-10-30 | `bash scripts/psql.sh -f /db/evidence/explain_indexes.sql` (GIN: 4.1x and 20.9x faster, cited-by B-tree 7.7x; indexes restored by ROLLBACK); docs: `docs/explain_evidence.md`, `README.md`, `docs/HANDOFF.md`, `docs/report_rdbms.md` |

## Handoff gate (fresh `git clone`, separate Docker project on ports 5434 / 6335 / 3001, 2026-10-30)

| Check | Result | Evidence |
|---|---|---|
| `docker compose up` starts Postgres and an empty Qdrant | PASS | both containers healthy; `GET /collections` returned `[]` |
| One command rebuilds the schema from scratch | PASS | `bash scripts/rebuild_db.sh` applied 001 to 006, 8 tables |
| 2,000+ papers with authors and citations, all `pending` | PASS | 4,000 papers, 5,388 authors, 37,988 citations, 4,000 pending; second load added nothing; `verify_load.py` exit 0 |
| `add_paper()` sets `pending`; the delete audit trigger works | PASS | 005_add_paper_test (19) and 003_triggers_test (17); API test checks the audit row after `DELETE /api/papers/:id` |
| Keyword search works; semantic and hybrid return 501 | PASS | `/api/search` returned 200 for keyword, 501 "implemented in Part 2" for semantic and hybrid |
| Auth, CRUD, bookmarks, paper detail and stats routes pass their tests | PASS | `auth_curl.sh` 20/20, `test:api` 32/32, SQL tests 113/113, helper tests 10/10 |
| README, API_CONTRACT, HANDOFF, EXPLAIN evidence and RDBMS report draft exist | PASS | all present in the clone |

---

# Progress: vector DB and front-end half

Status: `built` = code written, type-checked and serving, not yet checked by hand in a browser; `done` = proven by the command in the last column.

Verified on a fresh OpenAlex download (2026-11-07): 4,000 papers, 39,100 citations, all counters correct (`verify_load.py`). OpenAlex has grown since the Part 1 load (37,988 citations), so counts differ slightly from Saanvi's database.

| Task | Status | Date | Proof (run from the repo root) |
|---|---|---|---|
| V1 Embedding service (FastAPI, all-MiniLM-L6-v2, `POST /embed`) | done | 2026-11-07 | `embed/.venv/bin/python embed/test_embed.py` (10 passed: 384-d unit vectors, related text closer than unrelated, Python and SQL hashes agree); `curl localhost:8001/health` |
| V2 Qdrant collection + bulk embedding | done | 2026-11-07 | `embed/.venv/bin/python embed/sync.py` (4000 done, 0 failed, 49.5 s); second run: "nothing to embed"; `sync.py --check`: 4000 points, 0 missing, 0 orphans |
| V3 Consistency (post-commit upsert/delete, failed status, retry, orphan-safe hydration) | done | 2026-11-07 | `npm --prefix web run test:api` ("vector consistency": add → done + found by meaning, PATCH → re-embedded, DELETE → point removed; 4 passed) |
| V4 Semantic search `/api/search?mode=semantic` | done | 2026-11-07 | `npm --prefix web run test:api` (search: 7 passed, incl. contract fields, cosine ≤ 1, pagination, year filter); 38/38 overall |
| V5 Hybrid search (RRF) `/api/search?mode=hybrid` | done | 2026-11-07 | `npm --prefix web run test:api` (contract fields, RRF ≤ 2/61, year filter) |
| V6 Next.js layout + search page | built | 2026-11-07 | `npm --prefix web run build` passes; every page returns 200. Browser click-through still to do |
| V7 Login, paper detail, bookmarks, admin screens | built | 2026-11-07 | Pages serve; the APIs behind them pass `test:api` and `auth_curl.sh` (20/20). Browser walkthrough in `docs/DEMO_SCRIPT.md` still to do |
| V8 Statistics dashboard | built | 2026-11-07 | http://localhost:3000/stats serves; `/api/stats/overview` passes its contract test. Visual check still to do |
| V9 Examples, report, demo script | done | 2026-11-07 | `embed/.venv/bin/python embed/compare_modes.py` → `docs/semantic_vs_keyword.md` (6 queries: 3 where keyword finds 0 and semantic finds the topic, 1 where both work, 1 partial, 1 documented limitation); `docs/report_vector.md`; `docs/DEMO_SCRIPT.md` |
