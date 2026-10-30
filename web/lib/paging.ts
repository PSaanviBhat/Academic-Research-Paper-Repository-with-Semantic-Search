import { query } from "./db";

export const LIST_PAGE_SIZE = 20;

export const offsetFor = (page: number) => (page - 1) * LIST_PAGE_SIZE;

/**
 * Build { results, total } for a list endpoint.
 * List queries add `count(*) OVER () AS total`, so every row carries the
 * total. Only when the page is empty (no matches, or past the end) do we
 * need a separate COUNT query.
 */
export async function pageResult<T>(
  rows: Record<string, unknown>[],
  map: (row: Record<string, unknown>) => T,
  countSql: string,
  countParams: unknown[] = [],
): Promise<{ results: T[]; total: number }> {
  if (rows.length) return { results: rows.map(map), total: rows[0].total as number };
  const [{ n }] = await query<{ n: number }>(countSql, countParams);
  return { results: [], total: n };
}

/** Escape % and _ so user input is matched literally inside ILIKE '%...%'. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);
