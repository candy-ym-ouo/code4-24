import type { FastifyInstance } from "fastify";
import { addQuantities, adjustmentSchema, batchCreateSchema, batchPatchSchema, compareQuantities, convertQuantity, subtractQuantities } from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";
import { getIdempotencyKey } from "../lib/idempotency.js";

type Query = Record<string, string | undefined>;
type UnitRecord = { stock_unit: string; [key: string]: unknown };

export async function batchRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Query }>("/batches", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (request.query.archived === "true") {
      conditions.push("b.status = 'ARCHIVED'");
    } else if (!request.query.status) {
      conditions.push("b.status <> 'ARCHIVED'");
    }
    if (request.query.q?.trim()) {
      values.push(`%${request.query.q.trim()}%`);
      const i = values.length;
      conditions.push(`(
        m.name ILIKE $${i} OR m.code ILIKE $${i} OR b.batch_code ILIKE $${i}
        OR s.name ILIKE $${i} OR b.current_color_name ILIKE $${i} OR b.notes ILIKE $${i}
        OR EXISTS (
          SELECT 1 FROM consumptions c JOIN projects p ON p.id = c.project_id
          WHERE c.batch_id = b.id
            AND (p.name ILIKE $${i} OR EXISTS (SELECT 1 FROM unnest(p.tags) project_tag WHERE project_tag ILIKE $${i}))
        )
      )`);
    }
    for (const [key, column] of [["materialId", "b.material_id"], ["sourceId", "b.source_id"], ["locationId", "b.location_id"]] as const) {
      if (request.query[key]) {
        values.push(request.query[key]);
        conditions.push(`${column} = $${values.length}::uuid`);
      }
    }
    if (request.query.craftType) {
      values.push(request.query.craftType);
      conditions.push(`m.craft_types @> ARRAY[$${values.length}::craft_type]`);
    }
    if (request.query.status) {
      values.push(request.query.status);
      conditions.push(`b.status = $${values.length}::batch_status`);
    }
    if (request.query.color?.trim()) {
      values.push(`%${request.query.color.trim()}%`);
      conditions.push(`(b.current_color_name ILIKE $${values.length} OR b.current_color_hex ILIKE $${values.length})`);
    }
    if (request.query.expiryBefore) {
      values.push(request.query.expiryBefore);
      conditions.push(`b.expiry_at IS NOT NULL AND b.expiry_at <= $${values.length}::date`);
    }
    if (request.query.stockState && !["in_stock", "low_stock", "out_of_stock"].includes(request.query.stockState)) {
      throw new AppError(422, "INVALID_STOCK_STATE", "库存状态筛选值无效");
    }
    if (request.query.stockState === "out_of_stock") conditions.push("b.remaining_quantity = 0");
    if (request.query.stockState === "low_stock") conditions.push("b.remaining_quantity > 0 AND m.low_stock_threshold IS NOT NULL AND b.remaining_quantity <= m.low_stock_threshold");
    if (request.query.stockState === "in_stock") conditions.push("b.remaining_quantity > 0");
    const where = conditions.join(" AND ");
    const base = `FROM batches b JOIN materials m ON m.id = b.material_id
      LEFT JOIN sources s ON s.id = b.source_id LEFT JOIN storage_locations l ON l.id = b.location_id
      WHERE ${where}`;
    const total = await pool.query<{ count: string }>(`SELECT count(*)::text AS count ${base}`, values);
    const sortMap: Record<string, string> = {
      receivedAt: "b.received_at", expiryAt: "b.expiry_at", remainingQuantity: "b.remaining_quantity",
      updatedAt: "b.updated_at", batchCode: "b.batch_code", materialName: "m.name"
    };
    const [field, directionValue] = (request.query.sort ?? "updatedAt:desc").split(":");
    const sort = sortMap[field ?? ""] ?? sortMap.updatedAt;
    const direction = directionValue === "asc" ? "ASC" : "DESC";
    values.push(pageSize, offset);
    const rows = await pool.query(
      `SELECT b.id, b.material_id AS "materialId", m.name AS "materialName", m.code AS "materialCode",
              m.craft_types AS "craftTypes", b.batch_code AS "batchCode", b.source_id AS "sourceId", s.name AS "sourceName",
              b.location_id AS "locationId", l.name AS "locationName", b.received_at AS "receivedAt",
              b.expiry_at AS "expiryAt", b.initial_quantity::text AS "initialQuantity",
              b.remaining_quantity::text AS "remainingQuantity", b.stock_unit AS "stockUnit", b.entry_unit AS "entryUnit",
              b.current_color_name AS "currentColorName", b.current_color_hex AS "currentColorHex", b.status,
              b.notes, b.created_at AS "createdAt", b.updated_at AS "updatedAt", b.version
         ${base} ORDER BY ${sort} ${direction} NULLS LAST LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.get<{ Params: { id: string } }>("/batches/:id", async (request) => {
    const result = await pool.query(
      `SELECT b.id, b.material_id AS "materialId", m.name AS "materialName", m.code AS "materialCode",
              m.craft_types AS "craftTypes", b.batch_code AS "batchCode", b.source_id AS "sourceId", s.name AS "sourceName",
              b.source_note AS "sourceNote", b.location_id AS "locationId", l.name AS "locationName",
              b.received_at AS "receivedAt", b.expiry_at AS "expiryAt", b.initial_quantity::text AS "initialQuantity",
              b.remaining_quantity::text AS "remainingQuantity", b.stock_unit AS "stockUnit", b.entry_unit AS "entryUnit",
              b.total_cost::text AS "totalCost", b.currency, b.initial_color_name AS "initialColorName",
              b.initial_color_hex AS "initialColorHex", b.current_color_name AS "currentColorName",
              b.current_color_hex AS "currentColorHex", b.color_updated_at AS "colorUpdatedAt", b.status, b.notes,
              b.created_at AS "createdAt", b.updated_at AS "updatedAt", b.version
         FROM batches b JOIN materials m ON m.id = b.material_id
         LEFT JOIN sources s ON s.id = b.source_id LEFT JOIN storage_locations l ON l.id = b.location_id
        WHERE b.id = $1`,
      [request.params.id]
    );
    if (!result.rows[0]) throw new AppError(404, "NOT_FOUND", "批次不存在");
    const [movements, colors, attachments] = await Promise.all([
      pool.query(
        `SELECT id, type, signed_quantity::text AS "signedQuantity", stock_unit AS "stockUnit",
                before_quantity::text AS "beforeQuantity", after_quantity::text AS "afterQuantity",
                reference_type AS "referenceType", reference_id AS "referenceId", reason, created_at AS "createdAt"
           FROM stock_movements WHERE batch_id = $1 ORDER BY created_at DESC`,
        [request.params.id]
      ),
      pool.query(
        `SELECT id, change_type AS "changeType", before_color_name AS "beforeColorName", before_color_hex AS "beforeColorHex",
                after_color_name AS "afterColorName", after_color_hex AS "afterColorHex", occurred_at AS "occurredAt",
                notes, project_id AS "projectId", consumption_id AS "consumptionId"
           FROM color_changes WHERE batch_id = $1 ORDER BY occurred_at DESC, created_at DESC`,
        [request.params.id]
      ),
      pool.query(
        `SELECT id, original_name AS "originalName", mime_type AS "mimeType", byte_size::text AS "byteSize", created_at AS "createdAt"
           FROM attachments WHERE owner_type = 'BATCH' AND owner_id = $1 ORDER BY created_at DESC`,
        [request.params.id]
      )
    ]);
    return { data: { ...result.rows[0], movements: movements.rows, colorChanges: colors.rows, attachments: attachments.rows } };
  });

  app.post("/batches", async (request, reply) => {
    const input = parseInput(batchCreateSchema, request.body);
    if (input.expiryAt && input.expiryAt < input.receivedAt) {
      throw new AppError(422, "INVALID_EXPIRY_DATE", "有效期不能早于入库日期");
    }
    const user = (request as AuthenticatedRequest).authUser;
    const idempotencyKey = getIdempotencyKey(request.headers);
    const created = await withTransaction(async (client) => {
      if (idempotencyKey) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [idempotencyKey]);
        const existing = await client.query(
          `SELECT b.* FROM stock_movements sm JOIN batches b ON b.id = sm.batch_id
            WHERE sm.idempotency_key = $1
              AND sm.reference_type = 'BATCH'
              AND sm.reference_id = b.id
              AND sm.type IN ('OPENING', 'PURCHASE')
            LIMIT 1`,
          [idempotencyKey]
        );
        if (existing.rows[0]) return { data: existing.rows[0], idempotent: true };
      }

      const materialResult = await client.query<UnitRecord & { id: string; default_color_name: string | null; default_color_hex: string | null }>(
        `SELECT id, stock_unit, default_color_name, default_color_hex FROM materials WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
        [input.materialId]
      );
      const material = materialResult.rows[0];
      if (!material) throw new AppError(422, "INVALID_MATERIAL", "材料不存在或已归档");
      let normalizedQuantity: string;
      try {
        normalizedQuantity = convertQuantity(input.initialQuantity, input.entryUnit, material.stock_unit as any);
      } catch {
        throw new AppError(422, "UNIT_INCOMPATIBLE", "入库单位与材料库存单位不兼容");
      }
      if (input.sourceId) {
        const source = await client.query("SELECT id FROM sources WHERE id = $1 AND archived_at IS NULL FOR SHARE", [input.sourceId]);
        if (!source.rowCount) throw new AppError(422, "INVALID_SOURCE", "来源不存在或已归档");
      }
      if (input.locationId) {
        const location = await client.query("SELECT id FROM storage_locations WHERE id = $1 AND archived_at IS NULL FOR SHARE", [input.locationId]);
        if (!location.rowCount) throw new AppError(422, "INVALID_LOCATION", "存放位置不存在或已归档");
      }
      const initialColorName = input.initialColorName || material.default_color_name;
      const initialColorHex = input.initialColorHex || material.default_color_hex;
      const batch = await client.query(
        `INSERT INTO batches(material_id, batch_code, source_id, source_note, location_id, received_at, expiry_at,
          initial_quantity, remaining_quantity, stock_unit, entry_unit, total_cost, currency,
          initial_color_name, initial_color_hex, current_color_name, current_color_hex, color_updated_at, notes)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $8, $9::stock_unit, $10::stock_unit, $11, $12,
                 $13::varchar(80), $14::char(7), $13::varchar(80), $14::char(7), CASE WHEN $13 IS NULL AND $14 IS NULL THEN NULL ELSE now() END, $15)
         RETURNING *`,
        [
          input.materialId, input.batchCode || null, input.sourceId || null, input.sourceNote || null,
          input.locationId || null, input.receivedAt, input.expiryAt || null, normalizedQuantity,
          material.stock_unit, input.entryUnit, input.totalCost ?? null, input.currency || null,
          initialColorName, initialColorHex, input.notes || null
        ]
      );
      const batchId = batch.rows[0]?.id as string;
      await client.query(
        `INSERT INTO stock_movements(batch_id, type, signed_quantity, stock_unit, before_quantity, after_quantity,
          reference_type, reference_id, actor_user_id, idempotency_key)
         VALUES ($1, 'OPENING', $2, $3::stock_unit, 0, $2, 'BATCH', $1, $4, $5)`,
        [batchId, normalizedQuantity, material.stock_unit, user.id, idempotencyKey ?? null]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "CREATE", entityType: "BATCH", entityId: batchId,
        afterData: batch.rows[0], requestId: request.id
      });
      return { data: batch.rows[0], idempotent: false };
    });
    return reply.status(created.idempotent ? 200 : 201).send({ data: created.data });
  });

  app.patch<{ Params: { id: string } }>("/batches/:id", async (request) => {
    const input = parseInput(batchPatchSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const before = await client.query("SELECT * FROM batches WHERE id = $1 FOR UPDATE", [request.params.id]);
      const old = before.rows[0];
      if (!old) throw new AppError(404, "NOT_FOUND", "批次不存在");
      if (old.status === "ARCHIVED") throw new AppError(409, "BATCH_ARCHIVED", "已归档批次不能修改");
      const material = await client.query("SELECT id FROM materials WHERE id = $1 AND archived_at IS NULL FOR SHARE", [old.material_id]);
      if (!material.rowCount) throw new AppError(409, "MATERIAL_ARCHIVED", "材料已归档，不能修改其批次");
      if (old.version !== input.version) throw new AppError(409, "VERSION_CONFLICT", "批次已被其他操作修改，请刷新后重试");
      if (input.locationId) {
        const location = await client.query("SELECT id FROM storage_locations WHERE id = $1 AND archived_at IS NULL FOR SHARE", [input.locationId]);
        if (!location.rowCount) throw new AppError(422, "INVALID_LOCATION", "存放位置不存在或已归档");
      }
      if ("expiryAt" in input && input.expiryAt) {
        const validExpiry = await client.query<{ valid: boolean }>(
          "SELECT $1::date >= received_at AS valid FROM batches WHERE id = $2",
          [input.expiryAt, request.params.id]
        );
        if (!validExpiry.rows[0]?.valid) throw new AppError(422, "INVALID_EXPIRY_DATE", "有效期不能早于入库日期");
      }
      const result = await client.query(
        `UPDATE batches SET
          location_id = CASE WHEN $1::boolean THEN $2 ELSE location_id END,
          expiry_at = CASE WHEN $3::boolean THEN $4::date ELSE expiry_at END,
          notes = CASE WHEN $5::boolean THEN $6 ELSE notes END,
          version = version + 1
         WHERE id = $7 RETURNING *`,
        ["locationId" in input, input.locationId || null, "expiryAt" in input, input.expiryAt || null, "notes" in input, input.notes || null, request.params.id]
      );
      await writeAudit(client, { actorUserId: user.id, action: "UPDATE", entityType: "BATCH", entityId: request.params.id, beforeData: old, afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  });

  app.post<{ Params: { id: string } }>("/batches/:id/adjustments", async (request, reply) => {
    const input = parseInput(adjustmentSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const idempotencyKey = getIdempotencyKey(request.headers);
    const adjusted = await withTransaction(async (client) => {
      if (idempotencyKey) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [idempotencyKey]);
        const existing = await client.query(
          `SELECT m.id, m.batch_id AS "batchId", m.signed_quantity::text AS "signedQuantity",
                  m.before_quantity::text AS "beforeQuantity", m.after_quantity::text AS "afterQuantity",
                  m.created_at AS "createdAt"
             FROM stock_movements m
            WHERE m.idempotency_key = $1
              AND m.batch_id = $2
              AND m.type IN ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT')`,
          [idempotencyKey, request.params.id]
        );
        if (existing.rows[0]) return { ...existing.rows[0], idempotent: true };
      }
      const batchResult = await client.query<UnitRecord & { id: string; version: number; status: string; remaining_quantity: string }>(
        "SELECT * FROM batches WHERE id = $1 FOR UPDATE",
        [request.params.id]
      );
      const batch = batchResult.rows[0];
      if (!batch) throw new AppError(404, "NOT_FOUND", "批次不存在");
      if (batch.status === "ARCHIVED") throw new AppError(409, "BATCH_ARCHIVED", "已归档批次不能调整");
      const material = await client.query("SELECT id FROM materials WHERE id = $1 AND archived_at IS NULL FOR SHARE", [batch.material_id]);
      if (!material.rowCount) throw new AppError(409, "MATERIAL_ARCHIVED", "材料已归档，不能调整其批次库存");
      if (batch.version !== input.version) throw new AppError(409, "VERSION_CONFLICT", "批次已被其他操作修改，请刷新后重试");
      let quantity: string;
      try {
        quantity = convertQuantity(input.quantity, input.unit, batch.stock_unit as any);
      } catch {
        throw new AppError(422, "UNIT_INCOMPATIBLE", "调整单位与批次库存单位不兼容");
      }
      const before = batch.remaining_quantity;
      if (input.direction === "OUT" && compareQuantities(quantity, before) > 0) {
        throw new AppError(409, "INSUFFICIENT_STOCK", "批次剩余数量不足");
      }
      const signed = input.direction === "IN" ? quantity : `-${quantity}`;
      const after = input.direction === "IN" ? addQuantities(before, quantity) : subtractQuantities(before, quantity);
      const status = compareQuantities(after, "0") === 0 ? "DEPLETED" : "ACTIVE";
      await client.query("UPDATE batches SET remaining_quantity = $1, status = $2, version = version + 1 WHERE id = $3", [after, status, batch.id]);
      const movement = await client.query(
        `INSERT INTO stock_movements(batch_id, type, signed_quantity, stock_unit, before_quantity, after_quantity,
           reference_type, reason, actor_user_id, idempotency_key)
         VALUES ($1, $2, $3, $4::stock_unit, $5, $6, 'ADJUSTMENT', $7, $8, $9)
         RETURNING id, batch_id AS "batchId", signed_quantity::text AS "signedQuantity",
                   before_quantity::text AS "beforeQuantity", after_quantity::text AS "afterQuantity", created_at AS "createdAt"`,
        [batch.id, input.direction === "IN" ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT", signed, batch.stock_unit, before, after, input.reason, user.id, idempotencyKey ?? null]
      );
      await writeAudit(client, { actorUserId: user.id, action: "ADJUST", entityType: "BATCH", entityId: batch.id, beforeData: { remainingQuantity: before }, afterData: { remainingQuantity: after, reason: input.reason }, requestId: request.id });
      return { ...movement.rows[0], idempotent: false };
    });
    return reply.status(adjusted.idempotent ? 200 : 201).send({ data: adjusted });
  });

  app.get<{ Params: { id: string } }>("/batches/:id/movements", async (request) => {
    const result = await pool.query(
      `SELECT id, type, signed_quantity::text AS "signedQuantity", stock_unit AS "stockUnit",
              before_quantity::text AS "beforeQuantity", after_quantity::text AS "afterQuantity",
              reference_type AS "referenceType", reference_id AS "referenceId", reason, created_at AS "createdAt"
         FROM stock_movements WHERE batch_id = $1 ORDER BY created_at DESC`,
      [request.params.id]
    );
    return { data: result.rows };
  });

  app.post<{ Params: { id: string } }>("/batches/:id/archive", async (request) => {
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const batch = await client.query<{ remaining_quantity: string }>("SELECT remaining_quantity FROM batches WHERE id = $1 FOR UPDATE", [request.params.id]);
      if (!batch.rows[0]) throw new AppError(404, "NOT_FOUND", "批次不存在");
      if (compareQuantities(batch.rows[0].remaining_quantity, "0") > 0) throw new AppError(409, "BATCH_HAS_STOCK", "批次仍有库存，不能归档");
      const result = await client.query("UPDATE batches SET status = 'ARCHIVED', version = version + 1 WHERE id = $1 RETURNING *", [request.params.id]);
      await writeAudit(client, { actorUserId: user.id, action: "ARCHIVE", entityType: "BATCH", entityId: request.params.id, afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  });
}
