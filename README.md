# Academic Research Paper Repository with Semantic Search

A repository of research papers with keyword, semantic and hybrid search.
- **PostgreSQL 16** is the source of truth for papers, authors, citations, conferences, users and bookmarks.
- **Qdrant** stores abstract embeddings for semantic search.
- A **Next.js** app exposes the API (and, later, the UI).

DBMS Experiential Learning, Level 3 mini project.

| Team member | SRN |
|---|---|
| Sonia Sharma | PES1UG24AM904 |
| P Saanvi | PES1UG24AM905 |

| Document | What it covers |
|---|---|
| `docs/proposal.pdf` | The agreed design |
| `docs/API_CONTRACT.md` | Every route, with exact request and response fields |
| `docs/HANDOFF.md` | Notes for the vector/front-end half, with curl examples |
| `docs/er_diagram.md` | ER diagram and normalisation notes |
| `docs/explain_evidence.md` | Index query plans, with and without |
| `docs/report_rdbms.md` | Report draft for the database half |
| `docs/DECISIONS.md` | Every deviation from the proposal, with the reason |
| `PROGRESS.md` | Task status and the command that proves each task |

## Requirements
- **Docker Desktop**, with Docker Compose v2.
- **Node.js 20.9 or newer**, for the web app (developed on 22.19).
- **Python 3.10 or newer**, for ingestion (developed on 3.11).
- **Git.** On Windows, run the `.sh` scripts from **Git Bash**. PowerShell versions of the database scripts are in `scripts/*.ps1`.

## Run from a clean checkout

All commands are run from the repository root.

### 1. Configure

```bash
cp .env.example .env
```

Edit `.env`:
- **`POSTGRES_PASSWORD`:** choose one, and use the same password inside `DATABASE_URL`.
- **`SESSION_SECRET`:** a long random string. Generate one with `python -c "import secrets; print(secrets.token_hex(32))"`.
- **`ADMIN_EMAIL` / `ADMIN_PASSWORD`:** the first admin account.
- **`OPENALEX_API_KEY`:** only needed to download the data yourself (step 3). Get a free key at https://openalex.org/settings/api-key.

### 2. Start the databases and build the schema

```bash
docker compose up -d --wait
```

```bash
bash scripts/rebuild_db.sh
```

The first command starts Postgres on host port **5433** (`PG_PORT`) and an empty Qdrant on 6333. The second applies every migration in `db/`, in order.

### 3. Load the papers

Choose one of the two options.

**Option A: download from OpenAlex** (needs `OPENALEX_API_KEY`, takes about 2 minutes):

```bash
pip install -r ingest/requirements.txt
```

```bash
python ingest/fetch_openalex.py
```

```bash
python ingest/load_papers.py
```

```bash
python ingest/verify_load.py
```

`fetch_openalex.py` caches 4,500 works in `ingest/cache/`. `load_papers.py` loads 4,000 papers and can be re-run safely. `verify_load.py` checks counts and that every citation counter is correct.

**Option B: restore a shared database dump** (no API key needed). See "Database dump" in `docs/HANDOFF.md`.

### 4. Start the API

```bash
npm --prefix web install
```

```bash
npm --prefix web run seed:admin
```

```bash
npm --prefix web run dev
```

The second command creates the admin account from `.env`. The third starts the API on http://localhost:3000; keep that terminal open while you use it.

There is no home page yet, so `http://localhost:3000/` shows a 404. Open an API route instead:
- http://localhost:3000/api/search?q=neural%20machine%20translation
- http://localhost:3000/api/stats/overview
- http://localhost:3000/api/papers/3

## Tests

| What | Command | Needs |
|---|---|---|
| SQL tests (constraints, indexes, triggers, views, `add_paper`, search) | `bash scripts/run_tests.sh` | database |
| Ingestion helpers (abstract rebuild, DOI cleaning) | `python ingest/test_common.py` | nothing |
| Load check | `python ingest/verify_load.py` | data loaded |
| Auth walkthrough with curl | `bash web/tests/auth_curl.sh` | API running, admin seeded |
| Every API route + contract fields | `npm --prefix web run test:api` | API running, data loaded, admin seeded |

The SQL tests run inside a transaction that is rolled back, so they never change your data. They pass on an empty database and on a fully loaded one.

On Windows PowerShell, run the SQL tests with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run_tests.ps1
```

## Rebuild the database from scratch (one command)

This drops every table, view, function and row, then applies `db/001_*.sql`, `db/002_*.sql`, ... in order. Reload the data afterwards (step 3).

```bash
bash scripts/rebuild_db.sh
```

On Windows PowerShell instead:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\rebuild_db.ps1
```

## Viva demos

**A failed transaction leaves nothing behind.** This runs inside `BEGIN ... ROLLBACK`, so nothing changes:

```bash
bash scripts/psql.sh -f /db/demo/add_paper_rollback_demo.sql
```

**Index query plans, with and without** (also rolled back):

```bash
bash scripts/psql.sh -f /db/evidence/explain_indexes.sql
```

**SQL prompt:**

```bash
docker compose exec db psql -U app -d papers
```

## Repository layout

| Folder | Contents |
|---|---|
| `db/` | Numbered, append-only SQL migrations, plus subfolders: `tests` (SQL tests), `seed` (test seed data), `demo` (viva demo), `evidence` (EXPLAIN script) |
| `ingest/` | Python scripts that load papers from OpenAlex |
| `web/` | Next.js app: API routes in `app/api`, shared code in `lib`, tests in `tests` |
| `docs/` | Proposal, API contract, ER diagram, decisions, evidence, handoff, report draft |
| `scripts/` | Rebuild, test and psql helper scripts (bash and PowerShell) |
