"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useSession } from "@/components/Session";
import { api, errorText } from "@/lib/client";

const TABS = ["Add paper", "Edit paper", "Authors", "Conferences", "Audit log"] as const;
type Tab = (typeof TABS)[number];

export default function AdminPage() {
  const { user, loading } = useSession();
  const [tab, setTab] = useState<Tab>("Add paper");

  if (loading) return null;
  if (!user)
    return (
      <p>
        <Link href="/login">Log in</Link> as an admin to manage the repository.
      </p>
    );
  if (user.role !== "admin") return <p className="error">This page is for admins only.</p>;

  return (
    <div>
      <h1>Admin</h1>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === "Add paper" && <AddPaper />}
      {tab === "Edit paper" && <EditPaper />}
      {tab === "Authors" && <EntityAdmin kind="authors" />}
      {tab === "Conferences" && <EntityAdmin kind="conferences" />}
      {tab === "Audit log" && <AuditLog />}
    </div>
  );
}

// ---------------------------------------------------------------- shared

function Status({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p className={msg.ok ? "success" : "error"} style={{ margin: 0 }}>{msg.text}</p>;
}

const intOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

// ------------------------------------------------------------- add paper

function AddPaper() {
  const [f, setF] = useState({ title: "", abstract: "", year: "", doi: "", conference_id: "", authors: "", cited: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [created, setCreated] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    setCreated(null);
    try {
      // One author per line: "Name" or "Name | Affiliation".
      const authors = f.authors
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [name, affiliation] = l.split("|").map((s) => s.trim());
          return affiliation ? { name, affiliation } : { name };
        });
      const cited = f.cited
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number);
      const body: Record<string, unknown> = { title: f.title, authors, cited_paper_ids: cited };
      if (f.abstract.trim()) body.abstract = f.abstract;
      if (f.year.trim()) body.year = Number(f.year);
      if (f.doi.trim()) body.doi = f.doi.trim();
      if (f.conference_id.trim()) body.conference_id = Number(f.conference_id);

      const res = await api<{ paper_id: number; embedding_status: string }>("/api/papers", { method: "POST", body });
      setCreated(res.paper_id);
      setMsg({
        ok: true,
        text: `Saved as paper ${res.paper_id} in one transaction (embedding_status: ${res.embedding_status}; the vector is added right after).`,
      });
      setF({ title: "", abstract: "", year: "", doi: "", conference_id: "", authors: "", cited: "" });
    } catch (err) {
      setMsg({ ok: false, text: `Nothing was saved: ${errorText(err)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <p className="muted small" style={{ margin: 0 }}>
        The paper, its authors and its citations are inserted by <code>add_paper()</code> in one transaction: if any part
        fails (for example a cited paper id that does not exist), nothing is saved.
      </p>
      <label>
        Title *
        <input value={f.title} onChange={set("title")} required maxLength={1000} />
      </label>
      <label>
        Abstract
        <textarea value={f.abstract} onChange={set("abstract")} />
      </label>
      <div className="row">
        <label style={{ flex: 1 }}>
          Year
          <input type="number" min={1900} max={2100} value={f.year} onChange={set("year")} />
        </label>
        <label style={{ flex: 2 }}>
          DOI
          <input value={f.doi} onChange={set("doi")} placeholder="10.1234/abcd" />
        </label>
        <label style={{ flex: 1 }}>
          Conference id
          <input type="number" min={1} value={f.conference_id} onChange={set("conference_id")} />
        </label>
      </div>
      <label>
        Authors * (one per line: <code>Name | Affiliation</code>)
        <textarea value={f.authors} onChange={set("authors")} required placeholder={"Ada Lovelace | PES University\nAlan Turing"} />
      </label>
      <label>
        Cited paper ids (comma separated)
        <input value={f.cited} onChange={set("cited")} placeholder="3, 10, 42" />
      </label>
      <Status msg={msg} />
      {created && <Link href={`/papers/${created}`}>Open paper {created}</Link>}
      <div>
        <button type="submit" disabled={busy}>
          Add paper
        </button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------ edit paper

type PaperDetail = {
  paper_id: number;
  title: string;
  abstract: string | null;
  year: number | null;
  doi: string | null;
  embedding_status: string;
  conference: { conference_id: number; name: string } | null;
};

function EditPaper() {
  const [id, setId] = useState("");
  const [paper, setPaper] = useState<PaperDetail | null>(null);
  const [f, setF] = useState({ title: "", abstract: "", year: "", doi: "", conference_id: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function fill(p: PaperDetail) {
    setPaper(p);
    setF({
      title: p.title,
      abstract: p.abstract ?? "",
      year: p.year?.toString() ?? "",
      doi: p.doi ?? "",
      conference_id: p.conference?.conference_id.toString() ?? "",
    });
  }

  async function load(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setPaper(null);
    try {
      fill(await api<PaperDetail>(`/api/papers/${id}`));
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!paper) return;
    try {
      const updated = await api<PaperDetail>(`/api/papers/${paper.paper_id}`, {
        method: "PATCH",
        body: {
          title: f.title,
          abstract: f.abstract.trim() ? f.abstract : null,
          year: intOrNull(f.year),
          doi: f.doi.trim() || null,
          conference_id: intOrNull(f.conference_id),
        },
      });
      fill(updated);
      setMsg({ ok: true, text: `Saved. embedding_status is now "${updated.embedding_status}".` });
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    }
  }

  async function remove() {
    if (!paper || !confirm(`Delete paper ${paper.paper_id} "${paper.title}"? This cannot be undone.`)) return;
    try {
      await api(`/api/papers/${paper.paper_id}`, { method: "DELETE" });
      setMsg({ ok: true, text: `Deleted paper ${paper.paper_id}. The audit log has a new row, and its vector is removed from Qdrant.` });
      setPaper(null);
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    }
  }

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="stack">
      <form className="row" onSubmit={load}>
        <input type="number" min={1} value={id} onChange={(e) => setId(e.target.value)} placeholder="Paper id" required />
        <button type="submit">Load</button>
      </form>
      <Status msg={msg} />
      {paper && (
        <form className="form" onSubmit={save}>
          <p className="muted small" style={{ margin: 0 }}>
            Changing the title or abstract sets <code>embedding_status</code> back to pending; the paper is then re-embedded.
          </p>
          <label>
            Title
            <input value={f.title} onChange={set("title")} required />
          </label>
          <label>
            Abstract
            <textarea value={f.abstract} onChange={set("abstract")} />
          </label>
          <div className="row">
            <label style={{ flex: 1 }}>
              Year
              <input type="number" value={f.year} onChange={set("year")} />
            </label>
            <label style={{ flex: 2 }}>
              DOI
              <input value={f.doi} onChange={set("doi")} />
            </label>
            <label style={{ flex: 1 }}>
              Conference id
              <input type="number" value={f.conference_id} onChange={set("conference_id")} />
            </label>
          </div>
          <div className="row">
            <button type="submit">Save changes</button>
            <button type="button" className="danger" onClick={remove}>
              Delete paper
            </button>
            <Link href={`/papers/${paper.paper_id}`}>View</Link>
          </div>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------- authors & conferences

type Row = Record<string, string | number | null> & { paper_count: number; total_citations: number };

const ENTITY = {
  authors: {
    idKey: "author_id",
    fields: [
      { key: "name", label: "Name", required: true },
      { key: "affiliation", label: "Affiliation" },
    ],
  },
  conferences: {
    idKey: "conference_id",
    fields: [
      { key: "name", label: "Name", required: true },
      { key: "acronym", label: "Acronym" },
      { key: "year", label: "Year", numeric: true },
      { key: "location", label: "Location" },
    ],
  },
} as const;

type Field = { key: string; label: string; required?: boolean; numeric?: boolean };

function EntityAdmin({ kind }: { kind: "authors" | "conferences" }) {
  const cfg = ENTITY[kind];
  const fields = cfg.fields as readonly Field[];
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ results: Row[]; total: number } | null>(null);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    const sp = new URLSearchParams({ page: String(page) });
    if (q.trim()) sp.set("q", q.trim());
    api<{ results: Row[]; total: number }>(`/api/${kind}?${sp}`)
      .then(setData)
      .catch((e) => setMsg({ ok: false, text: errorText(e) }));
  }, [kind, q, page]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce typing in the search box
    return () => clearTimeout(t);
  }, [load]);

  function startEdit(row: Row | null) {
    setMsg(null);
    setEditing(row ? (row[cfg.idKey] as number) : "new");
    setForm(Object.fromEntries(fields.map((fl) => [fl.key, row?.[fl.key]?.toString() ?? ""])));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const body = Object.fromEntries(
      fields.map((fl) => {
        const v = form[fl.key]?.trim() ?? "";
        return [fl.key, v === "" ? null : fl.numeric ? Number(v) : v];
      }),
    );
    try {
      if (editing === "new") await api(`/api/${kind}`, { method: "POST", body });
      else await api(`/api/${kind}/${editing}`, { method: "PATCH", body });
      setMsg({ ok: true, text: "Saved." });
      setEditing(null);
      load();
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    }
  }

  async function remove(row: Row) {
    const what = kind === "authors" ? "Their paper links are removed; the papers stay." : "Its papers stay, with no conference.";
    if (!confirm(`Delete "${row.name}"? ${what}`)) return;
    try {
      await api(`/api/${kind}/${row[cfg.idKey]}`, { method: "DELETE" });
      setMsg({ ok: true, text: "Deleted." });
      load();
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / 20)) : 1;

  return (
    <div className="stack">
      <div className="row">
        <input
          type="search"
          placeholder={`Search ${kind}`}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <button onClick={() => startEdit(null)}>New {kind === "authors" ? "author" : "conference"}</button>
      </div>
      <Status msg={msg} />

      {editing !== null && (
        <form className="form card" onSubmit={save}>
          <h3>{editing === "new" ? "New" : `Edit #${editing}`}</h3>
          {fields.map((fl) => (
            <label key={fl.key}>
              {fl.label}
              {fl.required ? " *" : ""}
              <input
                type={fl.numeric ? "number" : "text"}
                value={form[fl.key] ?? ""}
                required={fl.required}
                onChange={(e) => setForm({ ...form, [fl.key]: e.target.value })}
              />
            </label>
          ))}
          <div className="row">
            <button type="submit">Save</button>
            <button type="button" className="secondary" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="num">Id</th>
                {fields.map((fl) => (
                  <th key={fl.key}>{fl.label}</th>
                ))}
                <th className="num">Papers</th>
                <th className="num">Citations</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.results.map((r) => (
                <tr key={r[cfg.idKey] as number}>
                  <td className="num">{r[cfg.idKey]}</td>
                  {fields.map((fl) => (
                    <td key={fl.key}>{r[fl.key] ?? <span className="muted">–</span>}</td>
                  ))}
                  <td className="num">{r.paper_count}</td>
                  <td className="num">{r.total_citations}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="link" onClick={() => startEdit(r)}>
                      Edit
                    </button>{" "}
                    ·{" "}
                    <button className="link" style={{ color: "var(--danger)" }} onClick={() => remove(r)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="pager">
          <button className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="muted small">
            Page {page} of {pages} · {data?.total.toLocaleString()} total
          </span>
          <button className="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- audit log

type AuditRow = { log_id: number; action: string; paper_id: number; admin_id: number | null; admin_email: string | null; logged_at: string };

function AuditLog() {
  const [data, setData] = useState<{ results: AuditRow[]; total: number } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ results: AuditRow[]; total: number }>("/api/admin/audit-log").then(setData).catch((e) => setError(errorText(e)));
  }, []);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        Rows written by the <code>AFTER DELETE</code> trigger on papers. Newest first, {data.total} in total.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="num">Log id</th>
              <th>Action</th>
              <th className="num">Paper id</th>
              <th>Admin</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {data.results.map((r) => (
              <tr key={r.log_id}>
                <td className="num">{r.log_id}</td>
                <td>{r.action}</td>
                <td className="num">{r.paper_id}</td>
                <td>{r.admin_email ?? <span className="muted">outside the API</span>}</td>
                <td>{new Date(r.logged_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
