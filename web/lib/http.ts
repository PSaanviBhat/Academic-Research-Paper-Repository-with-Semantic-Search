import { NextResponse } from "next/server";

/** An error that becomes a JSON response: { error: { code, message } }. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, "VALIDATION_ERROR", message);
export const notFound = (what: string) => new HttpError(404, "NOT_FOUND", `${what} not found`);

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status });
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * Turn a PostgreSQL error into an HTTP error. The database constraints are
 * the final guard, so a request that slips past validation still gets a
 * clear 4xx answer instead of a 500.
 */
function fromPostgres(err: { code?: string; detail?: string; message?: string; constraint?: string }) {
  switch (err.code) {
    case "23505": // unique_violation
      return errorResponse(409, "CONFLICT", err.detail ?? "already exists");
    case "23503": // foreign_key_violation: a referenced id does not exist
      return errorResponse(400, "VALIDATION_ERROR", err.detail ?? "referenced record does not exist");
    case "23514": // check_violation
    case "23502": // not_null_violation
    case "22023": // invalid_parameter_value (raised by add_paper)
    case "22P02": // invalid_text_representation
    case "22003": // numeric_value_out_of_range
      return errorResponse(400, "VALIDATION_ERROR", err.message ?? "invalid value");
    default:
      return null;
  }
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/** Wrap a route handler so every error comes back in the same JSON shape. */
export function handle<C>(fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message);
      const pg = fromPostgres(err as { code?: string });
      if (pg) return pg;
      console.error(err);
      return errorResponse(500, "INTERNAL_ERROR", "unexpected server error");
    }
  };
}

/** Read a JSON body, or fail with 400. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw badRequest("request body must be a JSON object");
}
