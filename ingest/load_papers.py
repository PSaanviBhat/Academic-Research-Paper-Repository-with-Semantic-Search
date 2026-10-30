"""Load the cached OpenAlex works into PostgreSQL.

    py -3.11 ingest/load_papers.py

Safe to run any number of times: every insert uses ON CONFLICT DO NOTHING
(papers and authors are matched by their unique openalex_id), so a second
run adds nothing and creates no duplicates.

Two passes, because a citation needs BOTH papers to exist first:
  Pass 1  conferences -> papers -> authors -> paper_authors (in batches)
  Pass 2  citations, keeping an edge only when both ends are in our dataset,
          so every foreign key holds.

Citations are inserted with plain INSERT statements, so the citation_count
triggers fire for every new edge. The loader never writes citation_count
itself, so the counter cannot be bypassed.

Why not call add_paper() for each paper? add_paper() matches authors by
name + affiliation and inserts citations in the same call. Here authors are
matched by their OpenAlex ID (more reliable, and re-runnable), and citations
can only be added after ALL papers are loaded. add_paper() remains the path
for papers added through the web app.
"""

import json
import re
import time

from common import WORKS_FILE, clean_text, connect, guess_acronym, normalise_doi, rebuild_abstract, short_id

TARGET_PAPERS = 4000     # stop after this many usable papers
MIN_ABSTRACT_WORDS = 25  # very short "abstracts" are usually junk (a sentence or a copyright line)
BATCH = 500


def read_works() -> list[dict]:
    if not WORKS_FILE.exists():
        raise SystemExit(f"{WORKS_FILE} not found. Run: py -3.11 ingest/fetch_openalex.py")
    with WORKS_FILE.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def prepare(works: list[dict]):
    """Clean the raw works and decide which ones to keep.

    Returns (papers, alias, skipped):
      papers  - cleaned dicts for the works we keep
      alias   - every OpenAlex work ID we saw -> the kept ID it stands for
                (a duplicate title points at the copy we kept, so citations
                to either version land on the same paper)
      skipped - reason -> count
    """
    papers, alias, kept_by_title = [], {}, {}
    skipped = {"no title": 0, "abstract missing or too short": 0, "duplicate title": 0, "over target": 0}

    for w in works:
        oid = short_id(w.get("id"))
        title = clean_text(w.get("title"))
        if not oid or not title:
            skipped["no title"] += 1
            continue
        abstract = clean_text(rebuild_abstract(w.get("abstract_inverted_index")))
        if not abstract or len(abstract.split()) < MIN_ABSTRACT_WORDS:
            skipped["abstract missing or too short"] += 1
            continue

        # The same paper often appears twice (arXiv preprint + published version).
        title_key = re.sub(r"[^a-z0-9]", "", title.lower())
        if title_key in kept_by_title:
            alias[oid] = kept_by_title[title_key]
            skipped["duplicate title"] += 1
            continue
        if len(papers) >= TARGET_PAPERS:
            skipped["over target"] += 1
            continue
        kept_by_title[title_key] = oid
        alias[oid] = oid

        year = w.get("publication_year")
        if not isinstance(year, int) or not 1900 <= year <= 2100:
            year = None

        # Venue -> conference row. Conference proceedings and journals become a
        # venue edition (name + year). Preprint servers such as arXiv are
        # repositories, not venues, so those papers get no conference.
        venue = None
        source = (w.get("primary_location") or {}).get("source") or {}
        venue_name = clean_text(source.get("display_name"))
        if venue_name and source.get("type") in ("conference", "journal"):
            venue = (venue_name, guess_acronym(venue_name), year)

        # Authors in byline order; skip repeats of the same author on one paper.
        authors, seen = [], set()
        for a in w.get("authorships") or []:
            au = a.get("author") or {}
            aid, name = short_id(au.get("id")), clean_text(au.get("display_name"))
            if not aid or not name or aid in seen:
                continue
            seen.add(aid)
            institutions = a.get("institutions") or []
            raw = a.get("raw_affiliation_strings") or []
            affiliation = clean_text(institutions[0].get("display_name")) if institutions else (
                clean_text(raw[0]) if raw else None)
            authors.append((aid, name, affiliation))

        papers.append({
            "openalex_id": oid, "title": title, "abstract": abstract, "year": year,
            "doi": normalise_doi(w.get("doi")), "venue": venue, "authors": authors,
            "refs": [short_id(r) for r in (w.get("referenced_works") or [])],
        })
    return papers, alias, skipped


def load(papers: list[dict], alias: dict) -> None:
    with connect() as conn:
        # ---------------- Pass 1a: conferences ----------------
        venues = sorted({p["venue"] for p in papers if p["venue"]}, key=lambda v: (v[0], v[2] or 0))
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO conferences (name, acronym, year) VALUES (%s, %s, %s)
                   ON CONFLICT ON CONSTRAINT conferences_name_year_key DO NOTHING""", venues)
            cur.execute("SELECT name, year, conference_id FROM conferences")
            conf_id = {(n, y): cid for n, y, cid in cur.fetchall()}
        conn.commit()
        print(f"conferences: {len(venues)} venue editions in the data")

        # ---------------- Pass 1b: papers, authors, links (batched) ----------------
        paper_id: dict[str, int] = {}
        for start in range(0, len(papers), BATCH):
            batch = papers[start:start + BATCH]
            with conn.cursor() as cur:
                # ON CONFLICT DO NOTHING (no target) skips a row that clashes
                # with ANY unique constraint: openalex_id on a re-run, or a DOI
                # already used by another paper.
                cur.executemany(
                    """INSERT INTO papers (title, abstract, year, doi, conference_id, openalex_id, embedding_status)
                       VALUES (%s, %s, %s, %s, %s, %s, 'pending')
                       ON CONFLICT DO NOTHING""",
                    [(p["title"], p["abstract"], p["year"], p["doi"],
                      conf_id.get((p["venue"][0], p["venue"][2])) if p["venue"] else None,
                      p["openalex_id"]) for p in batch])
                cur.execute("SELECT openalex_id, paper_id FROM papers WHERE openalex_id = ANY(%s)",
                            ([p["openalex_id"] for p in batch],))
                paper_id.update(dict(cur.fetchall()))

                author_rows = {aid: (name, aff) for p in batch for aid, name, aff in p["authors"]}
                cur.executemany(
                    """INSERT INTO authors (name, affiliation, openalex_id) VALUES (%s, %s, %s)
                       ON CONFLICT (openalex_id) DO NOTHING""",
                    [(name, aff, aid) for aid, (name, aff) in author_rows.items()])
                cur.execute("SELECT openalex_id, author_id FROM authors WHERE openalex_id = ANY(%s)",
                            (list(author_rows),))
                author_id = dict(cur.fetchall())

                links = [(paper_id[p["openalex_id"]], author_id[aid], order)
                         for p in batch if p["openalex_id"] in paper_id
                         for order, (aid, _, _) in enumerate(p["authors"], start=1)]
                cur.executemany(
                    """INSERT INTO paper_authors (paper_id, author_id, author_order) VALUES (%s, %s, %s)
                       ON CONFLICT DO NOTHING""", links)
            conn.commit()   # one transaction per batch: a failure loses at most one batch
            print(f"papers: {min(start + BATCH, len(papers)):5d} / {len(papers)} processed")

        # ---------------- Pass 2: citations inside the dataset ----------------
        edges = set()
        for p in papers:
            citing = paper_id.get(p["openalex_id"])
            if citing is None:
                continue
            for ref in p["refs"]:
                cited = paper_id.get(alias.get(ref))   # alias: a duplicate version maps to the kept one
                if cited is not None and cited != citing:
                    edges.add((citing, cited))
        edges = sorted(edges)
        with conn.cursor() as cur:
            for start in range(0, len(edges), 5000):
                cur.executemany(
                    """INSERT INTO citations (citing_paper_id, cited_paper_id) VALUES (%s, %s)
                       ON CONFLICT DO NOTHING""", edges[start:start + 5000])
        conn.commit()
        print(f"citations: {len(edges)} edges where both papers are in the dataset")


def main() -> None:
    started = time.time()
    works = read_works()
    papers, alias, skipped = prepare(works)
    print(f"read {len(works)} works from cache; keeping {len(papers)}")
    for reason, n in skipped.items():
        if n:
            print(f"  skipped ({reason}): {n}")
    load(papers, alias)
    print(f"done in {time.time() - started:.1f}s. Check the result with: py -3.11 ingest/verify_load.py")


if __name__ == "__main__":
    main()
