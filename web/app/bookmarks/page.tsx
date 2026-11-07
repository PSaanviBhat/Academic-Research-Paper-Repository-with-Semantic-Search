"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/Session";
import { api, errorText, type PaperSummary } from "@/lib/client";

type Bookmark = PaperSummary & { bookmarked_at: string };
const PAGE_SIZE = 20;

export default function BookmarksPage() {
  const { user, loading } = useSession();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ results: Bookmark[]; total: number } | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<{ results: Bookmark[]; total: number }>(`/api/bookmarks?page=${page}`)
      .then(setData)
      .catch((e) => setError(errorText(e)));
  }, [page]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  async function remove(paperId: number) {
    try {
      await api(`/api/bookmarks/${paperId}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (loading) return null;
  if (!user)
    return (
      <p>
        <Link href="/login">Log in</Link> to see your bookmarks.
      </p>
    );

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="stack">
      <h1>Bookmarks</h1>
      {error && <p className="error">{error}</p>}
      {data && data.total === 0 && (
        <p className="muted">
          No bookmarks yet. Open a paper from <Link href="/">search</Link> and press Bookmark.
        </p>
      )}
      {data?.results.map((b) => (
        <div key={b.paper_id} className="card row" style={{ justifyContent: "space-between" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3>
              <Link href={`/papers/${b.paper_id}`}>{b.title}</Link>
            </h3>
            <div className="meta">
              {[b.authors.slice(0, 3).join(", "), b.conference, b.year].filter(Boolean).join(" · ")} · saved{" "}
              {new Date(b.bookmarked_at).toLocaleDateString()}
            </div>
          </div>
          <button className="secondary" onClick={() => remove(b.paper_id)}>
            Remove
          </button>
        </div>
      ))}
      {pages > 1 && (
        <div className="pager">
          <button className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="muted small">
            Page {page} of {pages}
          </span>
          <button className="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}
