"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { api, errorText } from "@/lib/client";

type Overview = {
  totals: { papers: number; authors: number; citations: number; conferences: number };
  top_cited: { paper_id: number; title: string; year: number | null; conference: string | null; citation_count: number }[];
  papers_per_year: { year: number; paper_count: number }[];
  conference_stats: { conference_id: number; name: string; acronym: string | null; year: number | null; paper_count: number; total_citations: number }[];
  top_authors: { author_id: number; name: string; paper_count: number; total_citations: number }[];
};

export default function StatsPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Overview>("/api/stats/overview").then(setData).catch((e) => setError(errorText(e)));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <h1>Statistics</h1>

      <div className="stat-tiles">
        {(
          [
            ["Papers", data.totals.papers],
            ["Authors", data.totals.authors],
            ["Citations", data.totals.citations],
            ["Venue editions", data.totals.conferences],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="card stat-tile">
            <div className="muted small">{label}</div>
            <div className="value">{value.toLocaleString()}</div>
          </div>
        ))}
      </div>

      <Section title="Papers per year">
        <YearChart rows={data.papers_per_year} />
      </Section>

      <div className="grid-2">
        <Section title="Most cited papers (within the dataset)">
          <HBars
            rows={data.top_cited.map((p) => ({
              key: p.paper_id,
              label: <Link href={`/papers/${p.paper_id}`}>{p.title}</Link>,
              text: p.title,
              value: p.citation_count,
            }))}
            unit="citations"
          />
        </Section>
        <Section title="Top authors by citations">
          <HBars
            rows={data.top_authors.map((a) => ({
              key: a.author_id,
              label: a.name,
              text: `${a.name} (${a.paper_count} papers)`,
              value: a.total_citations,
            }))}
            unit="citations"
          />
        </Section>
      </div>

      <Section title="Top venues">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Venue</th>
                <th className="num">Year</th>
                <th className="num">Papers</th>
                <th className="num">Citations</th>
              </tr>
            </thead>
            <tbody>
              {data.conference_stats.map((c) => (
                <tr key={c.conference_id}>
                  <td>{c.acronym ? `${c.acronym} · ${c.name}` : c.name}</td>
                  <td className="num">{c.year ?? "–"}</td>
                  <td className="num">{c.paper_count}</td>
                  <td className="num">{c.total_citations.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      {children}
    </section>
  );
}

/** Column chart, one bar per year. Hover a bar for its value; the table view lists every number. */
function YearChart({ rows }: { rows: { year: number; paper_count: number }[] }) {
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  if (rows.length === 0) return <p className="muted">No data.</p>;

  const W = 900;
  const H = 240;
  const pad = { l: 36, r: 8, t: 12, b: 26 };
  const max = Math.max(...rows.map((r) => r.paper_count));
  const step = (W - pad.l - pad.r) / rows.length;
  const barW = Math.max(2, step - 2); // 2px gap between bars
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, Math.round(max / 2), max];
  const labelEvery = Math.ceil(rows.length / 12);
  const hovered = hover === null ? null : rows[hover];

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: "0.5rem" }}>
        <span className="muted small">{hovered ? `${hovered.year}: ${hovered.paper_count} papers` : "Hover a bar for its value"}</span>
        <button className="link small" onClick={() => setAsTable(!asTable)}>
          {asTable ? "Show chart" : "Show table"}
        </button>
      </div>
      {asTable ? (
        <div className="table-wrap" style={{ maxHeight: 260, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Year</th>
                <th className="num">Papers</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.year}>
                  <td>{r.year}</td>
                  <td className="num">{r.paper_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Papers per year, column chart">
          {ticks.map((t) => (
            <g key={t}>
              <line className="axis" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
              <text x={pad.l - 6} y={y(t) + 4} textAnchor="end">
                {t}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const x = pad.l + i * step + 1;
            const top = y(r.paper_count);
            const h = H - pad.b - top;
            return (
              <g key={r.year} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                {/* Hit target spans the full column height, bigger than the bar itself. */}
                <rect x={x - 1} y={pad.t} width={step} height={H - pad.t - pad.b} fill="transparent" />
                <path
                  className="bar"
                  style={{ opacity: hover === null || hover === i ? 1 : 0.45 }}
                  d={roundedTop(x, top, barW, h, Math.min(4, barW / 2))}
                >
                  <title>{`${r.year}: ${r.paper_count} papers`}</title>
                </path>
                {i % labelEvery === 0 && (
                  <text x={x + barW / 2} y={H - 8} textAnchor="middle">
                    {r.year}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/** A bar whose top corners are rounded and whose base sits flat on the axis. */
function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  if (h <= 0) return "";
  r = Math.min(r, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

/** Horizontal bars as HTML, so long titles can wrap/ellipsis and stay links. */
function HBars({ rows, unit }: { rows: { key: number; label: ReactNode; text: string; value: number }[]; unit: string }) {
  if (rows.length === 0) return <p className="muted">No data.</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div>
      {rows.map((r) => (
        <div key={r.key} className="hbar-row" title={`${r.text}: ${r.value.toLocaleString()} ${unit}`}>
          <span className="hbar-label">{r.label}</span>
          <span className="num small" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
            {r.value.toLocaleString()}
          </span>
          <div className="hbar-track">
            <div className="hbar-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
