# Decisions and deviations

This file records every place where the build differs from, or adds detail to, `docs/proposal.pdf`, along with the reason.

## Environment

**Postgres runs on host port 5433, not 5432.**
- Another local Postgres container already uses 5432 on the development machine.
- The port is set by `PG_PORT` in `.env`. Inside Docker, Postgres still listens on 5432.
- Anyone with 5432 free can set `PG_PORT=5432` and change `DATABASE_URL` to match.

**Qdrant image pinned to `qdrant/qdrant:v1.15.4`.**
- Both teammates get the exact same version.
- The image comes up empty; the vector side creates the collection.

**SQL runs through the container (`scripts/psql.sh`).**
- No local `psql` install is needed.
- PowerShell versions (`scripts/*.ps1`) exist for Windows. Windows PowerShell 5.1 mangles quoted arguments, so the `.ps1` helper reads the database user and name from `.env` instead of relying on shell expansion inside the container.

**OpenAlex needs a free API key.**
- The proposal says the OpenAlex API needs no key. The current OpenAlex documentation (last updated 15 Oct 2026) says keyless requests can only fetch the first page, and cursor paging needs a free key.
- The key goes in `.env` as `OPENALEX_API_KEY` and is never committed.

**The proposal PDF is copied to `docs/proposal.pdf`.**
- The synopsis is moved to `docs/synopsis.pdf` and `docs/synopsis.docx`.

## API contract

**`POST /api/papers` is built on the database/API side.**
- Section 9 of the proposal tags it as front-end work, but the work-division table (Section 10) puts "papers CRUD (create calls add_paper)" on the database/API side.
- Section 10 is followed. The front end only calls it.

**Additions to the frozen fields (no frozen field was renamed or removed):**
- `/api/search` accepts an optional `year` parameter, because Section 5 of the proposal promises a year filter.
- Page size is fixed at 10 for search and 20 for other lists.
- The detail endpoint names the two citation lists `references` (papers this paper cites) and `cited_by` (papers citing it).
- `conference` in search results is the conference name as a string.
- The front end needs a few more routes than the four in the proposal, so these are added: admin `POST/PATCH/DELETE` for authors and conferences, `GET /api/papers` and `GET /api/authors`.
- Every error uses one JSON shape: `{ "error": { "code", "message" } }`.

**`PATCH /api/papers/:id` resets `embedding_status` to `pending` when the title or abstract changes.**
- Otherwise the stored vector would describe old text, and the vector side would have no way to know.

## Schema

**`openalex_id TEXT UNIQUE` is added to `papers` and `authors`.**
- This lets the ingestion script be re-run safely with `ON CONFLICT (openalex_id) DO NOTHING`.

**`audit_log.paper_id` is not a foreign key.**
- The log must keep describing a paper after the paper is deleted.
- An FK would either block the delete (RESTRICT) or wipe the log row (CASCADE).

**`audit_log.admin_id` references `users` with `ON DELETE SET NULL`.**
- The history stays even if the admin account is removed.

**Primary keys use `GENERATED ALWAYS AS IDENTITY` instead of `SERIAL`.**
- This is the SQL-standard form, and it stops clients from supplying their own IDs by mistake.

**Extra integrity checks beyond the proposal table (all cheap, and each blocks a real kind of bad data):**
- `users.email` must be lowercase and contain `@`, so `A@x.com` and `a@x.com` cannot be two accounts. `users.name` is NOT NULL.
- `users.role` is NOT NULL and defaults to `'researcher'`.
- `conferences` uses `UNIQUE NULLS NOT DISTINCT (name, year)`, so two rows with the same name and an unknown year also count as duplicates.
- `papers.doi` must be lowercase and start with `10.`, the normalised DOI form.
- `papers.year` and `conferences.year` must be between 1900 and 2100.
- Titles and names cannot be blank (whitespace only).
- `paper_authors.author_order >= 1`, and `UNIQUE (paper_id, author_order)` stops two authors sharing a position.

**The rebuild drops and recreates the `public` schema, not the whole database.**
- It has the same effect (every table, view, function, trigger and row is removed), and it does not need to disconnect other sessions or reconnect to a different database.

**The rebuild leaves the `db/` folder mounted read-only in the Postgres container at `/db`.**
- SQL tests can then load shared files (such as `db/seed/test_seed.sql`) with `\i /db/...`, without copying them in.

## Database features

**There is a third citation trigger, `AFTER UPDATE OF cited_paper_id`.**
- The proposal lists insert and delete triggers only.
- If a citation row were re-pointed to another paper, both papers' counters would silently go wrong. The update trigger moves one count from the old paper to the new one.

**`v_paper_details` has an extra column, `author_list` (an ordered `TEXT[]`).**
- It sits next to the required `string_agg` display string.
- The API contract needs `authors` as a JSON array, and an array is easier to work with than splitting a string.

**`v_top_cited_papers` uses `RANK()` and has no LIMIT.**
- Ties share a rank.
- The API decides how many rows to show (`LIMIT 10`).

**Choices inside `add_paper()`:**
- **Author matching.** An existing author is reused only when both the name (case-insensitive) and the affiliation match. Two different people can share a name, so matching on name alone would merge them. The trade-off is that the same person listed with two different affiliations becomes two author rows.
- **DOI normalisation.** The DOI is stored in its normalised form (lowercase, `https://doi.org/` prefix removed), so `https://doi.org/10.1/ABC` and `10.1/abc` are caught as duplicates.
- **Duplicate citation IDs.** A cited paper ID listed twice is silently de-duplicated instead of failing the whole call.
- **Error codes.** Input errors raise SQLSTATE `22023` (invalid_parameter_value) with a readable message. Constraint errors keep their own codes (`23503`, `23505`). The API maps both kinds to 400 or 409.
- **Concurrency limit.** Two admins adding the same brand-new author at the same instant could create two author rows. This is acceptable at this project's scale and documented as a known limitation.

**Added `db/demo/add_paper_rollback_demo.sql`, a live viva demo.**
- It lets PostgreSQL print the real foreign-key error and then shows the row counts unchanged.
- It runs inside `BEGIN ... ROLLBACK`, so it never changes the database.

## Data ingestion

**Dataset.**
- The data is OpenAlex works whose *primary* topic is "Natural Language Processing Techniques" (topic `T10181`), filtered with `has_abstract:true` and sorted by `cited_by_count:desc`. 4,500 works are downloaded and 4,000 kept.
- Taking the most-cited papers of one topic gives a dense citation graph inside the dataset: about 38,000 internal edges for 4,000 papers.

**Venue to conference.**
- Conference and journal sources become `conferences` rows, one per (venue name, year).
- Preprint repositories such as arXiv are not venues, so those papers have `conference_id = NULL`.
- `acronym` is taken from a trailing "(EMNLP)" in the venue name when present. `location` is not in OpenAlex, so it stays NULL.

**Duplicates.**
- OpenAlex often lists a preprint and its published version as two works. Papers are de-duplicated by normalised title.
- Citations to the dropped copy are redirected to the kept copy.

**Junk abstracts.**
- Abstracts shorter than 25 words are skipped. They are usually a single sentence or a copyright line, which would make poor search and embedding text.

**Author affiliation.**
- An author's affiliation is their first institution on the first paper loaded. The `authors` table holds one affiliation per author.

**Ingestion inserts rows directly instead of calling `add_paper()`.**
- Authors are matched by OpenAlex ID, which is more reliable than name + affiliation and makes the load re-runnable.
- Citations can only be inserted after *all* papers exist (a second pass).
- The citation triggers still fire for every edge, because the loader never writes `citation_count` itself. `verify_load.py` proves that every counter matches `COUNT(*)`.

**The download is cached in `ingest/cache/works.jsonl` (gitignored).**
- Re-running the loader does not hit the API again.
- The API key is sent in the `Authorization` header, never in the URL.

**Python dependencies are installed into the existing Python 3.11, not a new virtual environment.**
- That install already had `requests`, `python-dotenv` and `tenacity`. Only `psycopg[binary]` was added.

**SQL tests empty the tables at the start of their own transaction (`TRUNCATE ... CASCADE`).**
- They then give the same result on an empty or a fully loaded database.
- The final `ROLLBACK` restores every real row.

## Web API

**Session is a stateless HMAC-signed cookie.**
- The cookie holds `{uid, exp}` signed with `SESSION_SECRET`, with flags HttpOnly, SameSite=Lax, a 7-day expiry, and Secure in production. There is no session table.
- It is simple and easy to explain, and it needs no extra library (Node's built-in `crypto`).
- The role is **not** trusted from the cookie. Every request reloads the user from `users`, so a role change or deleted account takes effect at once.
- Trade-off: logout only deletes the cookie in the browser. A copied cookie stays valid until it expires. A session table would allow server-side revocation, but is not needed at this scale.

**Passwords: bcryptjs (pure JavaScript, no native build step on Windows) at cost 10.**
- Passwords longer than 72 bytes are rejected, because bcrypt silently ignores anything after byte 72.
- Login runs a bcrypt comparison even for unknown emails and returns one generic message, so the response does not reveal which emails are registered.

**Admins are created only by `npm --prefix web run seed:admin`, using the `ADMIN_*` values in `.env`.**
- Registration always creates a `researcher`. A `role` field in the request body is ignored.

**Added `GET /api/admin/audit-log` (admin only).**
- It exposes the rows written by the delete trigger, so the audit trail is visible through the API.
- It is also the admin-only route used to test the role guard.

**The Next.js app reads the single `.env` at the repository root** (`next.config.ts` loads it). Postgres, Python and the web app share one configuration file.
