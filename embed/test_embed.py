"""Checks for the embedding helpers. Run from the repository root:
    embed/.venv/bin/python embed/test_embed.py

The PostgreSQL check is skipped if the database is not reachable.
"""

import math
import sys

from common import DATABASE_URL, DIM, embed, paper_text, text_hash, text_hash_sql

passed = failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  ' + detail if detail else ''}")
    passed += ok
    failed += not ok


def cos(a, b):
    return sum(x * y for x, y in zip(a, b))  # vectors are unit length


# Embedding text follows the agreed interface: title + ". " + abstract.
check("paper_text joins title and abstract", paper_text("BERT", "Deep transformers.") == "BERT. Deep transformers.")
check("paper_text without abstract is the title", paper_text("BERT", None) == "BERT")
check("text_hash changes when text changes", text_hash("A", "b") != text_hash("A", "c"))

v = embed(["natural language processing", "teaching machines to understand human language", "a recipe for chocolate cake"])
check("vectors are 384-d", all(len(x) == DIM for x in v), f"dims={[len(x) for x in v]}")
check("vectors are unit length", all(abs(math.sqrt(sum(c * c for c in x)) - 1) < 1e-4 for x in v))
related, unrelated = cos(v[0], v[1]), cos(v[0], v[2])
check("related phrasing is closer than an unrelated one", related > unrelated, f"{related:.3f} > {unrelated:.3f}")
# Alone vs inside a padded batch differs only by float rounding, so compare with a tolerance.
same = cos(embed(["natural language processing"])[0], v[0])
check("same text gives the same vector (up to rounding)", same > 0.9999, f"cosine={same:.6f}")

# The hash used to mark papers 'done' must be identical in Python and PostgreSQL.
try:
    import psycopg

    with psycopg.connect(DATABASE_URL, connect_timeout=3) as conn:
        for title, abstract in [("Attention Is All You Need", "The dominant models…"), ("Title only", None), ("Ünïcödé", "naïve café")]:
            sql_hash = conn.execute(
                f"SELECT {text_hash_sql('t')} FROM (SELECT %s::text AS title, %s::text AS abstract) t", [title, abstract]
            ).fetchone()[0]
            check(f"Python and SQL hash agree: {title!r}", sql_hash == text_hash(title, abstract))
except Exception as err:  # noqa: BLE001
    print(f"SKIP  PostgreSQL hash check ({type(err).__name__}: database not reachable)")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
