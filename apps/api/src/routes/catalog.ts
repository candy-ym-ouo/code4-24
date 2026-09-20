import type { FastifyInstance, FastifyRequest } from "fastify";
import { locationInputSchema, sourceInputSchema } from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { parseInput } from "../lib/validation.js";
import { parsePagination, pageMeta } from "../lib/pagination.js";
import { writeAudit } from "../lib/audit.js";

type Query = Record<string, string | undefined>;

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Query }>("/sources", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions = [request.query.archived === "true" ? "s.archived_at IS NOT NULL" : "s.archived_at IS NULL"];
    if (request.query.q) {
      values.push(`%${request.query.q.trim()}%`);
      conditions.push(`(s.name ILIKE $${values.length} OR s.contact_name ILIKE $${values.length})`);
    }
    if (request.query.type) {
      values.push(request.query.type);
      conditions.push(`s.type = $${values.length}::source_type`);
    }
    const where = conditions.join(" AND ");
    const total = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM sources s WHERE ${where}`, values);
    values.push(pageSize, offset);
    const result = await pool.query(
      `SELECT s.id, s.name, s.type, s.contact_name AS "contactName", s.contact_phone AS "contactPhone",
              s.contact_email AS "contactEmail", s.address, s.notes, s.archived_at AS "archivedAt",
              s.created_at AS "createdAt", s.updated_at AS "updatedAt",
              count(b.id)::int AS "batchCount",
              count(b.id) FILTER (WHERE b.status <> 'ARCHIVED' AND b.remaining_quantity > 0)::int AS "activeBatchCount"
         FROM sources s LEFT JOIN batches b ON b.source_id = s.id
        WHERE ${where}
        GROUP BY s.id
        ORDER BY s.updated_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: result.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.get<{ Params: { id: string } }>("/sources/:id", async (request) => {
    const result = await pool.query(
      `SELECT id, name, type, contact_name AS "contactName", contact_phone AS "contactPhone",
              contact_email AS "contactEmail", address, notes, archived_at AS "archivedAt",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM sources WHERE id = $1`,
      [request.params.id]
    );
    const source = result.rows[0];
    if (!source) throw new AppError(404, "NOT_FOUND", "来源不存在");
    const batches = await pool.query(
      `SELECT b.id, b.batch_code AS "batchCode", b.remaining_quantity::text AS "remainingQuantity",
              b.stock_unit AS "stockUnit", b.status, b.received_at AS "receivedAt",
              m.id AS "materialId", m.name AS "materialName"
         FROM batches b JOIN materials m ON m.id = b.material_id
        WHERE b.source_id = $1 ORDER BY b.created_at DESC`,
      [request.params.id]
    );
    return { data: { ...source, batches: batches.rows } };
  });

  app.post("/sources", async (request, reply) => {
    const input = parseInput(sourceInputSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO sources(name, type, contact_name, contact_phone, contact_email, address, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, type, contact_name AS "contactName", contact_phone AS "contactPhone",
                   contact_email AS "contactEmail", address, notes, archived_at AS "archivedAt",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [input.name, input.type, input.contactName || null, input.contactPhone || null, input.contactEmail || null, input.address || null, input.notes || null]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "CREATE", entityType: "SOURCE", entityId: result.rows[0]?.id,
        afterData: result.rows[0], requestId: request.id
      });
      return result.rows[0];
    });
    return reply.status(201).send({ data: created });
  });

  app.patch<{ Params: { id: string } }>("/sources/:id", async (request) => {
    const input = parseInput(sourceInputSchema.partial(), request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const before = await client.query("SELECT * FROM sources WHERE id = $1 FOR UPDATE", [request.params.id]);
      const old = before.rows[0];
      if (!old) throw new AppError(404, "NOT_FOUND", "来源不存在");
      const result = await client.query(
        `UPDATE sources SET
          name = coalesce($1, name), type = coalesce($2::source_type, type),
          contact_name = CASE WHEN $3::boolean THEN $4 ELSE contact_name END,
          contact_phone = CASE WHEN $5::boolean THEN $6 ELSE contact_phone END,
          contact_email = CASE WHEN $7::boolean THEN $8 ELSE contact_email END,
          address = CASE WHEN $9::boolean THEN $10 ELSE address END,
          notes = CASE WHEN $11::boolean THEN $12 ELSE notes END
         WHERE id = $13 RETURNING *`,
        [
          input.name ?? null, input.type ?? null,
          "contactName" in input, input.contactName || null,
          "contactPhone" in input, input.contactPhone || null,
          "contactEmail" in input, input.contactEmail || null,
          "address" in input, input.address || null,
          "notes" in input, input.notes || null,
          request.params.id
        ]
      );
      await writeAudit(client, { actorUserId: user.id, action: "UPDATE", entityType: "SOURCE", entityId: request.params.id, beforeData: old, afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  });

  app.post<{ Params: { id: string } }>("/sources/:id/archive", async (request) => archiveSource(request.params.id, true, request));
  app.post<{ Params: { id: string } }>("/sources/:id/unarchive", async (request) => archiveSource(request.params.id, false, request));

  async function archiveSource(id: string, archived: boolean, request: FastifyRequest) {
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const result = await client.query(
        "UPDATE sources SET archived_at = CASE WHEN $1 THEN now() ELSE NULL END WHERE id = $2 RETURNING *",
        [archived, id]
      );
      if (!result.rows[0]) throw new AppError(404, "NOT_FOUND", "来源不存在");
      await writeAudit(client, { actorUserId: user.id, action: archived ? "ARCHIVE" : "UNARCHIVE", entityType: "SOURCE", entityId: id, afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  }

  app.get<{ Querystring: Query }>("/locations", async (request) => {
    const includeArchived = request.query.archived === "true";
    const result = await pool.query(
      `SELECT l.id, l.name, l.parent_id AS "parentId", l.notes, l.archived_at AS "archivedAt",
              l.created_at AS "createdAt", l.updated_at AS "updatedAt",
              count(b.id)::int AS "batchCount"
         FROM storage_locations l
         LEFT JOIN batches b ON b.location_id = l.id AND b.status <> 'ARCHIVED'
        WHERE ${includeArchived ? "l.archived_at IS NOT NULL" : "l.archived_at IS NULL"}
        GROUP BY l.id ORDER BY l.name`
    );
    return { data: result.rows };
  });

  app.post("/locations", async (request, reply) => {
    const input = parseInput(locationInputSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      if (input.parentId) {
        const parent = await client.query("SELECT id FROM storage_locations WHERE id = $1 AND archived_at IS NULL FOR SHARE", [input.parentId]);
        if (!parent.rowCount) throw new AppError(422, "INVALID_PARENT", "上级位置不存在或已归档");
      }
      const result = await client.query(
        `INSERT INTO storage_locations(name, parent_id, notes) VALUES ($1, $2, $3) RETURNING *`,
        [input.name, input.parentId || null, input.notes || null]
      );
      await writeAudit(client, { actorUserId: user.id, action: "CREATE", entityType: "LOCATION", entityId: result.rows[0]?.id, afterData: result.rows[0], requestId: request.id });
      return result.rows[0];
    });
    return reply.status(201).send({ data: created });
  });

  app.patch<{ Params: { id: string } }>("/locations/:id", async (request) => {
    const input = parseInput(locationInputSchema.partial(), request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      if (input.parentId === request.params.id) throw new AppError(422, "LOCATION_CYCLE", "位置不能作为自己的上级");
      if (input.parentId) {
        const parent = await client.query("SELECT id FROM storage_locations WHERE id = $1 AND archived_at IS NULL FOR SHARE", [input.parentId]);
        if (!parent.rowCount) throw new AppError(422, "INVALID_PARENT", "上级位置不存在或已归档");
        const cycle = await client.query(
          `WITH RECURSIVE ancestors AS (
             SELECT id, parent_id FROM storage_locations WHERE id = $1
             UNION SELECT l.id, l.parent_id FROM storage_locations l JOIN ancestors a ON l.id = a.parent_id
           ) SELECT id FROM ancestors WHERE id = $2`,
          [input.parentId, request.params.id]
        );
        if (cycle.rowCount) throw new AppError(422, "LOCATION_CYCLE", "位置层级不能形成循环");
      }
      const before = await client.query("SELECT * FROM storage_locations WHERE id = $1 FOR UPDATE", [request.params.id]);
      if (!before.rows[0]) throw new AppError(404, "NOT_FOUND", "位置不存在");
      const result = await client.query(
        `UPDATE storage_locations SET name = coalesce($1, name),
          parent_id = CASE WHEN $2::boolean THEN $3 ELSE parent_id END,
          notes = CASE WHEN $4::boolean THEN $5 ELSE notes END
         WHERE id = $6 RETURNING *`,
        [input.name ?? null, "parentId" in input, input.parentId || null, "notes" in input, input.notes || null, request.params.id]
      );
      await writeAudit(client, { actorUserId: user.id, action: "UPDATE", entityType: "LOCATION", entityId: request.params.id, beforeData: before.rows[0], afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  });

  app.post<{ Params: { id: string } }>("/locations/:id/archive", async (request) => {
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const current = await client.query("SELECT id FROM storage_locations WHERE id = $1 FOR UPDATE", [request.params.id]);
      if (!current.rows[0]) throw new AppError(404, "NOT_FOUND", "位置不存在");
      const children = await client.query(
        "SELECT 1 FROM storage_locations WHERE parent_id = $1 AND archived_at IS NULL LIMIT 1",
        [request.params.id]
      );
      if (children.rowCount) throw new AppError(409, "LOCATION_HAS_CHILDREN", "请先归档该位置下的子位置");
      const result = await client.query("UPDATE storage_locations SET archived_at = now() WHERE id = $1 RETURNING *", [request.params.id]);
      await writeAudit(client, { actorUserId: user.id, action: "ARCHIVE", entityType: "LOCATION", entityId: request.params.id, afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  });
}
