"""Shared helpers for the OpenAlex ingestion scripts."""

import html
import os
import re
from pathlib import Path

import psycopg
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = Path(__file__).resolve().parent / "cache"
WORKS_FILE = CACHE_DIR / "works.jsonl"     # one OpenAlex work (JSON) per line

load_dotenv(ROOT / ".env")


def connect() -> psycopg.Connection:
    """Open a connection using DATABASE_URL from .env."""
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is not set. Copy .env.example to .env and fill it in.")
    return psycopg.connect(url)


def rebuild_abstract(inverted_index: dict | None) -> str | None:
    """Turn OpenAlex's abstract_inverted_index back into plain text.

    OpenAlex stores abstracts as {word: [positions]}, for example
        {"Deep": [0], "learning": [1, 4], "is": [2], "great": [3]}
    which is "Deep learning is great learning". We place every word at each
    of its positions and join them in position order.
    """
    if not inverted_index:
        return None
    positions: dict[int, str] = {}
    for word, places in inverted_index.items():
        for p in places:
            positions[p] = word
    text = " ".join(positions[p] for p in sorted(positions))
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def clean_text(value: str | None) -> str | None:
    """Strip HTML tags/entities (titles sometimes contain <i>...</i>) and extra spaces."""
    if not value:
        return None
    value = html.unescape(re.sub(r"<[^>]+>", "", value))
    value = re.sub(r"\s+", " ", value).strip()
    return value or None


def normalise_doi(doi: str | None) -> str | None:
    """'https://doi.org/10.18653/V1/N19-1423' -> '10.18653/v1/n19-1423' (the stored form)."""
    if not doi:
        return None
    doi = re.sub(r"^https?://(dx\.)?doi\.org/", "", doi.strip().lower())
    return doi if doi.startswith("10.") else None


def short_id(openalex_url: str | None) -> str | None:
    """'https://openalex.org/W2741809807' -> 'W2741809807'."""
    if not openalex_url:
        return None
    return openalex_url.rstrip("/").rsplit("/", 1)[-1]


def guess_acronym(venue_name: str) -> str | None:
    """Take an acronym from a trailing '(EMNLP)' in the venue name, if present."""
    m = re.search(r"\(([A-Z][A-Za-z0-9&\-]{1,15})\)\s*$", venue_name)
    return m.group(1) if m else None
