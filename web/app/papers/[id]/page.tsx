"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useSession } from "@/components/Session";
import { ApiError, api, errorText, type PaperSummary } from "@/lib/client";

type Ref = { paper_id: number; title: string; year: number | null; citation_count: number };
type Paper = {
  paper_id: number;
  title: string;
  abstract: string | null;
  year: number | null;
  doi: string | null;
  citation_count: number;
  embedding_status: "pending" | "done" | "failed";
  conference: { conference_id: number; name: string; acronym: string | null; year: number | null; location: string | null } | null;
  authors: { author_id: number; name: string; affiliation: string | null; author_order: number }[];
  references: Ref[];
  cited_by: Ref[];
};

export default function PaperPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useSession();
  const [paper, setPaper] = useState<Paper | null>(null);
  const [error, setError] = useState("");
  const [bookmarked, setBookmarked] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPaper(null);
    setError("");
    api<Paper>(`/api/papers/${id}`)
      .then(setPaper)
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? "This paper does not exist." : errorText(e)));
  }, [id]);

  // Is this paper in the user's bookmarks? (Bookmark lists are short, so read them all.)
  useEffect(() => {
    if (!user) {
      setBookmarked(null);
      return;
    }
    let cancelled = false;
    (async () => {
      for (let page = 1; ; page++) {
        const d = await api<{ results: PaperSummary[]; total: number }>(`/api/bookmarks?page=${page}`);
        if (d.results.some((b) => String(b.paper_id) === id)) return !cancelled && setBookmarked(true);
        if (page * 20 >= d.total || d.results.length === 0) return !cancelled && setBookmarked(false);
      }
    })().catch(() => !cancelled && setBookmarked(false));
    return () => {
      cancelled = true;
    };
  }, [user, id]);

  async function toggleBookmark() {
    setBusy(true);
    try {
      if (bookmarked) await api(`/api/bookmarks/${id}`, { method: "DELETE" });
      else await api("/api/bookmarks", { method: "POST", body: { paper_id: Number(id) } });
      setBookmarked(!bookmarked);
    } catch (e) {
      alert(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!paper) return <p className="muted">Loading…</p>;

  return (
    <article className="stack">
      <div>
        <h1 style={{ marginBottom: "0.4rem" }}>{paper.title}</h1>
        <div className="meta">
          {[paper.conference?.name, paper.year].filter(Boolean).join(" · ")}
          {paper.doi && (
            <>
              {" · "}
              <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer">
                doi:{paper.doi}
              </a>
            </>
          )}
        </div>
      </div>

      <div className="row">
        <span className="badge">{paper.citation_count} citations in dataset</span>
        <span className="badge" title="Whether this paper's vector is in Qdrant">
          embedding: {paper.embedding_status}
        </span>
        {user && bookmarked !== null && (
          <button className={bookmarked ? "secondary" : ""} onClick={toggleBookmark} disabled={busy}>
            {bookmarked ? "Remove bookmark" : "Bookmark"}
          </button>
        )}
        {!user && (
          <span className="muted small">
            <Link href="/login">Log in</Link> to bookmark
          </span>
        )}
      </div>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Authors</h2>
        {paper.authors.length === 0 ? (
          <p className="muted">No authors recorded.</p>
        ) : (
          <ol style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {paper.authors.map((a) => (
              <li key={a.author_id}>
                {a.name}
                {a.affiliation && <span className="muted"> · {a.affiliation}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>

      {paper.abstract && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Abstract</h2>
          <p style={{ margin: 0 }}>{paper.abstract}</p>
        </section>
      )}

      <div className="grid-2">
        <RefList title="References" empty="Cites no papers in this dataset." items={paper.references} />
        <RefList title="Cited by" empty="Not cited by any paper in this dataset." items={paper.cited_by} />
      </div>
    </article>
  );
}

function RefList({ title, empty, items }: { title: string; empty: string; items: Ref[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 15);
  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>
        {title} <span className="muted small">({items.length})</span>
      </h2>
      {items.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: "1.1rem" }} className="stack">
          {shown.map((r) => (
            <li key={r.paper_id}>
              <Link href={`/papers/${r.paper_id}`}>{r.title}</Link>
              <span className="muted small">
                {" "}
                · {r.year ?? "n.d."} · {r.citation_count} cit.
              </span>
            </li>
          ))}
        </ul>
      )}
      {items.length > 15 && (
        <button className="link" onClick={() => setAll(!all)} style={{ marginTop: "0.5rem" }}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </section>
  );
}
