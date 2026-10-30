import { requireRole } from "@/lib/auth";
import { withTransaction } from "@/lib/db";
import { badRequest, handle, json, notFound, readJson } from "@/lib/http";
import { getPaperDetail } from "@/lib/papers";
import { YEAR_MAX, YEAR_MIN, idParam, normaliseDoi, optionalInt, optionalString, requiredString } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/papers/:id: paper + conference + authors + references + cited_by
export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const paperId = idParam((await params).id);
  const paper = await getPaperDetail(paperId);
  if (!paper) throw notFound("paper");
  return json(paper);
});

// PATCH /api/papers/:id (admin): edit title, abstract, year, doi or conference_id.
export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  await requireRole("admin");
  const paperId = idParam((await params).id);
  const body = await readJson(req);

  // Only these columns can be changed. Column names come from this fixed
  // list, never from the request, and values are always $n parameters.
  const changes: Record<string, unknown> = {};
  if (body.title !== undefined) changes.title = requiredString(body.title, "title", 1000);
  if (body.abstract !== undefined) changes.abstract = optionalString(body.abstract, "abstract");
  if (body.year !== undefined) changes.year = optionalInt(body.year, "year", YEAR_MIN, YEAR_MAX);
  if (body.doi !== undefined) changes.doi = normaliseDoi(body.doi);
  if (body.conference_id !== undefined) changes.conference_id = optionalInt(body.conference_id, "conference_id", 1, 2147483647);
  if (Object.keys(changes).length === 0) {
    throw badRequest("send at least one of title, abstract, year, doi, conference_id");
  }

  const found = await withTransaction(async (client) => {
    // FOR UPDATE locks the row, so two admins editing at once cannot overwrite each other half-way.
    const { rows } = await client.query("SELECT title, abstract FROM papers WHERE paper_id = $1 FOR UPDATE", [paperId]);
    if (!rows.length) return false;

    // New text means the stored vector is out of date: mark the paper
    // 'pending' so the vector side embeds it again.
    const textChanged =
      ("title" in changes && changes.title !== rows[0].title) ||
      ("abstract" in changes && changes.abstract !== rows[0].abstract);
    if (textChanged) changes.embedding_status = "pending";

    const columns = Object.keys(changes);
    const setList = columns.map((c, i) => `${c} = $${i + 2}`).join(", ");
    await client.query(`UPDATE papers SET ${setList} WHERE paper_id = $1`, [paperId, ...columns.map((c) => changes[c])]);
    return true;
  });
  if (!found) throw notFound("paper");
  return json(await getPaperDetail(paperId));
});

// DELETE /api/papers/:id (admin)
export const DELETE = handle(async (_req: Request, { params }: Ctx) => {
  const admin = await requireRole("admin");
  const paperId = idParam((await params).id);

  const deleted = await withTransaction(async (client) => {
    // Tell the audit trigger who is deleting. The third argument (true) makes
    // the setting LOCAL: it only lasts until this transaction ends, so it can
    // never leak to another request that reuses this pooled connection.
    await client.query("SELECT set_config('app.admin_id', $1, true)", [String(admin.user_id)]);
    const { rowCount } = await client.query("DELETE FROM papers WHERE paper_id = $1", [paperId]);
    return rowCount === 1;
  });
  if (!deleted) throw notFound("paper");
  return json({ paper_id: paperId, deleted: true });
});
