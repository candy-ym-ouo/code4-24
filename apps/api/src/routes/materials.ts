import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { materialInputSchema } from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";

type Query = Record<string, string | undefined>;
const materialPatchSchema = materialInputSchema.partial().extend({ version: z.number().int().positive() });

function buildMaterialQuery(query: Query) {
  const values: unknown[] = [];
  const conditions = [query.archived === "true" ? "m.archived_at IS NOT NULL" : "m.archived_at IS NULL"];

  if (query.q?.trim()) {
    values.push(`%${query.q.trim()}%`);
    const i = values.length;
    conditions.push(`(
      m.name ILIKE $${i} OR m.code ILIKE $${i} OR m.subtype ILIKE $${i}
      OR EXISTS (SELECT 1 FROM unnest(m.tags) tag WHERE tag ILIKE $${i})
      OR EXISTS (
        SELECT 1 FROM batches bq LEFT JOIN sources sq ON sq.id = bq.source_id
        WHERE bq.material_id = m.id
          AND (bq.batch_code ILIKE $${i} OR sq.name ILIKE $${i}
               OR bq.current_color_name ILIKE $${i} OR bq.initial_color_name ILIKE $${i})
      )
      OR EXISTS (
        SELECT 1 FROM batches bp
        JOIN consumptions cp ON cp.batch_id = bp.id
        JOIN projects p ON p.id = cp.project_id
        WHERE bp.material_id = m.id
          AND (p.name ILIKE $${i} OR EXISTS (SELECT 1 FROM unnest(p.tags) project_tag WHERE project_tag ILIKE $${i}))
      )
    )`);
  }
  if (query.craftType) {
    values.push(query.craftType);
    conditions.push(`m.craft_types @> ARRAY[$${values.length}::craft_type]`);
  }
  if (query.tag) {
    values.push([query.tag]);
    conditions.push(`m.tags @> $${values.length}::text[]`);
  }
  if (query.sourceId) {
    values.push(query.sourceId);
    conditions.push(`EXISTS (SELECT 1 FROM batches b WHERE b.material_id = m.id AND b.source_id = $${values.length}::uuid)`);
  }
  if (query.locationId) {
    values.push(query.locationId);
    conditions.push(`EXISTS (SELECT 1 FROM batches b WHERE b.material_id = m.id AND b.location_id = $${values.length}::uuid)`);
  }
  if (query.batchCode) {
    values.push(`%${query.batchCode.trim()}%`);
    conditions.push(`EXISTS (SELECT 1 FROM batches b WHERE b.material_id = m.id AND b.batch_code ILIKE $${values.length})`);
  }
  if (query.color) {
    values.push(`%${query.color.trim()}%`);
    conditions.push(`(
      m.default_color_name ILIKE $${values.length} OR m.default_color_hex ILIKE $${values.length}
      OR EXISTS (SELECT 1 FROM batches b WHERE b.material_id = m.id
        AND (b.current_color_name ILIKE $${values.length} OR b.current_color_hex ILIKE $${values.length}))
    )`);
  }
  if (query.expiryBefore) {
    values.push(query.expiryBefore);
    conditions.push(`EXISTS (SELECT 1 FROM batches b WHERE b.material_id = m.id AND b.expiry_at IS NOT NULL AND b.expiry_at <= $${values.length}::date)`);
  }
  if (query.stockState && !["in_stock", "low_stock", "out_of_stock"].includes(query.stockState)) {
    throw new AppError(422, "INVALID_STOCK_STATE", "库存状态筛选值无效");
  }
  if (query.stockState === "out_of_stock") conditions.push("coalesce(bs.remaining_quantity, 0) = 0");
  if (query.stockState === "low_stock") conditions.push("m.low_stock_threshold IS NOT NULL AND coalesce(bs.remaining_quantity, 0) > 0 AND coalesce(bs.remaining_quantity, 0) <= m.low_stock_threshold");
  if (query.stockState === "in_stock") conditions.push("coalesce(bs.remaining_quantity, 0) > 0 AND (m.low_stock_threshold IS NULL OR coalesce(bs.remaining_quantity, 0) > m.low_stock_threshold)");

  return { values, where: conditions.join(" AND ") };
}

export async function materialRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Query }>("/materials", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const { values, where } = buildMaterialQuery(request.query);
    const cte = `
      WITH batch_stats AS (
        SELECT material_id,
               sum(remaining_quantity) FILTER (WHERE status <> 'ARCHIVED') AS remaining_quantity,
               count(*) FILTER (WHERE status <> 'ARCHIVED')::int AS batch_count,
               max(received_at) AS latest_received_at
          FROM batches GROUP BY material_id
      ), rows AS (
        SELECT m.id, m.code, m.name, m.craft_types AS "craftTypes", m.subtype,
               m.stock_unit AS "stockUnit", m.low_stock_threshold::text AS "lowStockThreshold",
               m.default_color_name AS "defaultColorName", m.default_color_hex AS "defaultColorHex",
               m.tags, m.notes, m.archived_at AS "archivedAt", m.created_at AS "createdAt",
               m.updated_at AS "updatedAt", m.version,
               coalesce(bs.remaining_quantity, 0)::text AS "remainingQuantity",
               coalesce(bs.batch_count, 0) AS "batchCount", bs.latest_received_at AS "latestReceivedAt",
               CASE
                 WHEN coalesce(bs.remaining_quantity, 0) = 0 THEN 'out_of_stock'
                 WHEN m.low_stock_threshold IS NOT NULL AND bs.remaining_quantity <= m.low_stock_threshold THEN 'low_stock'
                 ELSE 'in_stock'
               END AS "stockState"
          FROM materials m LEFT JOIN batch_stats bs ON bs.material_id = m.id
         WHERE ${where}
      )`;
    const total = await pool.query<{ count: string }>(`${cte} SELECT count(*)::text AS count FROM rows`, values);
    const sortMap: Record<string, string> = {
      name: "name", updatedAt: "\"updatedAt\"", remainingQuantity: "\"remainingQuantity\"::numeric",
      createdAt: "\"createdAt\""
    };
    const [sortField, sortDirection] = (request.query.sort ?? "updatedAt:desc").split(":");
    const sort = sortMap[sortField ?? ""] ?? sortMap.updatedAt;
    const direction = sortDirection === "asc" ? "ASC" : "DESC";
    values.push(pageSize, offset);
    const rows = await pool.query(
      `${cte} SELECT * FROM rows ORDER BY ${sort} ${direction} NULLS LAST LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.get<{ Params: { id: string } }>("/materials/:id/batches", async (request) => {
    const exists = await pool.query("SELECT 1 FROM materials WHERE id = $1", [request.params.id]);
    if (!exists.rowCount) throw new AppError(404, "NOT_FOUND", "材料不存在");
    const batches = await pool.query(
      `SELECT b.id, b.batch_code AS "batchCode", b.remaining_quantity::text AS "remainingQuantity",
              b.initial_quantity::text AS "initialQuantity", b.stock_unit AS "stockUnit", b.status,
              b.current_color_name AS "currentColorName", b.current_color_hex AS "currentColorHex",
              b.received_at AS "receivedAt", b.expiry_at AS "expiryAt", b.version,
              s.name AS "sourceName", l.name AS "locationName"
         FROM batches b LEFT JOIN sources s ON s.id = b.source_id LEFT JOIN storage_locations l ON l.id = b.location_id
        WHERE b.material_id = $1 ORDER BY b.created_at DESC`,
      [request.params.id]
    );
    return { data: batches.rows };
  });

  app.get<{ Params: { id: string } }>("/materials/:id", async (request) => {
    const material = await pool.query(
      `SELECT m.id, m.code, m.name, m.craft_types AS "craftTypes", m.subtype, m.stock_unit AS "stockUnit",
              m.low_stock_threshold::text AS "lowStockThreshold", m.default_color_name AS "defaultColorName",
              m.default_color_hex AS "defaultColorHex", m.tags, m.notes, m.archived_at AS "archivedAt",
              m.created_at AS "createdAt", m.updated_at AS "updatedAt", m.version,
              coalesce(sum(b.remaining_quantity) FILTER (WHERE b.status <> 'ARCHIVED'), 0)::text AS "remainingQuantity",
              count(b.id) FILTER (WHERE b.status <> 'ARCHIVED')::int AS "batchCount"
         FROM materials m LEFT JOIN batches b ON b.material_id = m.id
        WHERE m.id = $1 GROUP BY m.id`,
      [request.params.id]
    );
    if (!material.rows[0]) throw new AppError(404, "NOT_FOUND", "材料不存在");
    const batches = await pool.query(
      `SELECT b.id, b.batch_code AS "batchCode", b.remaining_quantity::text AS "remainingQuantity",
              b.initial_quantity::text AS "initialQuantity", b.stock_unit AS "stockUnit", b.status,
              b.current_color_name AS "currentColorName", b.current_color_hex AS "currentColorHex",
              b.received_at AS "receivedAt", b.expiry_at AS "expiryAt", b.version,
              s.name AS "sourceName", l.name AS "locationName"
         FROM batches b LEFT JOIN sources s ON s.id = b.source_id LEFT JOIN storage_locations l ON l.id = b.location_id
        WHERE b.material_id = $1 ORDER BY b.created_at DESC`,
      [request.params.id]
    );
    return { data: { ...material.rows[0], batches: batches.rows } };
  });

  app.post("/materials", async (request, reply) => {
    const input = parseInput(materialInputSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO materials(code, name, craft_types, subtype, stock_unit, low_stock_threshold,
          default_color_name, default_color_hex, tags, notes)
         VALUES ($1, $2, $3::craft_type[], $4, $5::stock_unit, $6, $7, $8, $9::text[], $10)
         RETURNING *`,
        [input.code || null, input.name, input.craftTypes, input.subtype || null, input.stockUnit,
         input.lowStockThreshold ?? null, input.defaultColorName || null, input.defaultColorHex || null, input.tags, input.notes || null]
      );
      await writeAudit(client, { actorUserId: user.id, action: "CREATE", entityType: "MATERIAL", entityId: result.rows[0]?.id, afterData: result.rows[0], requestId: request.id });
      return result.rows[0];
    });
    return reply.status(201).send({ data: created });
  });

  app.patch<{ Params: { id: string } }>("/materials/:id", async (request) => {
    const input = parseInput(materialPatchSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const before = await client.query("SELECT * FROM materials WHERE id = $1 FOR UPDATE", [request.params.id]);
      const old = before.rows[0];
      if (!old) throw new AppError(404, "NOT_FOUND", "材料不存在");
      if (old.archived_at) throw new AppError(409, "MATERIAL_ARCHIVED", "已归档材料不能修改");
      if (old.version !== input.version) throw new AppError(409, "VERSION_CONFLICT", "材料已被其他操作修改，请刷新后重试");
      if (input.stockUnit && input.stockUnit !== old.stock_unit) {
        const used = await client.query(
          `SELECT 1 FROM batches WHERE material_id = $1
           UNION ALL
           SELECT 1 FROM project_requirements WHERE material_id = $1
           LIMIT 1`,
          [request.params.id]
        );
        if (used.rowCount) throw new AppError(409, "MATERIAL_IN_USE", "已有批次或项目需求的材料不能修改库存单位");
      }
      const result = await client.query(
        `UPDATE materials SET
          code = CASE WHEN $1::boolean THEN $2 ELSE code END,
          name = coalesce($3, name),
          craft_types = coalesce($4::craft_type[], craft_types),
          subtype = CASE WHEN $5::boolean THEN $6 ELSE subtype END,
          stock_unit = coalesce($7::stock_unit, stock_unit),
          low_stock_threshold = CASE WHEN $8::boolean THEN $9 ELSE low_stock_threshold END,
          default_color_name = CASE WHEN $10::boolean THEN $11 ELSE default_color_name END,
          default_color_hex = CASE WHEN $12::boolean THEN $13 ELSE default_color_hex END,
          tags = coalesce($14::text[], tags),
          notes = CASE WHEN $15::boolean THEN $16 ELSE notes END,
          version = version + 1
         WHERE id = $17 RETURNING *`,
        [
          "code" in input, input.code || null, input.name ?? null, input.craftTypes ?? null,
          "subtype" in input, input.subtype || null, input.stockUnit ?? null,
          "lowStockThreshold" in input, input.lowStockThreshold ?? null,
          "defaultColorName" in input, input.defaultColorName || null,
          "defaultColorHex" in input, input.defaultColorHex || null,
          input.tags ?? null, "notes" in input, input.notes || null, request.params.id
        ]
      );
      await writeAudit(client, { actorUserId: user.id, action: "UPDATE", entityType: "MATERIAL", entityId: request.params.id, beforeData: old, afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  });

  app.post<{ Params: { id: string } }>("/materials/:id/archive", async (request) => {
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const material = await client.query("SELECT id FROM materials WHERE id = $1 FOR UPDATE", [request.params.id]);
      if (!material.rowCount) throw new AppError(404, "NOT_FOUND", "材料不存在");
      const stock = await client.query(
        "SELECT 1 FROM batches WHERE material_id = $1 AND status = 'ACTIVE' AND remaining_quantity > 0 LIMIT 1",
        [request.params.id]
      );
      if (stock.rowCount) throw new AppError(409, "MATERIAL_HAS_STOCK", "材料仍有正库存，不能归档");
      const result = await client.query("UPDATE materials SET archived_at = now(), version = version + 1 WHERE id = $1 RETURNING *", [request.params.id]);
      if (!result.rows[0]) throw new AppError(404, "NOT_FOUND", "材料不存在");
      await writeAudit(client, { actorUserId: user.id, action: "ARCHIVE", entityType: "MATERIAL", entityId: request.params.id, afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  });
}
