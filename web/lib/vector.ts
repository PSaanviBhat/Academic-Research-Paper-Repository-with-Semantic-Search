import { createHash } from "node:crypto";
import { query } from "./db";
import { HttpError } from "./http";

// The vector side: the embedding service (embed/app.py) and Qdrant.
// PostgreSQL stays the source of truth: Qdrant is only written after a SQL
// transaction has committed, and search results are always re-read from SQL.

const EMBED_URL = process.env.EMBED_URL ?? "http://localhost:8001";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const COLLECTION = "papers";
const TIMEOUT_MS = 10_000;

export type VectorHit = { paper_id: number; score: number };

/** Thrown when the embedding service or Qdrant cannot be reached; becomes a 503. */
const unavailable = (what: string) =>
  new HttpError(503, "SERVICE_UNAVAILABLE", `${what} is not reachable; semantic search is unavailable`);

async function call(url: string, init: RequestInit, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw unavailable(what);
  }
  if (!res.ok) throw unavailable(`${what} (HTTP ${res.status})`);
  return res.json();
}

/** The agreed embedding input: title + ". " + abstract. Same as embed/common.py. */
export function paperText(title: string, abstract: string | null): string {
  return abstract ? `${title}. ${abstract}` : title;
}

/** 384-d vector for one text, from POST /embed. */
export async function embed(text: string): Promise<number[]> {
  const body = (await call(`${EMBED_URL}/embed`, { method: "POST", body: JSON.stringify({ text }) }, "the embedding service")) as {
    vector: number[];
  };
  return body.vector;
}

/** Nearest papers by cosine similarity, best first. Optional exact-year filter (payload index). */
export async function searchVectors(vector: number[], limit: number, year: number | null): Promise<VectorHit[]> {
  const body = (await call(
    `${QDRANT_URL}/collections/${COLLECTION}/points/query`,
    {
      method: "POST",
      body: JSON.stringify({
        query: vector,
        limit,
        with_payload: false,
        ...(year === null ? {} : { filter: { must: [{ key: "year", match: { value: year } }] } }),
      }),
    },
    "Qdrant",
  )) as { result: { points: { id: number; score: number }[] } };
  return body.result.points.map((p) => ({ paper_id: Number(p.id), score: p.score }));
}

/**
 * Embed one paper and upsert it to Qdrant, then record the outcome in
 * papers.embedding_status. Called after the SQL transaction has committed
 * (POST and PATCH /api/papers). Never throws: on failure the paper is marked
 * 'failed' and `embed/sync.py` retries it later.
 */
export async function syncPaperVector(paperId: number): Promise<"done" | "failed" | "missing"> {
  const [paper] = await query<{ title: string; abstract: string | null; year: number | null }>(
    "SELECT title, abstract, year FROM papers WHERE paper_id = $1",
    [paperId],
  );
  if (!paper) return "missing";

  const text = paperText(paper.title, paper.abstract);
  try {
    const vector = await embed(text);
    await call(
      `${QDRANT_URL}/collections/${COLLECTION}/points?wait=true`,
      {
        method: "PUT",
        body: JSON.stringify({ points: [{ id: paperId, vector, payload: { paper_id: paperId, year: paper.year } }] }),
      },
      "Qdrant",
    );
  } catch (err) {
    console.error(`embedding paper ${paperId} failed:`, (err as Error).message);
    await query("UPDATE papers SET embedding_status = 'failed' WHERE paper_id = $1", [paperId]);
    return "failed";
  }

  // Only mark 'done' if the text is still the one we embedded: if an admin
  // edited it in the meantime, it stays 'pending' for the next sync.
  const hash = createHash("md5").update(text, "utf8").digest("hex");
  await query(
    `UPDATE papers SET embedding_status = 'done'
     WHERE paper_id = $1
       AND md5(CASE WHEN abstract IS NULL THEN title ELSE title || '. ' || abstract END) = $2`,
    [paperId, hash],
  );
  return "done";
}

/**
 * Remove a deleted paper's vector. Called after the SQL delete has committed.
 * Never throws: a leftover (orphan) vector is harmless because search results
 * are re-read from PostgreSQL, and `sync.py --check --fix` removes it.
 */
export async function deletePaperVector(paperId: number): Promise<void> {
  try {
    await call(
      `${QDRANT_URL}/collections/${COLLECTION}/points/delete?wait=true`,
      { method: "POST", body: JSON.stringify({ points: [paperId] }) },
      "Qdrant",
    );
  } catch (err) {
    console.error(`deleting vector ${paperId} failed (orphan left for sync.py --check --fix):`, (err as Error).message);
  }
}
