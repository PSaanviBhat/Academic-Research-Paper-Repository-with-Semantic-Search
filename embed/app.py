"""Embedding service: turns text into a 384-d vector (all-MiniLM-L6-v2).

Run from the repository root:
    embed/.venv/bin/uvicorn --app-dir embed app:app --port 8001

POST /embed  {"text": "..."}          -> {"vector": [384 floats], "dim": 384}
POST /embed  {"texts": ["...", ...]}  -> {"vectors": [[...], ...], "dim": 384}
GET  /health                          -> {"status": "ok", "model": ..., "dim": 384}
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from common import DIM, MODEL_NAME, embed, model

MAX_TEXTS = 256
MAX_CHARS = 20_000


@asynccontextmanager
async def lifespan(_app: FastAPI):
    model()  # load the model at startup, not on the first request
    yield


app = FastAPI(title="Paper embedding service", lifespan=lifespan)


class EmbedRequest(BaseModel):
    text: str | None = Field(default=None, max_length=MAX_CHARS)
    texts: list[str] | None = None


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "dim": DIM}


@app.post("/embed")
def embed_route(req: EmbedRequest):
    if (req.text is None) == (req.texts is None):
        raise HTTPException(400, "send exactly one of 'text' or 'texts'")

    if req.text is not None:
        if not req.text.strip():
            raise HTTPException(400, "text must not be empty")
        return {"vector": embed([req.text])[0], "dim": DIM}

    if not req.texts or len(req.texts) > MAX_TEXTS:
        raise HTTPException(400, f"texts must hold 1 to {MAX_TEXTS} strings")
    if any(not t.strip() or len(t) > MAX_CHARS for t in req.texts):
        raise HTTPException(400, f"each text must be non-empty and at most {MAX_CHARS} characters")
    return {"vectors": embed(req.texts), "dim": DIM}
