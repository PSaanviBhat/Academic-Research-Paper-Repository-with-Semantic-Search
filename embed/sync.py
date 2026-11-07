"""Keep Qdrant in step with PostgreSQL (PostgreSQL is the source of truth).

Run from the repository root:
    embed/.venv/bin/python embed/sync.py            # embed every 'pending' or 'failed' paper
    embed/.venv/bin/python embed/sync.py --all      # re-embed every paper
    embed/.venv/bin/python embed/sync.py --check    # report drift between the two databases
    embed/.venv/bin/python embed/sync.py --check --fix   # ...and repair it

The same command is the bulk loader (first run: all 4,000 papers are pending)
and the retry script (later runs: only papers that were added, edited or failed).
Running it twice in a row does nothing the second time.

For each batch:
  1. read paper_id, title, abstract, year from PostgreSQL
  2. embed title + ". " + abstract
  3. upsert to Qdrant: point id = paper_id, payload {paper_id, year}
  4. set embedding_status = 'done', but only if the text is unchanged since step 1
     (if an admin edited it meanwhile, it stays 'pending' and the next run picks it up)
If steps 2-3 fail, the batch is marked 'failed' and the run continues.
"""

import argparse
import sys
import time

import psycopg
from qdrant_client import QdrantClient, models

from common import COLLECTION, DATABASE_URL, DIM, QDRANT_URL, embed, paper_text, text_hash, text_hash_sql

BATCH = 64


def ensure_collection(qdrant: QdrantClient) -> None:
    """Create the 'papers' collection (384-d, cosine) and a year index, if missing."""
    if not qdrant.collection_exists(COLLECTION):
        qdrant.create_collection(
            COLLECTION,
            vectors_config=models.VectorParams(size=DIM, distance=models.Distance.COSINE),
        )
        print(f"created collection '{COLLECTION}' ({DIM}-d, cosine)")
    # Payload index so the year filter in semantic search does not scan every point.
    qdrant.create_payload_index(COLLECTION, "year", models.PayloadSchemaType.INTEGER)


def embed_papers(conn: psycopg.Connection, qdrant: QdrantClient, everything: bool) -> int:
    where = "TRUE" if everything else "embedding_status IN ('pending', 'failed')"
    rows = conn.execute(f"SELECT paper_id, title, abstract, year FROM papers WHERE {where} ORDER BY paper_id").fetchall()
    if not rows:
        print("nothing to embed: every paper is 'done'")
        return 0

    print(f"embedding {len(rows)} papers in batches of {BATCH}")
    started = time.time()
    done = failed = 0
    for i in range(0, len(rows), BATCH):
        batch = rows[i : i + BATCH]
        ids = [r[0] for r in batch]
        try:
            vectors = embed([paper_text(r[1], r[2]) for r in batch])
            qdrant.upsert(
                COLLECTION,
                points=[
                    models.PointStruct(id=r[0], vector=v, payload={"paper_id": r[0], "year": r[3]})
                    for r, v in zip(batch, vectors)
                ],
                wait=True,
            )
        except Exception as err:  # noqa: BLE001 - any failure marks the batch failed
            print(f"  batch starting at paper {ids[0]} failed: {err}", file=sys.stderr)
            conn.execute("UPDATE papers SET embedding_status = 'failed' WHERE paper_id = ANY(%s)", [ids])
            conn.commit()
            failed += len(batch)
            continue

        cur = conn.execute(
            f"""UPDATE papers p SET embedding_status = 'done'
                FROM unnest(%s::int[], %s::text[]) AS b(paper_id, text_hash)
                WHERE p.paper_id = b.paper_id AND {text_hash_sql('p')} = b.text_hash""",
            [ids, [text_hash(r[1], r[2]) for r in batch]],
        )
        conn.commit()
        done += cur.rowcount
        print(f"  {min(i + BATCH, len(rows))}/{len(rows)}")

    print(f"done: {done}, failed: {failed}, skipped (edited meanwhile): {len(rows) - done - failed}, "
          f"{time.time() - started:.1f}s")
    return failed


def all_point_ids(qdrant: QdrantClient) -> set[int]:
    ids: set[int] = set()
    offset = None
    while True:
        points, offset = qdrant.scroll(COLLECTION, limit=1000, offset=offset, with_payload=False, with_vectors=False)
        ids.update(int(p.id) for p in points)
        if offset is None:
            return ids


def check(conn: psycopg.Connection, qdrant: QdrantClient, fix: bool) -> bool:
    """Compare the two databases. Returns True when they agree."""
    status = dict(conn.execute("SELECT embedding_status, count(*) FROM papers GROUP BY 1").fetchall())
    done_ids = {r[0] for r in conn.execute("SELECT paper_id FROM papers WHERE embedding_status = 'done'")}
    all_ids = {r[0] for r in conn.execute("SELECT paper_id FROM papers")}
    points = all_point_ids(qdrant)

    missing = done_ids - points    # marked done in PostgreSQL but no vector
    orphans = points - all_ids     # vector for a paper that no longer exists

    print(f"PostgreSQL: {len(all_ids)} papers  {status}")
    print(f"Qdrant:     {len(points)} points")
    print(f"'done' but missing from Qdrant: {len(missing)}")
    print(f"orphan points (paper deleted):  {len(orphans)}")

    if fix and missing:
        conn.execute("UPDATE papers SET embedding_status = 'pending' WHERE paper_id = ANY(%s)", [sorted(missing)])
        conn.commit()
        print(f"fixed: {len(missing)} papers set back to 'pending' (run sync.py to embed them)")
    if fix and orphans:
        qdrant.delete(COLLECTION, points_selector=models.PointIdsList(points=sorted(orphans)), wait=True)
        print(f"fixed: {len(orphans)} orphan points deleted")
    return not missing and not orphans


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--all", action="store_true", help="re-embed every paper, not only pending/failed")
    parser.add_argument("--check", action="store_true", help="only compare PostgreSQL and Qdrant")
    parser.add_argument("--fix", action="store_true", help="with --check: repair what it finds")
    args = parser.parse_args()

    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL is not set. Copy .env.example to .env and fill it in.")
    qdrant = QdrantClient(url=QDRANT_URL)
    with psycopg.connect(DATABASE_URL) as conn:
        ensure_collection(qdrant)
        if args.check:
            return 0 if check(conn, qdrant, args.fix) else 1
        return 1 if embed_papers(conn, qdrant, args.all) else 0


if __name__ == "__main__":
    sys.exit(main())
