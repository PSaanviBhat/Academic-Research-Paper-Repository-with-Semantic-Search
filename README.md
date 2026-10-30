# Academic Research Paper Repository with Semantic Search

A repository of research papers with keyword, semantic and hybrid search.
- **PostgreSQL 16** is the source of truth for papers, authors, citations, conferences, users and bookmarks.
- **Qdrant** stores abstract embeddings for semantic search.
- A **Next.js** app exposes the API and UI.

See `docs/proposal.pdf` for the full design and `docs/API_CONTRACT.md` for the API.

## Requirements
- Docker Desktop (with Docker Compose v2)
- Git (on Windows, Git Bash runs the `.sh` scripts; `.ps1` versions are provided too)

## First-time setup

1. Copy the environment template:
   ```bash
   cp .env.example .env
   ```
2. Edit `.env` and set at least `POSTGRES_PASSWORD`, using the same password inside `DATABASE_URL`.
3. Start both databases:
   ```bash
   docker compose up -d --wait
   ```
4. Check that they are up:
   ```bash
   bash scripts/psql.sh -c "select version();"
   ```
   ```bash
   curl http://localhost:6333/collections
   ```

Postgres is published on host port **5433** by default (`PG_PORT` in `.env`).

## Rebuild the database from scratch (one command)

This drops every table, view, function and row, then applies `db/001_*.sql`, `db/002_*.sql`, ... in order.

```bash
bash scripts/rebuild_db.sh
```

On Windows PowerShell instead:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\rebuild_db.ps1
```

## Run the database tests

Each file in `db/tests` prints a PASS/FAIL table and rolls back its own data. The script exits non-zero if anything fails.

```bash
bash scripts/run_tests.sh
```

On Windows PowerShell instead:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run_tests.ps1
```

## Open a SQL prompt

```bash
docker compose exec db psql -U app -d papers
```

## Repository layout

| Folder | Contents |
|---|---|
| `db/` | Numbered SQL migrations (append-only), `db/tests` SQL tests, `db/seed` seed data |
| `ingest/` | Python scripts that load papers from OpenAlex |
| `web/` | Next.js app (API routes) |
| `docs/` | Proposal, API contract, ER diagram, decisions, evidence, handoff notes |
| `scripts/` | Rebuild, test and psql helper scripts |
