# API Contract

This is the agreed interface between the database/API side and the front end. **Field names are frozen.** Any change after handoff must be agreed by both teammates first and recorded in `docs/DECISIONS.md`.

- Base URL in development: `http://localhost:3000`
- All request and response bodies are JSON (`Content-Type: application/json`).
- Timestamps are ISO 8601 strings in UTC, for example `"2026-10-30T09:15:00.000Z"`.
- IDs are integers.

## Conventions

### Authentication
- Logging in sets an **HTTP-only, signed session cookie** named `session`. Browsers send it automatically. With curl, use a cookie jar (`-c jar.txt -b jar.txt`).
- Each route below is marked with one of three access levels:
  - **public** needs no session.
  - **user** needs any logged-in user.
  - **admin** needs a user whose role is `admin`.

### Errors
Every error uses the same shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "year must be an integer" } }
```

| HTTP | code               | When |
|------|--------------------|------|
| 400  | `VALIDATION_ERROR` | Missing or badly formed input |
| 401  | `UNAUTHENTICATED`  | No valid session, or wrong email/password at login |
| 403  | `FORBIDDEN`        | Logged in, but the role is not allowed |
| 404  | `NOT_FOUND`        | The ID does not exist |
| 409  | `CONFLICT`         | A unique rule would be broken (duplicate email, DOI, bookmark, conference name + year) |
| 501  | `NOT_IMPLEMENTED`  | `mode=semantic` / `mode=hybrid` until the vector side is built |
| 500  | `INTERNAL_ERROR`   | Unexpected server error |

### Pagination
List endpoints take `page` (1-based, default `1`) and return `{ "results": [...], "total": <int> }`. `total` is the number of matching rows across all pages. The page size is fixed at **10** for search and **20** for the other lists.

### Shared objects

`PaperSummary` is used in search results, lists and bookmarks:

```json
{
  "paper_id": 42,
  "title": "Attention Is All You Need",
  "year": 2017,
  "conference": "NeurIPS",
  "authors": ["Ashish Vaswani", "Noam Shazeer"],
  "citation_count": 118
}
```

- `conference` is the conference name as a string, or `null` if the paper has none.
- `authors` holds author names in author order.

`User`:

```json
{ "user_id": 1, "name": "Saanvi", "email": "saanvi@example.com", "role": "researcher", "created_at": "..." }
```

`role` is `"researcher"` or `"admin"`. The password hash is never returned.

---

## Search

### `GET /api/search` (public)

| Param | Required | Notes |
|-------|----------|-------|
| `q`    | yes | Free text. Keyword mode accepts web-search syntax: `"exact phrase"`, `-exclude`, `or` |
| `mode` | no  | `keyword` (default), `semantic` or `hybrid` |
| `page` | no  | Default `1` |
| `year` | no  | Only papers from this year |

**200**

```json
{
  "results": [
    {
      "paper_id": 42,
      "title": "Attention Is All You Need",
      "abstract_snippet": "The dominant sequence transduction models are based on ...",
      "year": 2017,
      "conference": "NeurIPS",
      "authors": ["Ashish Vaswani", "Noam Shazeer"],
      "citation_count": 118,
      "score": 0.4123
    }
  ],
  "total": 57
}
```

- Results are ordered by `score`, highest first.
- **keyword**: `score` is PostgreSQL `ts_rank_cd` over the weighted title (A) + abstract (B) text.
- **semantic**: `score` is cosine similarity from Qdrant.
- **hybrid**: `score` is the Reciprocal Rank Fusion score, the sum of `1 / (60 + rank)` over the keyword and semantic lists.
- Every mode returns this exact shape. Full records always come from PostgreSQL.

**501** for `mode=semantic` or `mode=hybrid` until the vector side is built:

```json
{ "error": { "code": "NOT_IMPLEMENTED", "message": "implemented in Part 2" } }
```

**400** if `q` is missing or empty, or if `mode`, `page` or `year` is invalid.

---

## Papers

### `GET /api/papers` (public)
Lists papers, newest first. Params: `page`, `year` (optional).
**200** returns `{ "results": [PaperSummary], "total": 4210 }`.

### `GET /api/papers/:id` (public)
**200**

```json
{
  "paper_id": 42,
  "title": "Attention Is All You Need",
  "abstract": "The dominant sequence transduction models ...",
  "year": 2017,
  "doi": "10.48550/arxiv.1706.03762",
  "citation_count": 118,
  "embedding_status": "pending",
  "created_at": "...",
  "conference": { "conference_id": 3, "name": "NeurIPS", "acronym": "NeurIPS", "year": 2017, "location": null },
  "authors": [
    { "author_id": 7, "name": "Ashish Vaswani", "affiliation": "Google Brain", "author_order": 1 }
  ],
  "references": [ { "paper_id": 10, "title": "...", "year": 2014, "citation_count": 300 } ],
  "cited_by":   [ { "paper_id": 88, "title": "...", "year": 2019, "citation_count": 12 } ]
}
```

- `references` are the papers this paper cites.
- `cited_by` are the papers that cite this paper. Its length always equals `citation_count`.
- `conference` is `null` if the paper has no conference.

**404** if the id does not exist.

### `POST /api/papers` (admin)
Creates a paper **atomically** through the database function `add_paper()`. Either the paper, its authors and its citations are all saved, or nothing is.

```json
{
  "title": "My Paper",
  "abstract": "...",
  "year": 2025,
  "doi": "10.1234/abcd",
  "conference_id": 3,
  "authors": [ { "name": "A. Author", "affiliation": "PES University" }, { "name": "B. Author" } ],
  "cited_paper_ids": [10, 11]
}
```

- Required: `title` and `authors` (at least 1).
- `abstract`, `year`, `doi`, `conference_id`, `cited_paper_ids` and each author's `affiliation` are optional.
- Authors are matched by name + affiliation; new ones are created.

**201** returns `{ "paper_id": 4211, "embedding_status": "pending" }`.

The new paper always starts with `embedding_status = "pending"`. The vector side embeds it after this call returns.

Errors:
- **400** for invalid input, including a `cited_paper_ids` entry or `conference_id` that does not exist.
- **409** for a duplicate DOI.

### `PATCH /api/papers/:id` (admin)
Body: any of `title`, `abstract`, `year`, `doi`, `conference_id` (`null` clears it). Authors and citations are not edited here.

If `title` or `abstract` changes, `embedding_status` is reset to `"pending"` so the vector side re-embeds the paper.

**200** returns the same body as `GET /api/papers/:id`. **400 / 404 / 409** as usual.

### `DELETE /api/papers/:id` (admin)
Deletes the paper. Its author links, citations and bookmarks are removed by `ON DELETE CASCADE`. A database trigger writes an `audit_log` row recording which admin deleted it.

**200** returns `{ "paper_id": 42, "deleted": true }`. **404** if it does not exist.

---

## Authors

### `GET /api/authors` (public)
Params: `q` (optional, fuzzy name match), `page`.
**200**

```json
{ "results": [ { "author_id": 7, "name": "Ashish Vaswani", "affiliation": "Google Brain", "paper_count": 3, "total_citations": 140 } ], "total": 1 }
```

### `GET /api/authors/:id` (public)
**200** returns the author fields above plus `"papers": [PaperSummary]`. **404** if not found.

### `POST /api/authors` (admin)
Body: `{ "name": "...", "affiliation": "..." }`. `name` is required.
**201** returns `{ "author_id", "name", "affiliation" }`.

### `PATCH /api/authors/:id` (admin)
Body: `name` and/or `affiliation`. **200** returns the updated author. **404** if not found.

### `DELETE /api/authors/:id` (admin)
Removes the author and their paper links; the papers stay. **200** returns `{ "author_id": 7, "deleted": true }`.

---

## Conferences

### `GET /api/conferences` (public)
Params: `q` (optional, name or acronym contains), `page`.
**200**

```json
{ "results": [ { "conference_id": 3, "name": "NeurIPS", "acronym": "NeurIPS", "year": 2017, "location": null, "paper_count": 25, "total_citations": 410 } ], "total": 1 }
```

### `GET /api/conferences/:id` (public)
**200** returns the conference fields above plus `"papers": [PaperSummary]`. **404** if not found.

### `POST /api/conferences` (admin)
Body: `{ "name", "acronym", "year", "location" }`. `name` is required.
**201** returns the conference. **409** if the name + year already exists.

### `PATCH /api/conferences/:id` (admin)
Body: any of the four fields. **200** returns the conference. **404 / 409** as usual.

### `DELETE /api/conferences/:id` (admin)
Its papers are kept, and their `conference` becomes `null` (`ON DELETE SET NULL`).
**200** returns `{ "conference_id": 3, "deleted": true }`.

---

## Bookmarks (for the logged-in user)

### `GET /api/bookmarks` (user)
Params: `page`.
**200**

```json
{ "results": [ { "paper_id": 42, "title": "...", "year": 2017, "conference": "NeurIPS", "authors": ["..."], "citation_count": 118, "bookmarked_at": "..." } ], "total": 1 }
```

### `POST /api/bookmarks` (user)
Body: `{ "paper_id": 42 }`.
**201** returns `{ "paper_id": 42, "bookmarked_at": "..." }`.
- **404** if the paper does not exist.
- **409** if it is already bookmarked.

### `DELETE /api/bookmarks/:paperId` (user)
**200** returns `{ "paper_id": 42, "deleted": true }`. **404** if the bookmark does not exist.

---

## Statistics

### `GET /api/stats/overview` (public)
**200**

```json
{
  "totals": { "papers": 4210, "authors": 9800, "citations": 15230, "conferences": 310 },
  "top_cited": [ { "paper_id": 42, "title": "...", "year": 2017, "conference": "NeurIPS", "citation_count": 118 } ],
  "papers_per_year": [ { "year": 2017, "paper_count": 310 } ],
  "conference_stats": [ { "conference_id": 3, "name": "NeurIPS", "acronym": "NeurIPS", "year": 2017, "paper_count": 25, "total_citations": 410 } ],
  "top_authors": [ { "author_id": 7, "name": "Ashish Vaswani", "paper_count": 3, "total_citations": 140 } ]
}
```

- `top_cited`, `conference_stats` and `top_authors` hold the top 10 each.
- `papers_per_year` is sorted by year, oldest first.

---

## Authentication

### `POST /api/auth/register` (public)
Body: `{ "name", "email", "password" }`.
- The password must be at least 8 characters.
- The email is stored in lowercase.
- New accounts are always `researcher`. Admins are created by a seed script.

**201** returns `{ "user": User }` and also logs the user in (sets the cookie).
- **400** for invalid input.
- **409** if the email is already registered.

### `POST /api/auth/login` (public)
Body: `{ "email", "password" }`.
**200** returns `{ "user": User }` and sets the cookie. **401** for a wrong email or password; the message does not say which one was wrong.

### `POST /api/auth/logout` (public)
Clears the cookie. **200** returns `{ "ok": true }`.

### `GET /api/auth/me` (user)
**200** returns `{ "user": User }`. **401** if not logged in.
