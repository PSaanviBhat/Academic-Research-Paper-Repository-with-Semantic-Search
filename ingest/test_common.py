"""Unit tests for the ingestion helpers. Run:  py -3.11 ingest/test_common.py"""

from common import clean_text, guess_acronym, normalise_doi, rebuild_abstract, short_id

CASES = [
    ("abstract: words placed by position, repeats kept",
     rebuild_abstract({"Deep": [0], "learning": [1, 4], "is": [2], "great": [3]}),
     "Deep learning is great learning"),
    ("abstract: unordered dict still gives the right order",
     rebuild_abstract({"world": [1], "hello": [0]}), "hello world"),
    ("abstract: missing index gives None", rebuild_abstract(None), None),
    ("abstract: empty index gives None", rebuild_abstract({}), None),
    ("title: HTML tags and entities removed",
     clean_text("Learning <i>Phrase</i> Representations &amp; more  "), "Learning Phrase Representations & more"),
    ("doi: URL prefix removed, lowercased",
     normalise_doi("https://doi.org/10.1162/NECO.1997.9.8.1735"), "10.1162/neco.1997.9.8.1735"),
    ("doi: not a DOI gives None", normalise_doi("https://example.com/x"), None),
    ("id: OpenAlex URL to short id", short_id("https://openalex.org/W2741809807"), "W2741809807"),
    ("acronym: taken from trailing parentheses",
     guess_acronym("Conference on Empirical Methods in Natural Language Processing (EMNLP)"), "EMNLP"),
    ("acronym: none when absent", guess_acronym("Neural Computation"), None),
]

failed = 0
for name, got, expected in CASES:
    ok = got == expected
    failed += not ok
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"\n      expected {expected!r}, got {got!r}"))
print(f"\n{len(CASES) - failed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
