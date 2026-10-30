# Handoff: database/API half to vector/front-end half

Everything in this note runs from the repository root. It covers what is built, how to run it, and the agreed interface for the vector side.

## 1. Start everything

```bash
cp .env.example .env            # then fill it in (see README, "Configure")
docker compose up -d --wait     # Postgres on localhost:5433, empty Qdrant on localhost:6333
bash scripts/rebuild_db.sh      # schema, indexes, triggers, views, functions
# load the data: section 3 (restore the dump) or section 4 (download from OpenAlex)
npm --prefix web install
npm --prefix web run seed:admin # admin account from ADMIN_EMAIL / ADMIN_PASSWORD in .env
npm --prefix web run dev        # API on http://localhost:3000
```

Quick check that both databases are up:

```bash
bash scripts/psql.sh -c "select count(*), count(*) filter (where embedding_status = 'pending') as pending from papers"
curl http://localhost:6333/collections   # {"result":{"collections":[]}, ...}
```

## 2. Rebuild the database from scratch

```bash
bash scripts/rebuild_db.sh                                     # Git Bash / macOS / Linux
powershell -ExecutionPolicy Bypass -File scripts\rebuild_db.ps1  # Windows PowerShell
```

The rebuild drops the `public` schema and applies `db/001_schema.sql` … `db/006_search.sql` in order. It also deletes all data, so reload afterwards.

**Schema changes:** add a **new** numbered file (`db/007_...sql`). Never edit an applied migration. Agree schema changes with Saanvi first.

## 3. Database dump (fastest way to get the same data)

Saanvi shares `papers.dump` (about 1.6 MB) outside git; dump files are gitignored. These commands work the same in Git Bash and PowerShell.

**Create the dump** (on the machine that has the data):

```bash
docker compose exec db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --exclude-table-data=users --exclude-table-data=bookmarks --exclude-table-data=audit_log -f /tmp/papers.dump'
docker compose cp db:/tmp/papers.dump ./papers.dump
```

**Restore it** (after `docker compose up -d --wait` and `bash scripts/rebuild_db.sh`):

```bash
docker compose cp ./papers.dump db:/tmp/papers.dump
docker compose exec db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner /tmp/papers.dump'
python ingest/verify_load.py   # expect 4000 papers, 0 counter mismatches
```

Notes:
- `pg_restore` recreates the triggers after it loads the data, so citation counts are restored exactly and not counted twice. This was verified: a restore into a scratch database gave 4,000 papers, 37,988 citations and 0 mismatches.
- The dump holds all papers, authors, conferences and citations, but **no user accounts, bookmarks or audit rows**: the `--exclude-table-data` options keep password hashes out of the file. Run `npm --prefix web run seed:admin` after restoring to create the admin from **your** `.env`.
- Verified on 30 Oct 2026: `rebuild_db.sh` followed by this restore gives `pg_restore` exit 0, 4,000 papers, 37,988 citations, 0 counter mismatches, every paper `pending`, and 0 users.

## 4. Re-run the OpenAlex ingestion

```bash
pip install -r ingest/requirements.txt
python ingest/fetch_openalex.py            # needs OPENALEX_API_KEY; caches ingest/cache/works.jsonl
python ingest/load_papers.py               # safe to repeat: ON CONFLICT DO NOTHING on openalex_id
python ingest/verify_load.py               # counts + citation_count check; exit code 1 on failure
python ingest/fetch_openalex.py --refresh  # download again
```

The dataset is the 4,000 most-cited OpenAlex works whose primary topic is "Natural Language Processing Techniques", all with abstracts.

| Item | Count |
|---|---:|
| Papers | 4,000 |
| Authors | 5,388 |
| Author links | 12,416 |
| Conference/journal editions | 740 |
| Citation edges inside the dataset | 37,988 |

**Every paper starts with `embedding_status = 'pending'`.**

## 5. Hooks the vector side builds on

| Hook | Where | Behaviour |
|---|---|---|
| `papers.embedding_status` | `db/001_schema.sql` | `'pending'` (default), `'done'` or `'failed'`, enforced by a CHECK. The vector pipeline sets `'done'` / `'failed'`. A retry script re-processes `WHERE embedding_status IN ('pending', 'failed')`. |
| `add_paper()` | `db/005_functions.sql`, called by `POST /api/papers` | Inserts with `'pending'` inside one transaction. The response is `{ paper_id, embedding_status: "pending" }`. **Embed after this call returns** (that is, after commit). |
| `PATCH /api/papers/:id` | `web/app/api/papers/[id]/route.ts` | If the title or abstract changes, `embedding_status` is set back to `'pending'`, so the retry script re-embeds the paper. |
| `DELETE /api/papers/:id` | same file | Deletes in PostgreSQL first. A trigger writes `audit_log`. **Delete the Qdrant point after this returns.** An orphan vector is harmless (see section 6). |
| `search_tsv` + `search_papers_keyword()` | `db/006_search.sql` | Keyword ranking for hybrid search. `SELECT paper_id, score FROM search_papers_keyword($1, $2, $3, 0)` returns the ranked keyword list. |
| `/api/search` | `web/app/api/search/route.ts` | `mode=semantic` / `mode=hybrid` currently throw `HttpError(501, "NOT_IMPLEMENTED", "implemented in Part 2")`. Replace that branch. The response shape must stay `{ results, total }`. |

**Hydrating semantic results from PostgreSQL**, keeping Qdrant's order and dropping ids that no longer exist:

```sql
SELECT d.paper_id, d.title, left(d.abstract, 250) AS abstract_snippet, d.year,
       d.conference_name AS conference, d.author_list AS authors, d.citation_count
FROM v_paper_details d
WHERE d.paper_id = ANY($1::int[])
ORDER BY array_position($1::int[], d.paper_id);
```

Add `score` from Qdrant (cosine) or from Reciprocal Rank Fusion before returning. The helpers in `web/lib/db.ts` (`query`, `withTransaction`) and `web/lib/http.ts` (`handle`, `json`, `HttpError`) give the same error shape as every other route.

## 6. Agreed vector interface (not built here)

- **Qdrant collection `papers`:** 384 dimensions, cosine distance. Point id = `paper_id` (integer). Payload `{ paper_id, year }`.
- **Embedding text:** `title + ". " + abstract`. The embedding service exposes `POST /embed`, which returns a 384-d vector (all-MiniLM-L6-v2).
- **Semantic search** returns an ordered list of `paper_id`s with scores. Full records are **always re-fetched from PostgreSQL** (query above). Ids missing from PostgreSQL are dropped, so an orphan vector left after a delete is harmless.
- **Hybrid search** fuses the keyword ranking (`search_papers_keyword`) with the semantic ranking using Reciprocal Rank Fusion: `score = Σ 1 / (60 + rank)` over both lists, where rank starts at 1.
- **PostgreSQL is the source of truth.** Qdrant is written only **after** the SQL transaction commits.

## 7. API list with example curl calls

The full contract is in `docs/API_CONTRACT.md`, and a clickable collection is in `web/tests/requests.http`.

| Method | Route | Access |
|---|---|---|
| GET | `/api/search?q=&mode=keyword\|semantic\|hybrid&page=&year=` | public (semantic and hybrid return 501) |
| GET | `/api/papers?page=&year=` | public |
| GET | `/api/papers/:id` | public |
| POST | `/api/papers` | admin |
| PATCH | `/api/papers/:id` | admin |
| DELETE | `/api/papers/:id` | admin |
| GET | `/api/authors?q=&page=` | public |
| GET | `/api/authors/:id` | public |
| POST | `/api/authors` | admin |
| PATCH | `/api/authors/:id` | admin |
| DELETE | `/api/authors/:id` | admin |
| GET | `/api/conferences?q=&page=` | public |
| GET | `/api/conferences/:id` | public |
| POST | `/api/conferences` | admin |
| PATCH | `/api/conferences/:id` | admin |
| DELETE | `/api/conferences/:id` | admin |
| GET | `/api/bookmarks` | user |
| POST | `/api/bookmarks` | user |
| DELETE | `/api/bookmarks/:paperId` | user |
| GET | `/api/stats/overview` | public |
| GET | `/api/admin/audit-log` | admin |
| POST | `/api/auth/register`, `/api/auth/login`, `/api/auth/logout` | public |
| GET | `/api/auth/me` | user |

```bash
B=http://localhost:3000

# public reads
curl "$B/api/search?q=neural%20machine%20translation&page=1"
curl "$B/api/search?q=bert&mode=semantic"            # 501 until the vector side is built
curl "$B/api/papers/3"
curl "$B/api/authors?q=manning"
curl "$B/api/conferences?q=emnlp"
curl "$B/api/stats/overview"

# log in (the cookie is saved in jar.txt and sent with -b)
curl -c jar.txt -H "Content-Type: application/json" \
     -d '{"email":"admin@example.com","password":"<ADMIN_PASSWORD from .env>"}' "$B/api/auth/login"
curl -b jar.txt "$B/api/auth/me"

# admin writes
curl -b jar.txt -H "Content-Type: application/json" -X POST "$B/api/papers" \
     -d '{"title":"Demo","abstract":"Short abstract.","year":2026,"authors":[{"name":"Demo Author"}],"cited_paper_ids":[3]}'
curl -b jar.txt -H "Content-Type: application/json" -X PATCH "$B/api/papers/4001" -d '{"year":2025}'
curl -b jar.txt -X DELETE "$B/api/papers/4001"
curl -b jar.txt "$B/api/admin/audit-log"

# bookmarks (any logged-in user)
curl -b jar.txt -H "Content-Type: application/json" -X POST "$B/api/bookmarks" -d '{"paper_id":3}'
curl -b jar.txt "$B/api/bookmarks"
curl -b jar.txt -X DELETE "$B/api/bookmarks/3"

curl -b jar.txt -c jar.txt -X POST "$B/api/auth/logout"
```

On Windows PowerShell, call `curl.exe` (not the `curl` alias) and put JSON bodies in a file: `-d "@body.json"`.

**Every error looks like** `{"error":{"code":"...","message":"..."}}`, with codes `VALIDATION_ERROR` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `NOT_IMPLEMENTED` 501 and `INTERNAL_ERROR` 500.

## 8. Tests

```bash
bash scripts/run_tests.sh        # 113 SQL checks; rolled back, safe on loaded data
python ingest/test_common.py     # 10 helper checks
python ingest/verify_load.py     # data checks
bash web/tests/auth_curl.sh      # 20 auth checks (API running)
npm --prefix web run test:api    # 32 route tests incl. exact contract fields (API running)
```

## 9. Known limitations

**Data quality (inherited from OpenAlex):**
- 89 papers have no authors.
- 1,502 papers have no conference: they are arXiv preprints, and a repository is not a venue.
- `location` is never filled.
- Acronyms exist only when the venue name ends in "(XYZ)".
- Some years follow OpenAlex's latest version. For example, "Attention Is All You Need" is listed as 2025.

**Authors:**
- `add_paper()` reuses an author only on the same name + affiliation, so one person with two affiliations becomes two rows.
- Ingested authors keep the affiliation from the first paper loaded.

**Sessions** are stateless signed cookies:
- Logout deletes the cookie in the browser, but a copied cookie stays valid until it expires (7 days).
- Login has no rate limiting.

**Search:**
- English stemming only.
- `year` filters a single year, not a range.
- `ts_rank_cd` scores are relative values (not 0–1); compare them only within one query.

**`citation_count`:** the triggers keep it correct for every insert, delete and update on `citations`, but nothing stops someone editing it by hand in psql. `verify_load.py` detects any mismatch.

**Dev mode:** in `npm run dev`, Next.js compiles each route on its first request (1–2 s once). `npm --prefix web run build && npm --prefix web start` avoids this.

**No UI pages yet.** The front end is the other half of the project.
