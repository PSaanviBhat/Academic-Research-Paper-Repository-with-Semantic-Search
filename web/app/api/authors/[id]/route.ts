import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { badRequest, handle, json, notFound, readJson } from "@/lib/http";
import { SUMMARY_COLUMNS, toSummary } from "@/lib/papers";
import { idParam, optionalString, requiredString } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/authors/:id: author stats + their papers
export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const authorId = idParam((await params).id);
  const [author] = await query(
    "SELECT author_id, name, affiliation, paper_count, total_citations FROM v_author_stats WHERE author_id = $1",
    [authorId],
  );
  if (!author) throw notFound("author");
  // paper_authors(author_id) has its own index, so this lookup does not scan every link.
  const papers = await query(
    `SELECT ${SUMMARY_COLUMNS} FROM paper_authors pa
     JOIN v_paper_details d ON d.paper_id = pa.paper_id
     WHERE pa.author_id = $1
     ORDER BY d.year DESC NULLS LAST, d.paper_id DESC`,
    [authorId],
  );
  return json({ ...author, papers: papers.map(toSummary) });
});

// PATCH /api/authors/:id (admin)  { name?, affiliation? }
export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  await requireRole("admin");
  const authorId = idParam((await params).id);
  const body = await readJson(req);
  if (body.name === undefined && body.affiliation === undefined) throw badRequest("send name and/or affiliation");

  // COALESCE keeps the old name when none is sent; the CASE does the same
  // for affiliation, while still allowing it to be set to null on purpose.
  const [author] = await query(
    `UPDATE authors SET
       name = COALESCE($2, name),
       affiliation = CASE WHEN $3 THEN $4 ELSE affiliation END
     WHERE author_id = $1
     RETURNING author_id, name, affiliation`,
    [
      authorId,
      body.name === undefined ? null : requiredString(body.name, "name", 300),
      body.affiliation !== undefined,
      optionalString(body.affiliation, "affiliation", 500) ?? null,
    ],
  );
  if (!author) throw notFound("author");
  return json(author);
});

// DELETE /api/authors/:id (admin): removes the author's paper links (CASCADE); the papers stay.
export const DELETE = handle(async (_req: Request, { params }: Ctx) => {
  await requireRole("admin");
  const authorId = idParam((await params).id);
  const rows = await query("DELETE FROM authors WHERE author_id = $1 RETURNING author_id", [authorId]);
  if (!rows.length) throw notFound("author");
  return json({ author_id: authorId, deleted: true });
});
