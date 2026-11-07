"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { api, errorText, type SearchResult } from "@/lib/client";

const MODES = [
  { id: "keyword", label: "Keyword", hint: "Exact words, ranked by PostgreSQL full-text search" },
  { id: "semantic", label: "Semantic", hint: "Meaning, ranked by vector similarity in Qdrant" },
  { id: "hybrid", label: "Hybrid", hint: "Both rankings fused with Reciprocal Rank Fusion" },
] as const;
type Mode = (typeof MODES)[number]["id"];
const PAGE_SIZE = 10;

export default function SearchPage() {
  return (
    <Suspense>
      <Search />
    </Suspense>
  );
}

function Search() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  // The URL is the source of truth, so a search can be shared or reloaded.
  const q = params.get("q") ?? "";
  const mode = (params.get("mode") as Mode) || "hybrid";
  const page = Number(params.get("page") ?? 1) || 1;
  const year = params.get("year") ?? "";

  const [draft, setDraft] = useState(q);
  const [draftYear, setDraftYear] = useState(year);
  const [data, setData] = useState<{ results: SearchResult[]; total: number } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => setDraft(q), [q]);
  useEffect(() => setDraftYear(year), [year]);

  useEffect(() => {
    if (!q) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    const sp = new URLSearchParams({ q, mode, page: String(page) });
    if (year) sp.set("year", year);
    api<{ results: SearchResult[]; total: number }>(`/api/search?${sp}`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && (setError(errorText(e)), setData(null)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [q, mode, page, year]);

  function go(next: { q?: string; mode?: Mode; page?: number; year?: string }) {
    const sp = new URLSearchParams();
    const nq = next.q ?? q;
    if (nq) sp.set("q", nq);
    sp.set("mode", next.mode ?? mode);
    const ny = next.year ?? year;
    if (ny) sp.set("year", ny);
    const np = next.page ?? 1;
    if (np > 1) sp.set("page", String(np));
    router.push(`${pathname}?${sp}`);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    go({ q: draft.trim(), year: draftYear.trim(), page: 1 });
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="stack">
      <h1>Search papers</h1>

      <form className="search-bar" onSubmit={submit} role="search">
        <input
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder='Try "teaching machines to understand human language"'
          aria-label="Search query"
          maxLength={500}
        />
        <input
          type="number"
          value={draftYear}
          onChange={(e) => setDraftYear(e.target.value)}
          placeholder="Year"
          aria-label="Year"
          min={1900}
          max={2100}
        />
        <button type="submit" disabled={!draft.trim()}>
          Search
        </button>
      </form>

      <div className="row">
        <div className="segmented" role="group" aria-label="Search mode">
          {MODES.map((m) => (
            <button key={m.id} type="button" aria-pressed={mode === m.id} title={m.hint} onClick={() => go({ mode: m.id, page: 1 })}>
              {m.label}
            </button>
          ))}
        </div>
        <span className="muted small">{MODES.find((m) => m.id === mode)?.hint}</span>
      </div>

      {error && <p className="error">{error}</p>}
      {loading && <p className="muted">Searching…</p>}

      {data && !loading && (
        <>
          <p className="muted small">
            {data.total === 0
              ? "No papers found."
              : `${data.total.toLocaleString()} result${data.total === 1 ? "" : "s"}${mode === "keyword" ? "" : " (top candidates)"} · page ${page} of ${pages}`}
          </p>
          <ol className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }} start={(page - 1) * PAGE_SIZE + 1}>
            {data.results.map((r) => (
              <li key={r.paper_id} className="card result">
                <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                  <h3>
                    <Link href={`/papers/${r.paper_id}`}>{r.title}</Link>
                  </h3>
                  <span className="score" title={scoreTitle(mode)}>
                    {mode === "hybrid" ? r.score.toFixed(4) : r.score.toFixed(3)}
                  </span>
                </div>
                <div className="meta">
                  {[r.authors.slice(0, 4).join(", ") + (r.authors.length > 4 ? " et al." : ""), r.conference, r.year]
                    .filter(Boolean)
                    .join(" · ")}{" "}
                  · {r.citation_count} citation{r.citation_count === 1 ? "" : "s"} in dataset
                </div>
                {r.abstract_snippet && <p className="snippet">{r.abstract_snippet}…</p>}
              </li>
            ))}
          </ol>
          {pages > 1 && (
            <div className="pager">
              <button className="secondary" disabled={page <= 1} onClick={() => go({ page: page - 1 })}>
                Previous
              </button>
              <span className="muted small">
                Page {page} of {pages}
              </span>
              <button className="secondary" disabled={page >= pages} onClick={() => go({ page: page + 1 })}>
                Next
              </button>
            </div>
          )}
        </>
      )}

      {!q && (
        <p className="muted">
          Enter a query. <b>Semantic</b> search finds papers by meaning, so &ldquo;teaching machines to understand human
          language&rdquo; finds natural language processing papers even without those exact words.
        </p>
      )}
    </div>
  );
}

function scoreTitle(mode: Mode) {
  if (mode === "keyword") return "ts_rank_cd relevance (relative within this query)";
  if (mode === "semantic") return "cosine similarity";
  return "Reciprocal Rank Fusion score: sum of 1/(60 + rank)";
}
