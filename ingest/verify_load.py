"""Check what the loader put in the database.

    py -3.11 ingest/verify_load.py

Prints row counts, the embedding_status breakdown, and the most important
check: every paper's citation_count must equal COUNT(*) of the citation
rows pointing at it (this proves the triggers kept the counter right
during the bulk load). Exits with code 1 if a check fails.
"""

from common import connect

CHECKS = {
    "papers": "SELECT count(*) FROM papers",
    "authors": "SELECT count(*) FROM authors",
    "paper_authors (links)": "SELECT count(*) FROM paper_authors",
    "conferences (venue editions)": "SELECT count(*) FROM conferences",
    "citations (edges)": "SELECT count(*) FROM citations",
    "papers with a conference": "SELECT count(*) FROM papers WHERE conference_id IS NOT NULL",
    "papers with no authors": """SELECT count(*) FROM papers p
                                 WHERE NOT EXISTS (SELECT 1 FROM paper_authors pa WHERE pa.paper_id = p.paper_id)""",
    "papers with no abstract": "SELECT count(*) FROM papers WHERE abstract IS NULL",
}

MISMATCH_SQL = """
    SELECT count(*) FROM papers p
    WHERE p.citation_count <> (SELECT count(*) FROM citations c WHERE c.cited_paper_id = p.paper_id)
"""


def main() -> None:
    ok = True
    with connect() as conn, conn.cursor() as cur:
        print("Row counts")
        values = {}
        for label, sql in CHECKS.items():
            cur.execute(sql)
            values[label] = cur.fetchone()[0]
            print(f"  {label:<30} {values[label]:>8}")

        print("\nembedding_status")
        cur.execute("SELECT embedding_status, count(*) FROM papers GROUP BY 1 ORDER BY 1")
        for status, n in cur.fetchall():
            print(f"  {status:<30} {n:>8}")

        cur.execute(MISMATCH_SQL)
        mismatches = cur.fetchone()[0]
        print(f"\nPapers whose citation_count differs from COUNT(*) of citations: {mismatches}")

        print("\nMost cited inside the dataset")
        cur.execute("SELECT rank, citation_count, left(title, 70) FROM v_top_cited_papers LIMIT 5")
        for rank, cites, title in cur.fetchall():
            print(f"  {rank:>2}. [{cites:>4}] {title}")

    print("\nResult")
    if values["papers"] < 2000:
        print(f"  FAIL: only {values['papers']} papers loaded (need at least 2000)")
        ok = False
    else:
        print(f"  PASS: {values['papers']} papers loaded (need at least 2000)")
    if mismatches:
        print("  FAIL: citation_count is out of sync with the citations table")
        ok = False
    else:
        print("  PASS: every citation_count matches COUNT(*) of citations")
    if values["papers with no abstract"]:
        print("  FAIL: some papers have no abstract")
        ok = False
    else:
        print("  PASS: every paper has an abstract")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
