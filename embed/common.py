"""Shared settings and helpers for the embedding service and the sync script."""

import hashlib
import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
DIM = 384
COLLECTION = "papers"
QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
DATABASE_URL = os.environ.get("DATABASE_URL")


def paper_text(title: str, abstract: str | None) -> str:
    """The text that gets embedded (agreed interface): title + ". " + abstract."""
    return f"{title}. {abstract}" if abstract else title


def text_hash(title: str, abstract: str | None) -> str:
    """md5 of the embedded text. Must match text_hash_sql() below."""
    return hashlib.md5(paper_text(title, abstract).encode("utf-8")).hexdigest()


# The same hash computed inside PostgreSQL. Used to mark a paper 'done' only if
# its text has not changed since it was read (an admin may edit it meanwhile).
def text_hash_sql(alias: str) -> str:
    """SQL for the same md5, on table alias `alias` (e.g. 'p')."""
    t, a = f"{alias}.title", f"{alias}.abstract"
    return f"md5(CASE WHEN {a} IS NULL THEN {t} ELSE {t} || '. ' || {a} END)"


@lru_cache(maxsize=1)
def model():
    """Load the sentence-transformers model once (about 90 MB, cached by Hugging Face)."""
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(MODEL_NAME)


def embed(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts into unit-length 384-d vectors."""
    vectors = model().encode(texts, batch_size=64, normalize_embeddings=True, show_progress_bar=False)
    return [v.tolist() for v in vectors]
