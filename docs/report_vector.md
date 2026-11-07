# Vector Database, Semantic Search and Integration (report draft)

*Draft section for the project report, covering the Qdrant half and the PostgreSQL–Qdrant integration. The relational half is in `docs/report_rdbms.md`. Worked search examples are in `docs/semantic_vs_keyword.md`.*

---

## 1. Why keyword search is not enough

Keyword search finds a paper only if it shares words with the query. PostgreSQL full-text search improves on plain `LIKE` with stemming and ranking ("translating" matches "translation"), but it still matches *words*, not *meaning*.

A researcher who types *"teaching machines to understand human language"* is describing natural language processing. A paper that only ever says "natural language processing" or "language understanding" shares almost no stemmed words with that query, so keyword search ranks it low or misses it. Semantic search solves this by comparing *meanings*: the query and every abstract are turned into vectors, and papers are ranked by how close their vectors are to the query's vector.

## 2. Embeddings

| Item | Choice |
|---|---|
| Model | `sentence-transformers/all-MiniLM-L6-v2` |
| Dimensions | 384 |
| Input text per paper | `title + ". " + abstract` (title alone if there is no abstract) |
| Normalisation | Unit length, so cosine similarity = dot product |
| Where | `embed/common.py`, shared by the service (`embed/app.py`) and the sync script (`embed/sync.py`) |

**Why this model.** It is small (about 90 MB, 22 M parameters), runs on a laptop CPU (all 4,000 abstracts were embedded in 50 seconds on a MacBook Air) and is trained specifically for sentence similarity. A larger model would give better rankings on some topics (see the limitation below) but would slow every query and the bulk load, without changing anything in the database design.

**Embedding service.** `embed/app.py` is a FastAPI service with `POST /embed`: `{"text": "..."}` returns `{"vector": [384 floats], "dim": 384}`. The model is loaded once at start-up. The Next.js API calls it to embed each search query and each new or edited paper.

## 3. The Qdrant collection

| Setting | Value | Reason |
|---|---|---|
| Name | `papers` | Agreed interface |
| Vector size | 384 | Matches the model |
| Distance | Cosine | Standard for sentence embeddings; direction matters, not length |
| Point id | `paper_id` | One point per paper; upsert overwrites, never duplicates |
| Payload | `{ paper_id, year }` | `year` enables filtered search |
| Payload index | `year` (integer) | The year filter does not scan every point |
| Index | HNSW (Qdrant default) | Approximate nearest neighbour in roughly logarithmic time |

**HNSW.** Comparing the query with all 4,000 vectors would be cheap here, but does not scale. Qdrant builds a *Hierarchical Navigable Small World* graph: each vector links to a few close neighbours, in several layers from coarse to fine. A search enters at the top layer and walks greedily towards the query, so it visits only a small fraction of the points. The result is *approximate*: on rare occasions a true neighbour is missed, a trade-off every vector database makes for speed.

## 4. Why two databases

| Need | PostgreSQL | Qdrant |
|---|---|---|
| Joins (paper–author–conference–citation) | Yes, the core of the model | No joins |
| Constraints, foreign keys, CHECKs | Yes | No |
| Transactions, triggers, views | Yes | No |
| Full-text keyword search | Yes (`tsvector`, GIN) | No |
| Nearest-neighbour search over vectors | Only with an extension | Yes, purpose-built (HNSW, filtering, quantisation) |

Each system does what it is best at, and neither replaces the other. PostgreSQL holds every fact and every rule. Qdrant holds one derived artefact per paper (its vector), which can always be rebuilt from PostgreSQL.

**Considered alternative: pgvector.** The `pgvector` extension stores vectors in a PostgreSQL column with an HNSW index, which would remove the need for a second system and make consistency automatic (one transaction). It is the simpler choice for a production system of this size. A separate Qdrant instance was chosen deliberately, so that the project shows a real two-database integration problem and how to solve it (section 5).

## 5. Keeping PostgreSQL and Qdrant consistent

The two databases cannot share a transaction. If both were written inside one request and the second write failed, they would disagree. The design accepts this and makes every disagreement **detectable, harmless and repairable**.

**Rule 1: PostgreSQL is the source of truth, and Qdrant is written only after the SQL commit.**

| Operation | Order |
|---|---|
| Add paper (`POST /api/papers`) | `add_paper()` commits with `embedding_status = 'pending'` → response sent → embed and upsert to Qdrant → `'done'` (or `'failed'`) |
| Edit title/abstract (`PATCH`) | `UPDATE` commits and sets `'pending'` → response sent → re-embed and upsert → `'done'` |
| Edit year (`PATCH`) | `UPDATE` commits → upsert refreshes the payload |
| Delete (`DELETE`) | `DELETE` commits (trigger writes `audit_log`) → response sent → delete the Qdrant point |

The Qdrant write runs in Next.js `after()`, after the response has been sent, so a slow or failed embedding never fails or delays an admin's request.

**Rule 2: `embedding_status` records what Qdrant is known to hold.**
- `pending`: no vector yet, or the text changed since the last one.
- `done`: Qdrant has a vector for the current text.
- `failed`: the last attempt failed.

**Rule 3: a retry script repairs everything that is not `done`.** `embed/sync.py` embeds every `pending` or `failed` paper in batches of 64 and upserts them. Run once, it is the bulk loader for all 4,000 papers. Run again, it does nothing. `sync.py --check` compares the two databases and `--check --fix` repairs drift in either direction.

**Rule 4: search results are always re-read from PostgreSQL.** Qdrant returns only ids and scores. The API then runs:

```sql
SELECT ... FROM v_paper_details d
WHERE d.paper_id = ANY($1::int[])
ORDER BY array_position($1::int[], d.paper_id);
```

This keeps Qdrant's ranking and **drops ids that no longer exist**. An orphan vector left behind by a failed delete can never show a deleted paper.

**A race that is handled.** Suppose an admin edits a paper's abstract while `sync.py` is embedding the old text. Without care, the sync would mark the paper `done` with a vector of the *old* text. To prevent this, the `'done'` update compares a hash of the current text with the hash of the text that was embedded:

```sql
UPDATE papers SET embedding_status = 'done'
WHERE paper_id = $1
  AND md5(title || '. ' || abstract) = $2;   -- hash of the text that was embedded
```

If the text changed, no row is updated, the paper stays `pending`, and the next sync embeds the new text.

**Failure scenarios.**

| Failure | Effect | Recovery |
|---|---|---|
| Embedding service down when a paper is added | Paper saved, marked `failed`; not yet in semantic results (still in keyword results) | `sync.py` |
| Qdrant down when a paper is deleted | Orphan vector remains; never shown (dropped at hydration) | `sync.py --check --fix` |
| Edit during a sync | Paper stays `pending` (hash check) | Next `sync.py` |
| Qdrant data lost entirely | Semantic search returns nothing | `UPDATE papers SET embedding_status = 'pending'`, then `sync.py` rebuilds every vector from PostgreSQL |
| Embedding service down during a search | Semantic/hybrid return `503 SERVICE_UNAVAILABLE`; keyword search still works | Restart the service |

## 6. Search modes

All three modes return the same response shape, and all three read their records from PostgreSQL.

**Keyword.** `search_papers_keyword()` in PostgreSQL: `websearch_to_tsquery` over the weighted `search_tsv` column (title A, abstract B), ranked by `ts_rank_cd`. Covered in the RDBMS report.

**Semantic.**
1. Embed the query (`POST /embed`).
2. Ask Qdrant for the 100 nearest papers by cosine similarity, with a payload filter on `year` if one is given.
3. Re-read those ids from PostgreSQL in Qdrant's order (Rule 4) and return the requested page of 10.

**Hybrid: Reciprocal Rank Fusion.** Keyword scores (`ts_rank_cd`, unbounded) and cosine similarities (between −1 and 1) are on different scales, so adding them would be meaningless. RRF uses only each paper's **rank** in each list:

> score(p) = Σ over lists containing p of 1 / (60 + rank(p))

with ranks starting at 1. A paper ranked 1st by both lists scores 2/61 ≈ 0.0328. A paper ranked 1st by only one scores 1/61 ≈ 0.0164, about the same as a paper ranked around 30th in both. Agreement between the two methods is therefore rewarded, while a strong match in either one still shows up. The constant 60 (from the original RRF paper) damps the gap between the very top ranks. The two top-100 lists are fused, sorted by RRF score, then hydrated and paginated like semantic results.

**Results and limits.** `docs/semantic_vs_keyword.md` compares the three modes on six everyday-language queries. For three of them keyword search finds **no** paper at all, while semantic search returns the right literature: language understanding, spelling correction, named entity recognition. When the query shares words with the papers ("computers that translate between languages"), keyword search works as well. The small model also has limits: for "making long documents shorter automatically" it matches the idea of *length* rather than *summarisation*, so neither mode finds the 81 summarisation papers in the dataset. Hybrid search cannot recover what both lists miss.

**Pagination of semantic and hybrid results.** Nearest-neighbour search has no natural "number of matches": every paper has *some* similarity to every query. Both modes therefore rank a fixed candidate pool (the top 100 from each source), and `total` is the size of that pool.

## 7. Testing summary

| What | Command | Checks |
|---|---|---|
| Embedding helpers | `embed/.venv/bin/python embed/test_embed.py` | 384-d unit vectors, related text closer than unrelated, Python and SQL hashes agree |
| API, including the vector side | `npm --prefix web run test:api` | Semantic and hybrid have the exact contract fields, scores sorted, cosine ≤ 1, RRF ≤ 2/61, year filter, pagination; **end-to-end consistency**: a new paper becomes `done` and is found by meaning, an edit re-embeds it, a delete removes its point |
| Drift check | `embed/.venv/bin/python embed/sync.py --check` | Every `done` paper has a vector, and no orphan vectors |
| Examples | `embed/.venv/bin/python embed/compare_modes.py` | Regenerates `docs/semantic_vs_keyword.md` |
