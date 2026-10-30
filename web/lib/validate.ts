import { badRequest } from "./http";

// Small hand-written validators. Each one returns a clean value or throws a
// 400 VALIDATION_ERROR naming the field, so routes stay short and readable.

export function requiredString(value: unknown, field: string, max = 2000): string {
  if (typeof value !== "string" || value.trim() === "") throw badRequest(`${field} is required`);
  if (value.length > max) throw badRequest(`${field} must be at most ${max} characters`);
  return value.trim();
}

/** undefined = not sent; null = explicitly cleared. */
export function optionalString(value: unknown, field: string, max = 20000): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw badRequest(`${field} must be a string`);
  if (value.length > max) throw badRequest(`${field} must be at most ${max} characters`);
  return value.trim() === "" ? null : value.trim();
}

export function optionalInt(value: unknown, field: string, min: number, max: number): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Positive integer id from a URL segment such as /api/papers/42. */
export function idParam(value: string, field = "id"): number {
  if (!/^\d{1,9}$/.test(value) || Number(value) < 1) throw badRequest(`${field} must be a positive integer`);
  return Number(value);
}

/** Optional integer query-string parameter (?page=2, ?year=2020). */
export function intQuery(params: URLSearchParams, name: string, min: number, max: number): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw === "") return undefined;
  if (!/^-?\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw badRequest(`${name} must be an integer between ${min} and ${max}`);
  }
  return Number(raw);
}

export function pageParam(params: URLSearchParams): number {
  return intQuery(params, "page", 1, 10000) ?? 1;
}

export const YEAR_MIN = 1900;
export const YEAR_MAX = 2100;

/** Same normalisation as the database: lowercase, no https://doi.org/ prefix. */
export function normaliseDoi(value: unknown): string | null | undefined {
  const doi = optionalString(value, "doi", 300);
  if (doi === undefined || doi === null) return doi;
  const clean = doi.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  if (!clean.startsWith("10.")) throw badRequest("doi must look like 10.xxxx/yyyy");
  return clean;
}

export function email(value: unknown): string {
  const e = requiredString(value, "email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw badRequest("email is not valid");
  return e;
}
