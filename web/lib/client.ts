"use client";

// Browser-side helpers for the UI pages. Every page talks to the API routes
// in app/api; the session cookie is HTTP-only and sent automatically.

export type User = { user_id: number; name: string; email: string; role: "researcher" | "admin"; created_at: string };

export type PaperSummary = {
  paper_id: number;
  title: string;
  year: number | null;
  conference: string | null;
  authors: string[];
  citation_count: number;
};

export type SearchResult = PaperSummary & { abstract_snippet: string; score: number };

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Call an API route and return its JSON, or throw ApiError with the server's message. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? "ERROR", err.message ?? `request failed (${res.status})`);
  }
  return data as T;
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
