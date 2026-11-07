# Demo script (about 12 minutes)

Run through this once before the viva. Every command runs from the repository root.

## Before the demo (5 minutes beforehand)

Open four terminals:

| Terminal | Command | Leave it running? |
|---|---|---|
| 1 | `docker compose up -d --wait` | no |
| 2 | `embed/.venv/bin/uvicorn --app-dir embed app:app --port 8001` | **yes** |
| 3 | `npm --prefix web run build && npm --prefix web start` | **yes** (a production build has no first-request compile delay) |
| 4 | free, for the commands below | – |

In terminal 4, check everything is in sync:

```bash
embed/.venv/bin/python embed/sync.py --check     # expect: 0 missing, 0 orphans
```

Open http://localhost:3000 and log in as the admin in a second browser window.

---

## 1. The problem (1 min)

> "Keyword search only finds papers that share words with the query. Researchers often describe a topic in their own words."

- Search page, **Keyword** mode: `teaching machines to understand human language`.
- Point out: **0 results**. Keyword search needs every word (teach, machine, understand, human, language) in the same paper, and no paper says it that way.

## 2. Semantic search (2 min)

- Switch the toggle to **Semantic** (same query).
- Point out: NLP and language-understanding papers rank at the top, even though they never use these words.
- Explain the flow on the architecture slide: query → embedding service (384-d) → Qdrant top-100 by cosine → ids re-read from PostgreSQL.
- Second query: `fixing typos in what people type`. Keyword finds 0 papers; semantic search returns spelling and grammatical error correction papers.
- Optional honest limit: `making long documents shorter automatically` misses the summarisation papers (see example 6 in `docs/semantic_vs_keyword.md`). The small model matches "length", not the task.

## 3. Hybrid search (1 min)

- Switch to **Hybrid**.
- Explain RRF: score = Σ 1/(60 + rank). It uses ranks rather than raw scores, because `ts_rank_cd` and cosine are on different scales. A paper both methods agree on rises to the top.
- Hover the score to show the formula tooltip.
- Add the year filter (for example 2019) to show it works in every mode.

## 4. Paper detail and relationships (1 min)

- Open a result: authors in order, venue, abstract, **References** and **Cited by**.
- Point out that the "Cited by" count equals `citation_count`, which a trigger maintains.
- Press **Bookmark**, then open the Bookmarks page.

## 5. Consistency between the two databases (3 min), the key DBMS point

1. **Admin → Add paper.** Title: `Photosynthesis in deep sea coral reefs`. Abstract: `Coral reef organisms in the deep ocean convert faint light into chemical energy.` One author. Save.
   - Say: "`add_paper()` inserts the paper, authors and citations in **one transaction**, with status `pending`. After the commit, the server embeds it and upserts it to Qdrant."
2. Open the paper: the badge says **embedding: done**.
3. Search **Semantic**: `how underwater reef creatures make energy from light` → it is result 1, with no shared keywords.
4. **Failure demo.** Stop terminal 2 (Ctrl+C), then add another paper.
   - Open it: **embedding: failed**. The paper is still saved, and it still shows up in keyword search.
   - Say: "PostgreSQL is the source of truth; a vector failure never loses data."
5. Restart terminal 2, then run in terminal 4:
   ```bash
   embed/.venv/bin/python embed/sync.py
   ```
   It embeds only that one paper. Refresh the page: **done**.
6. **Delete** the coral paper (Admin → Edit paper → Delete).
   - **Audit log** tab: a new row with your admin email, written by the trigger.
   - In terminal 4, run `embed/.venv/bin/python embed/sync.py --check`: 0 orphans, because the point was deleted after the SQL commit.
   - Say: "Even if that Qdrant delete had failed, search re-reads every id from PostgreSQL and drops missing ones, so an orphan vector can never show a deleted paper."

## 6. Transaction rollback (1 min)

- Admin → Add paper with cited paper id `999999`. The error says nothing was saved.
- Optional, in a terminal: `bash scripts/psql.sh -f /db/demo/add_paper_rollback_demo.sql`

## 7. Statistics dashboard (1 min)

- `/stats`: totals, papers per year (hover a bar, then switch to the table view), most cited papers, top authors, top venues. These come from the SQL views behind `/api/stats/overview`.

## 8. Wrap-up (30 s)

> "PostgreSQL handles structure: constraints, joins, triggers, transactions and full-text search. Qdrant handles meaning: approximate nearest-neighbour search over 384-d embeddings. `embedding_status`, writes after commit, a retry script and re-reading results from PostgreSQL keep them consistent."

---

## If something goes wrong

| Symptom | Fix |
|---|---|
| Semantic/hybrid return a 503 error | The embedding service (terminal 2) is not running |
| Semantic returns nothing | Qdrant is empty: `embed/.venv/bin/python embed/sync.py` |
| Login fails | `npm --prefix web run seed:admin` |
| Port 3000 busy | `npm --prefix web start -- -p 3001` |
