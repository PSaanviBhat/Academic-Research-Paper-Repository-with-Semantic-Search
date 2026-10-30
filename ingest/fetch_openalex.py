"""Download NLP papers from the OpenAlex API into a local cache file.

    py -3.11 ingest/fetch_openalex.py            # download (skipped if the cache already exists)
    py -3.11 ingest/fetch_openalex.py --refresh  # download again

What is fetched:
  * Topic "Natural Language Processing Techniques" (OpenAlex topic T10181),
    as each paper's PRIMARY topic, so the dataset stays focused on NLP.
  * Only works that have an abstract (has_abstract:true).
  * The most-cited works first (sort=cited_by_count:desc). Well-known papers
    cite each other a lot, so many citation edges stay inside the dataset.

Paging uses OpenAlex's cursor paging (cursor=* then next_cursor), which
needs the free API key from .env. Requests are spaced out and retried with
exponential backoff on rate limits (HTTP 429) and server errors.
The result is ingest/cache/works.jsonl: one work per line, written to a
temporary file and renamed at the end, so a crash never leaves half a cache.
"""

import argparse
import json
import os
import time

import requests

from common import CACHE_DIR, WORKS_FILE

API = "https://api.openalex.org/works"
FILTER = "primary_topic.id:T10181,has_abstract:true"
# Fetch a little more than we keep: some works are duplicates (a preprint and
# its published version) and some have unusable abstracts.
DEFAULT_LIMIT = 4500
PER_PAGE = 100             # OpenAlex maximum
PAUSE_SECONDS = 0.2        # ~5 requests/second, far below the 30/s limit for keyed users
MAX_ATTEMPTS = 6

# Only the fields the loader uses: smaller, faster responses.
FIELDS = ",".join([
    "id", "doi", "title", "publication_year", "type", "abstract_inverted_index",
    "authorships", "primary_location", "referenced_works", "cited_by_count",
])


def get_page(session: requests.Session, params: dict) -> dict:
    """GET one page, retrying on 429/5xx/network errors with exponential backoff."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            r = session.get(API, params=params, timeout=60)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 429 or r.status_code >= 500:
                wait = float(r.headers.get("Retry-After", 2 ** attempt))
                print(f"  HTTP {r.status_code}, retry {attempt}/{MAX_ATTEMPTS} in {wait:.0f}s")
                time.sleep(wait)
                continue
            # 4xx other than 429 is a bug in our request: retrying will not help.
            raise SystemExit(f"OpenAlex returned HTTP {r.status_code}: {r.text[:300]}")
        except (requests.ConnectionError, requests.Timeout) as e:
            wait = 2 ** attempt
            print(f"  network error ({e.__class__.__name__}), retry {attempt}/{MAX_ATTEMPTS} in {wait}s")
            time.sleep(wait)
    raise SystemExit("OpenAlex is not responding; try again later (already-downloaded pages are not kept).")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="how many works to download")
    parser.add_argument("--refresh", action="store_true", help="download again even if the cache exists")
    args = parser.parse_args()

    if WORKS_FILE.exists() and not args.refresh:
        n = sum(1 for _ in WORKS_FILE.open(encoding="utf-8"))
        print(f"Cache already has {n} works ({WORKS_FILE}). Use --refresh to download again.")
        return

    key = os.environ.get("OPENALEX_API_KEY", "").strip()
    if not key:
        raise SystemExit("OPENALEX_API_KEY is empty in .env. Get a free key at https://openalex.org/settings/api-key")

    session = requests.Session()
    session.headers["Authorization"] = f"Bearer {key}"   # key in a header, so it never appears in logged URLs
    session.headers["User-Agent"] = "dbms-paper-repository/1.0 (student project)"

    params = {"filter": FILTER, "sort": "cited_by_count:desc", "per_page": PER_PAGE,
              "select": FIELDS, "cursor": "*"}
    email = os.environ.get("OPENALEX_EMAIL", "").strip()
    if email:
        params["mailto"] = email

    CACHE_DIR.mkdir(exist_ok=True)
    tmp = WORKS_FILE.with_suffix(".jsonl.part")
    fetched, page = 0, 0
    started = time.time()
    with tmp.open("w", encoding="utf-8") as out:
        while fetched < args.limit and params["cursor"]:
            page += 1
            data = get_page(session, params)
            results = data.get("results", [])
            if not results:
                break
            for work in results[: args.limit - fetched]:
                out.write(json.dumps(work, ensure_ascii=False) + "\n")
            fetched += min(len(results), args.limit - fetched)
            total = data["meta"]["count"]
            print(f"page {page:3d}: {fetched:5d} / {args.limit} works  (topic has {total} in total)")
            params["cursor"] = data["meta"].get("next_cursor")
            time.sleep(PAUSE_SECONDS)

    tmp.replace(WORKS_FILE)
    print(f"Saved {fetched} works to {WORKS_FILE} in {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
