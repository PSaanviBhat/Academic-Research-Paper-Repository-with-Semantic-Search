// End-to-end tests for every API route, run against the live app.
//   npm --prefix web run dev          (in one terminal)
//   npm --prefix web run test:api     (in another)
// Each check asserts the HTTP status AND that the response has exactly the
// fields listed in docs/API_CONTRACT.md. Test rows are created with names
// starting "API test" and removed again at the end.
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
nextEnv.loadEnvConfig(root);
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

// ---------- contract shapes (field names from docs/API_CONTRACT.md) ----------
const K = {
  user: ["user_id", "name", "email", "role", "created_at"],
  summary: ["paper_id", "title", "year", "conference", "authors", "citation_count"],
  searchResult: ["paper_id", "title", "abstract_snippet", "year", "conference", "authors", "citation_count", "score"],
  detail: ["paper_id", "title", "abstract", "year", "doi", "citation_count", "embedding_status", "created_at",
           "conference", "authors", "references", "cited_by"],
  detailConference: ["conference_id", "name", "acronym", "year", "location"],
  detailAuthor: ["author_id", "name", "affiliation", "author_order"],
  linkedPaper: ["paper_id", "title", "year", "citation_count"],
  authorItem: ["author_id", "name", "affiliation", "paper_count", "total_citations"],
  conference: ["conference_id", "name", "acronym", "year", "location"],
  conferenceItem: ["conference_id", "name", "acronym", "year", "location", "paper_count", "total_citations"],
  bookmarkItem: ["paper_id", "title", "year", "conference", "authors", "citation_count", "bookmarked_at"],
  stats: ["totals", "top_cited", "papers_per_year", "conference_stats", "top_authors"],
  totals: ["papers", "authors", "citations", "conferences"],
  topCited: ["paper_id", "title", "year", "conference", "citation_count"],
  perYear: ["year", "paper_count"],
  confStat: ["conference_id", "name", "acronym", "year", "paper_count", "total_citations"],
  topAuthor: ["author_id", "name", "paper_count", "total_citations"],
  audit: ["log_id", "action", "paper_id", "admin_id", "admin_email", "logged_at"],
};
const hasKeys = (obj, keys, what) =>
  assert.deepEqual(Object.keys(obj).sort(), [...keys].sort(), `${what} fields differ from the contract`);

// ---------- tiny HTTP client with a cookie per "user" ----------
function client() {
  let cookie = "";
  return async function call(method, url, body) {
    const res = await fetch(BASE + url, {
      method,
      headers: { ...(body !== undefined && { "Content-Type": "application/json" }), ...(cookie && { Cookie: cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("session="));
    if (set) cookie = set.split(";")[0] === "session=" ? "" : set.split(";")[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}
const anon = client();
const researcher = client();
const admin = client();

/** Assert status, and for 4xx/5xx that the error has the standard shape and code. */
function expectStatus(res, status, code) {
  assert.equal(res.status, status, `expected HTTP ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  if (status >= 400) {
    hasKeys(res.body, ["error"], "error body");
    hasKeys(res.body.error, ["code", "message"], "error object");
    if (code) assert.equal(res.body.error.code, code);
  }
}

async function cleanup() {
  await db.query("DELETE FROM papers WHERE title LIKE 'API test%'");
  await db.query("DELETE FROM conferences WHERE name LIKE 'API test%'");
  await db.query("DELETE FROM authors WHERE name LIKE 'API test%'");
  await db.query("DELETE FROM users WHERE email = 'apitest@example.com'");
}

// Shared state between the ordered steps below.
const s = {};

describe("API", () => {
  before(async () => {
    await db.connect();
    await cleanup();
    const top = await db.query("SELECT paper_id, citation_count FROM papers ORDER BY citation_count DESC, paper_id LIMIT 1");
    assert.ok(top.rows.length, "no papers loaded: run the ingestion first");
    s.top = top.rows[0];
  });
  after(async () => {
    await cleanup();
    await db.end();
  });

  // ------------------------------------------------------------ auth
  describe("auth", () => {
    it("register researcher -> 201 with User shape, role researcher", async () => {
      const r = await researcher("POST", "/api/auth/register", { name: "API test user", email: "apitest@example.com", password: "api-test-pass-1" });
      expectStatus(r, 201);
      hasKeys(r.body, ["user"], "register body");
      hasKeys(r.body.user, K.user, "User");
      assert.equal(r.body.user.role, "researcher");
    });
    it("login admin -> 200, role admin", async () => {
      const r = await admin("POST", "/api/auth/login", { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
      expectStatus(r, 200);
      hasKeys(r.body.user, K.user, "User");
      assert.equal(r.body.user.role, "admin", "run: npm --prefix web run seed:admin");
    });
    it("me: 401 without session, 200 with", async () => {
      expectStatus(await anon("GET", "/api/auth/me"), 401, "UNAUTHENTICATED");
      const r = await researcher("GET", "/api/auth/me");
      expectStatus(r, 200);
      hasKeys(r.body.user, K.user, "User");
    });
  });

  // ------------------------------------------------------------ search
  describe("search", () => {
    it("keyword search returns the contract shape, best score first", async () => {
      const r = await anon("GET", "/api/search?q=neural%20machine%20translation");
      expectStatus(r, 200);
      hasKeys(r.body, ["results", "total"], "search body");
      assert.ok(r.body.total > 10 && r.body.results.length === 10);
      r.body.results.forEach((x) => hasKeys(x, K.searchResult, "search result"));
      const scores = r.body.results.map((x) => x.score);
      assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
      assert.ok(Array.isArray(r.body.results[0].authors));
    });
    it("page 2 differs from page 1; year filter applies", async () => {
      const p1 = await anon("GET", "/api/search?q=language&page=1");
      const p2 = await anon("GET", "/api/search?q=language&page=2");
      assert.notDeepEqual(p1.body.results.map((x) => x.paper_id), p2.body.results.map((x) => x.paper_id));
      assert.equal(p1.body.total, p2.body.total);
      const y = await anon("GET", "/api/search?q=language&year=2019");
      expectStatus(y, 200);
      assert.ok(y.body.results.length > 0 && y.body.results.every((x) => x.year === 2019));
    });
    it("no match -> 200 with empty results and total 0", async () => {
      const r = await anon("GET", "/api/search?q=zzqqxxnomatch");
      expectStatus(r, 200);
      assert.deepEqual(r.body, { results: [], total: 0 });
    });
    it("semantic and hybrid -> 501 'implemented in Part 2'", async () => {
      for (const mode of ["semantic", "hybrid"]) {
        const r = await anon("GET", `/api/search?q=bert&mode=${mode}`);
        expectStatus(r, 501, "NOT_IMPLEMENTED");
        assert.equal(r.body.error.message, "implemented in Part 2");
      }
    });
    it("bad input -> 400", async () => {
      for (const url of ["/api/search", "/api/search?q=%20", "/api/search?q=x&mode=fuzzy", "/api/search?q=x&page=0", "/api/search?q=x&year=abc"]) {
        expectStatus(await anon("GET", url), 400, "VALIDATION_ERROR");
      }
    });
  });

  // ------------------------------------------------------------ papers (read)
  describe("papers: read", () => {
    it("list -> summaries, newest first, total = all papers", async () => {
      const r = await anon("GET", "/api/papers");
      expectStatus(r, 200);
      hasKeys(r.body, ["results", "total"], "list body");
      assert.equal(r.body.results.length, 20);
      r.body.results.forEach((x) => hasKeys(x, K.summary, "PaperSummary"));
      const { rows } = await db.query("SELECT count(*)::int AS n FROM papers");
      assert.equal(r.body.total, rows[0].n);
      const y = await anon("GET", "/api/papers?year=2018");
      assert.ok(y.body.results.every((x) => x.year === 2018));
    });
    it("detail of the most-cited paper: full shape, cited_by length = citation_count", async () => {
      const r = await anon("GET", `/api/papers/${s.top.paper_id}`);
      expectStatus(r, 200);
      hasKeys(r.body, K.detail, "paper detail");
      if (r.body.conference) hasKeys(r.body.conference, K.detailConference, "detail conference");
      r.body.authors.forEach((a) => hasKeys(a, K.detailAuthor, "detail author"));
      r.body.cited_by.forEach((p) => hasKeys(p, K.linkedPaper, "cited_by item"));
      r.body.references.forEach((p) => hasKeys(p, K.linkedPaper, "reference item"));
      assert.equal(r.body.cited_by.length, r.body.citation_count);
    });
    it("unknown id -> 404, malformed id -> 400", async () => {
      expectStatus(await anon("GET", "/api/papers/99999999"), 404, "NOT_FOUND");
      expectStatus(await anon("GET", "/api/papers/abc"), 400, "VALIDATION_ERROR");
    });
  });

  // ------------------------------------------------------------ conferences
  describe("conferences", () => {
    it("POST: 401 anon, 403 researcher, 201 admin", async () => {
      const body = { name: "API test conference", acronym: "APIT", year: 2026, location: "Bengaluru" };
      expectStatus(await anon("POST", "/api/conferences", body), 401);
      expectStatus(await researcher("POST", "/api/conferences", body), 403, "FORBIDDEN");
      const r = await admin("POST", "/api/conferences", body);
      expectStatus(r, 201);
      hasKeys(r.body, K.conference, "Conference");
      s.conf = r.body.conference_id;
    });
    it("duplicate name + year -> 409", async () => {
      expectStatus(await admin("POST", "/api/conferences", { name: "API test conference", year: 2026 }), 409, "CONFLICT");
    });
    it("list with q, and detail", async () => {
      const l = await anon("GET", "/api/conferences?q=API%20test");
      expectStatus(l, 200);
      assert.equal(l.body.total, 1);
      hasKeys(l.body.results[0], K.conferenceItem, "conference list item");
      const all = await anon("GET", "/api/conferences");
      assert.ok(all.body.total > 100);
      const d = await anon("GET", `/api/conferences/${s.conf}`);
      expectStatus(d, 200);
      hasKeys(d.body, [...K.conferenceItem, "papers"], "conference detail");
    });
    it("PATCH location", async () => {
      const r = await admin("PATCH", `/api/conferences/${s.conf}`, { location: "Mysuru" });
      expectStatus(r, 200);
      hasKeys(r.body, K.conference, "Conference");
      assert.equal(r.body.location, "Mysuru");
      expectStatus(await admin("PATCH", "/api/conferences/99999999", { location: "x" }), 404);
    });
  });

  // ------------------------------------------------------------ papers (write)
  describe("papers: write", () => {
    it("POST: 401 anon, 403 researcher", async () => {
      const body = { title: "API test paper", authors: [{ name: "API test author" }] };
      expectStatus(await anon("POST", "/api/papers", body), 401);
      expectStatus(await researcher("POST", "/api/papers", body), 403);
    });
    it("POST admin -> 201, pending, authors in order, citation counted by the trigger", async () => {
      const r = await admin("POST", "/api/papers", {
        title: "API test paper on retrieval augmented generation",
        abstract: "An API test abstract about retrieval augmented generation.",
        year: 2026,
        doi: "https://doi.org/10.9999/API.TEST.1",
        conference_id: s.conf,
        authors: [{ name: "API test author one", affiliation: "PES University" }, { name: "API test author two" }],
        cited_paper_ids: [s.top.paper_id],
      });
      expectStatus(r, 201);
      hasKeys(r.body, ["paper_id", "embedding_status"], "POST /api/papers body");
      assert.equal(r.body.embedding_status, "pending");
      s.paper = r.body.paper_id;

      const d = await anon("GET", `/api/papers/${s.paper}`);
      assert.equal(d.body.embedding_status, "pending");
      assert.equal(d.body.doi, "10.9999/api.test.1");
      assert.deepEqual(d.body.authors.map((a) => a.name), ["API test author one", "API test author two"]);
      assert.equal(d.body.conference.conference_id, s.conf);
      assert.deepEqual(d.body.references.map((p) => p.paper_id), [s.top.paper_id]);
      const top = await anon("GET", `/api/papers/${s.top.paper_id}`);
      assert.equal(top.body.citation_count, s.top.citation_count + 1);
    });
    it("POST failures roll back completely", async () => {
      const before = (await db.query("SELECT count(*)::int AS n FROM papers")).rows[0].n;
      expectStatus(await admin("POST", "/api/papers", { title: "API test bad", authors: [{ name: "API test ghost" }], cited_paper_ids: [999999] }), 400);
      expectStatus(await admin("POST", "/api/papers", { title: "API test bad", authors: [] }), 400);
      expectStatus(await admin("POST", "/api/papers", { title: "API test bad", authors: [{ name: "x" }], doi: "10.9999/api.test.1" }), 409);
      expectStatus(await admin("POST", "/api/papers", { title: "API test bad", authors: [{ name: "x" }], conference_id: 99999999 }), 400);
      const after = (await db.query("SELECT count(*)::int AS n FROM papers")).rows[0].n;
      assert.equal(after, before, "a failed POST left a paper behind");
      const ghost = await db.query("SELECT 1 FROM authors WHERE name = 'API test ghost'");
      assert.equal(ghost.rows.length, 0, "a failed POST left an author behind");
    });
    it("PATCH: year keeps embedding_status, title change resets it to pending", async () => {
      await db.query("UPDATE papers SET embedding_status = 'done' WHERE paper_id = $1", [s.paper]); // as if embedded
      let r = await admin("PATCH", `/api/papers/${s.paper}`, { year: 2025 });
      expectStatus(r, 200);
      hasKeys(r.body, K.detail, "PATCH body");
      assert.equal(r.body.year, 2025);
      assert.equal(r.body.embedding_status, "done");
      r = await admin("PATCH", `/api/papers/${s.paper}`, { title: "API test paper, retitled" });
      assert.equal(r.body.embedding_status, "pending");
      expectStatus(await admin("PATCH", `/api/papers/${s.paper}`, {}), 400);
      expectStatus(await researcher("PATCH", `/api/papers/${s.paper}`, { year: 2020 }), 403);
      expectStatus(await admin("PATCH", "/api/papers/99999999", { year: 2020 }), 404);
    });
  });

  // ------------------------------------------------------------ authors
  describe("authors", () => {
    it("list (most cited first) and fuzzy search", async () => {
      const r = await anon("GET", "/api/authors");
      expectStatus(r, 200);
      r.body.results.forEach((a) => hasKeys(a, K.authorItem, "author list item"));
      const c = r.body.results.map((a) => a.total_citations);
      assert.deepEqual(c, [...c].sort((a, b) => b - a));
      const q = await anon("GET", "/api/authors?q=API%20test%20author");
      assert.equal(q.body.total, 2);
    });
    it("detail lists the author's papers", async () => {
      const q = await anon("GET", "/api/authors?q=API%20test%20author%20one");
      const d = await anon("GET", `/api/authors/${q.body.results[0].author_id}`);
      expectStatus(d, 200);
      hasKeys(d.body, [...K.authorItem, "papers"], "author detail");
      assert.equal(d.body.papers[0].paper_id, s.paper);
      d.body.papers.forEach((p) => hasKeys(p, K.summary, "PaperSummary"));
    });
    it("POST / PATCH / DELETE (admin), 403 for researcher", async () => {
      expectStatus(await researcher("POST", "/api/authors", { name: "API test author three" }), 403);
      const c = await admin("POST", "/api/authors", { name: "API test author three", affiliation: "IISc" });
      expectStatus(c, 201);
      hasKeys(c.body, ["author_id", "name", "affiliation"], "author");
      const p = await admin("PATCH", `/api/authors/${c.body.author_id}`, { affiliation: null });
      expectStatus(p, 200);
      assert.equal(p.body.affiliation, null);
      assert.equal(p.body.name, "API test author three");
      expectStatus(await admin("DELETE", `/api/authors/${c.body.author_id}`), 200);
      expectStatus(await anon("GET", `/api/authors/${c.body.author_id}`), 404);
    });
  });

  // ------------------------------------------------------------ bookmarks
  describe("bookmarks", () => {
    it("401 without a session", async () => {
      expectStatus(await anon("GET", "/api/bookmarks"), 401);
      expectStatus(await anon("POST", "/api/bookmarks", { paper_id: s.paper }), 401);
    });
    it("add, duplicate, unknown paper", async () => {
      const r = await researcher("POST", "/api/bookmarks", { paper_id: s.paper });
      expectStatus(r, 201);
      hasKeys(r.body, ["paper_id", "bookmarked_at"], "bookmark");
      expectStatus(await researcher("POST", "/api/bookmarks", { paper_id: s.paper }), 409, "CONFLICT");
      expectStatus(await researcher("POST", "/api/bookmarks", { paper_id: 99999999 }), 404);
      expectStatus(await researcher("POST", "/api/bookmarks", {}), 400);
    });
    it("list is per user", async () => {
      const r = await researcher("GET", "/api/bookmarks");
      expectStatus(r, 200);
      assert.equal(r.body.total, 1);
      hasKeys(r.body.results[0], K.bookmarkItem, "bookmark item");
      const a = await admin("GET", "/api/bookmarks");
      assert.ok(!a.body.results.some((b) => b.paper_id === s.paper), "admin sees the researcher's bookmark");
    });
    it("remove, then remove again -> 404", async () => {
      const r = await researcher("DELETE", `/api/bookmarks/${s.paper}`);
      expectStatus(r, 200);
      assert.deepEqual(r.body, { paper_id: s.paper, deleted: true });
      expectStatus(await researcher("DELETE", `/api/bookmarks/${s.paper}`), 404);
    });
  });

  // ------------------------------------------------------------ stats
  describe("stats", () => {
    it("overview has every section with the contract fields", async () => {
      const r = await anon("GET", "/api/stats/overview");
      expectStatus(r, 200);
      hasKeys(r.body, K.stats, "stats");
      hasKeys(r.body.totals, K.totals, "totals");
      assert.equal(r.body.top_cited.length, 10);
      r.body.top_cited.forEach((x) => hasKeys(x, K.topCited, "top_cited item"));
      r.body.papers_per_year.forEach((x) => hasKeys(x, K.perYear, "papers_per_year item"));
      r.body.conference_stats.forEach((x) => hasKeys(x, K.confStat, "conference_stats item"));
      r.body.top_authors.forEach((x) => hasKeys(x, K.topAuthor, "top_authors item"));
      const years = r.body.papers_per_year.map((x) => x.year);
      assert.deepEqual(years, [...years].sort((a, b) => a - b));
      const cites = r.body.top_cited.map((x) => x.citation_count);
      assert.deepEqual(cites, [...cites].sort((a, b) => b - a));
      const { rows } = await db.query("SELECT count(*)::int AS n FROM papers");
      assert.equal(r.body.totals.papers, rows[0].n);
    });
  });

  // ------------------------------------------------------------ delete + audit
  describe("delete and audit", () => {
    it("DELETE paper: 403 researcher, 200 admin, then 404", async () => {
      expectStatus(await researcher("DELETE", `/api/papers/${s.paper}`), 403);
      const r = await admin("DELETE", `/api/papers/${s.paper}`);
      expectStatus(r, 200);
      assert.deepEqual(r.body, { paper_id: s.paper, deleted: true });
      expectStatus(await anon("GET", `/api/papers/${s.paper}`), 404);
      expectStatus(await admin("DELETE", `/api/papers/${s.paper}`), 404);
    });
    it("the cited paper's count went back down (cascade + trigger)", async () => {
      const top = await anon("GET", `/api/papers/${s.top.paper_id}`);
      assert.equal(top.body.citation_count, s.top.citation_count);
    });
    it("audit log recorded the deletion with the admin", async () => {
      expectStatus(await researcher("GET", "/api/admin/audit-log"), 403);
      const r = await admin("GET", "/api/admin/audit-log");
      expectStatus(r, 200);
      const row = r.body.results[0];
      hasKeys(row, K.audit, "audit row");
      assert.equal(row.paper_id, s.paper);
      assert.equal(row.action, "DELETE_PAPER");
      assert.equal(row.admin_email, process.env.ADMIN_EMAIL.toLowerCase());
    });
    it("DELETE conference -> 200, then 404", async () => {
      expectStatus(await researcher("DELETE", `/api/conferences/${s.conf}`), 403);
      expectStatus(await admin("DELETE", `/api/conferences/${s.conf}`), 200);
      expectStatus(await anon("GET", `/api/conferences/${s.conf}`), 404);
    });
    it("logout ends the session", async () => {
      expectStatus(await researcher("POST", "/api/auth/logout"), 200);
      expectStatus(await researcher("GET", "/api/auth/me"), 401);
    });
  });
});
