import type { FastifyInstance } from "fastify";
import { addQuantities, compareQuantities, consumptionInputSchema, convertQuantity, reverseConsumptionSchema, subtractQuantities } from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";
import { getIdempotencyKey } from "../lib/idempotency.js";

type Query = Record<string, string | undefined>;

export async function consumptionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Query }>("/consumptions", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions = ["1 = 1"];
    const filters = [
      ["projectId", "c.project_id"],
      ["materialId", "m.id"],
      ["batchId", "c.batch_id"],
      ["sourceId", "b.source_id"]
    ] as const;
    for (const [key, column] of filters) {
      if (request.query[key]) {
        values.push(request.query[key]);
        conditions.push(`${column} = $${values.length}::uuid`);
      }
    }
    if (request.query.status) {
      values.push(request.query.status);
      conditions.push(`c.status = $${values.length}::consumption_status`);
    }
    if (request.query.from) {
      values.push(request.query.from);
      conditions.push(`c.consumed_at >= $${values.length}::timestamptz`);
    }
    if (request.query.to) {
      values.push(request.query.to);
      conditions.push(`c.consumed_at <= $${values.length}::timestamptz`);
    }
    if (request.query.q?.trim()) {
      values.push(`%${request.query.q.trim()}%`);
      conditions.push(`(p.name ILIKE $${values.length} OR m.name ILIKE $${values.length} OR b.batch_code ILIKE $${values.length} OR c.purpose ILIKE $${values.length} OR c.notes ILIKE $${values.length})`);
    }
    const where = conditions.join(" AND ");
    const base = `FROM consumptions c
      JOIN projects p ON p.id = c.project_id
      JOIN batches b ON b.id = c.batch_id
      JOIN materials m ON m.id = b.material_id
      LEFT JOIN sources s ON s.id = b.source_id
      WHERE ${where}`;
    const total = await pool.query<{ count: string }>(`SELECT count(*)::text AS count ${base}`, values);
    values.push(pageSize, offset);
    const rows = await pool.query(
      `SELECT c.id, c.project_id AS "projectId", p.name AS "projectName", c.project_requirement_id AS "projectRequirementId",
              c.batch_id AS "batchId", b.batch_code AS "batchCode", m.id AS "materialId", m.name AS "materialName",
              s.name AS "sourceName", c.used_quantity::text AS "usedQuantity", c.waste_quantity::text AS "wasteQuantity",
              c.total_quantity::text AS "totalQuantity", c.stock_unit AS "stockUnit", c.consumed_at AS "consumedAt",
              c.purpose, c.notes, c.status, c.reversed_at AS "reversedAt", c.reversal_reason AS "reversalReason",
              c.created_at AS "createdAt"
         ${base} ORDER BY c.consumed_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.get<{ Params: { id: string } }>("/consumptions/:id", async (request) => {
    const result = await pool.query(
      `SELECT c.id, c.project_id AS "projectId", p.name AS "projectName", c.project_requirement_id AS "projectRequirementId",
              c.batch_id AS "batchId", b.batch_code AS "batchCode", m.id AS "materialId", m.name AS "materialName",
              c.used_quantity::text AS "usedQuantity", c.waste_quantity::text AS "wasteQuantity",
              c.total_quantity::text AS "totalQuantity", c.stock_unit AS "stockUnit", c.consumed_at AS "consumedAt",
              c.purpose, c.notes, c.status, c.reversed_at AS "reversedAt", c.reversal_reason AS "reversalReason",
              c.created_at AS "createdAt", (SELECT count(*)::int FROM attachments a WHERE a.owner_type = 'CONSUMPTION' AND a.owner_id = c.id) AS "attachmentCount"
         FROM consumptions c JOIN projects p ON p.id = c.project_id JOIN batches b ON b.id = c.batch_id
         JOIN materials m ON m.id = b.material_id WHERE c.id = $1`,
      [request.params.id]
    );
    if (!result.rows[0]) throw new AppError(404, "NOT_FOUND", "消耗记录不存在");
    return { data: result.rows[0] };
  });

  app.post("/consumptions", async (request, reply) => {
    const input = parseInput(consumptionInputSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const key = getIdempotencyKey(request.headers);
    const created = await withTransaction(async (client) => {
      if (key) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
        const existing = await client.query(
          `SELECT c.id, c.project_id AS "projectId", c.project_requirement_id AS "projectRequirementId",
                  c.batch_id AS "batchId", c.used_quantity::text AS "usedQuantity", c.waste_quantity::text AS "wasteQuantity",
                  c.total_quantity::text AS "totalQuantity", c.stock_unit AS "stockUnit", c.consumed_at AS "consumedAt",
                  c.status, c.created_at AS "createdAt"
             FROM consumptions c JOIN stock_movements m ON m.reference_type = 'CONSUMPTION' AND m.reference_id = c.id
            WHERE m.idempotency_key = $1 LIMIT 1`,
          [key]
        );
        if (existing.rows[0]) return { ...existing.rows[0], idempotent: true };
      }

      const project = await client.query<{ id: string; name: string; status: string; version: number; start_date: string | null; due_date: string | null }>(
        "SELECT id, name, status, version, start_date, due_date FROM projects WHERE id = $1 FOR UPDATE",
        [input.projectId]
      );
      if (!project.rows[0]) throw new AppError(422, "INVALID_PROJECT", "项目不存在");
      if (["COMPLETED", "ARCHIVED"].includes(project.rows[0].status)) {
        throw new AppError(409, "PROJECT_READ_ONLY", "已完成或已归档项目不能继续消耗材料");
      }
      let autoStartedProject = false;
      if (project.rows[0].status === "PLANNED") {
        if (!project.rows[0].start_date && project.rows[0].due_date) {
          const today = await client.query<{ today: string }>("SELECT current_date::text AS today");
          if (project.rows[0].due_date < (today.rows[0]?.today ?? project.rows[0].due_date)) {
            throw new AppError(422, "INVALID_PROJECT_DATES", "项目截止日期已过，请先调整截止日期");
          }
        }
        const started = await client.query(
          `UPDATE projects SET status = 'IN_PROGRESS', start_date = coalesce(start_date, current_date),
             version = version + 1 WHERE id = $1 RETURNING *`,
          [input.projectId]
        );
        autoStartedProject = true;
        await writeAudit(client, {
          actorUserId: user.id,
          action: "AUTO_START",
          entityType: "PROJECT",
          entityId: input.projectId,
          beforeData: project.rows[0],
          afterData: started.rows[0],
          requestId: request.id
        });
      }

      const batchResult = await client.query<{
        id: string;
        material_id: string;
        material_name: string;
        remaining_quantity: string;
        stock_unit: string;
        status: string;
      }>(
        `SELECT b.id, b.material_id, m.name AS material_name, b.remaining_quantity, b.stock_unit, b.status
           FROM batches b JOIN materials m ON m.id = b.material_id
          WHERE b.id = $1 FOR UPDATE OF b`,
        [input.batchId]
      );
      const batch = batchResult.rows[0];
      if (!batch) throw new AppError(422, "INVALID_BATCH", "批次不存在");
      if (batch.status === "ARCHIVED") throw new AppError(409, "BATCH_ARCHIVED", "已归档批次不能消耗");
      const material = await client.query("SELECT id FROM materials WHERE id = $1 AND archived_at IS NULL FOR SHARE", [batch.material_id]);
      if (!material.rowCount) throw new AppError(409, "MATERIAL_ARCHIVED", "材料已归档，不能继续消耗");

      let usedQuantity: string;
      let wasteQuantity: string;
      try {
        usedQuantity = convertQuantity(input.usedQuantity, input.unit, batch.stock_unit as any);
        wasteQuantity = convertQuantity(input.wasteQuantity, input.unit, batch.stock_unit as any);
      } catch {
        throw new AppError(422, "UNIT_INCOMPATIBLE", "消耗单位与批次库存单位不兼容");
      }
      const totalQuantity = addQuantities(usedQuantity, wasteQuantity);
      if (compareQuantities(totalQuantity, "0") <= 0) throw new AppError(422, "INVALID_QUANTITY", "消耗总量必须大于 0");

      if (input.projectRequirementId) {
        const requirement = await client.query(
          "SELECT id FROM project_requirements WHERE id = $1 AND project_id = $2 AND material_id = $3 FOR SHARE",
          [input.projectRequirementId, input.projectId, batch.material_id]
        );
        if (!requirement.rowCount) throw new AppError(422, "INVALID_REQUIREMENT", "材料需求与项目或材料不匹配");
      }

      const before = batch.remaining_quantity;
      if (compareQuantities(totalQuantity, before) > 0) throw new AppError(409, "INSUFFICIENT_STOCK", "批次剩余数量不足");
      const after = subtractQuantities(before, totalQuantity);
      const consumption = await client.query(
        `INSERT INTO consumptions(project_id, project_requirement_id, batch_id, used_quantity, waste_quantity,
           total_quantity, stock_unit, consumed_at, purpose, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7::stock_unit, coalesce($8::timestamptz, now()), $9, $10)
         RETURNING id, project_id AS "projectId", project_requirement_id AS "projectRequirementId",
                   batch_id AS "batchId", used_quantity::text AS "usedQuantity", waste_quantity::text AS "wasteQuantity",
                   total_quantity::text AS "totalQuantity", stock_unit AS "stockUnit", consumed_at AS "consumedAt",
                   purpose, notes, status, created_at AS "createdAt"`,
        [input.projectId, input.projectRequirementId || null, input.batchId, usedQuantity, wasteQuantity,
         totalQuantity, batch.stock_unit, input.consumedAt || null, input.purpose || null, input.notes || null]
      );
      const consumptionId = consumption.rows[0]?.id;
      await client.query(
        `INSERT INTO stock_movements(batch_id, type, signed_quantity, stock_unit, before_quantity, after_quantity,
           reference_type, reference_id, actor_user_id, idempotency_key)
         VALUES ($1, 'CONSUMPTION', $2, $3::stock_unit, $4, $5, 'CONSUMPTION', $6, $7, $8)`,
        [batch.id, `-${totalQuantity}`, batch.stock_unit, before, after, consumptionId, user.id, key ?? null]
      );
      await client.query(
        "UPDATE batches SET remaining_quantity = $1, status = $2, version = version + 1 WHERE id = $3",
        [after, compareQuantities(after, "0") === 0 ? "DEPLETED" : "ACTIVE", batch.id]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "CONSUME", entityType: "CONSUMPTION", entityId: consumptionId,
        afterData: { ...consumption.rows[0], beforeQuantity: before, afterQuantity: after, autoStartedProject },
        requestId: request.id
      });
      return { ...consumption.rows[0], idempotent: false };
    });
    return reply.status(created.idempotent ? 200 : 201).send({ data: created });
  });

  app.post<{ Params: { id: string } }>("/consumptions/:id/reverse", async (request) => {
    const input = parseInput(reverseConsumptionSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const reversed = await withTransaction(async (client) => {
      const result = await client.query<{
        id: string;
        batch_id: string;
        material_id: string;
        total_quantity: string;
        stock_unit: string;
        status: string;
        remaining_quantity: string;
      }>(
        `SELECT c.id, c.batch_id, b.material_id, c.total_quantity, c.stock_unit, c.status,
                b.remaining_quantity, b.status AS batch_status
           FROM consumptions c JOIN batches b ON b.id = c.batch_id
          WHERE c.id = $1 FOR UPDATE OF c, b`,
        [request.params.id]
      );
      const consumption = result.rows[0];
      if (!consumption) throw new AppError(404, "NOT_FOUND", "消耗记录不存在");
      if (consumption.status !== "ACTIVE") throw new AppError(409, "ALREADY_REVERSED", "该消耗已经撤销");
      const material = await client.query("SELECT id FROM materials WHERE id = $1 AND archived_at IS NULL FOR SHARE", [consumption.material_id]);
      if (!material.rowCount) throw new AppError(409, "MATERIAL_ARCHIVED", "材料已归档，不能撤销消耗恢复库存");
      const before = consumption.remaining_quantity;
      const after = addQuantities(before, consumption.total_quantity);
      await client.query(
        `INSERT INTO stock_movements(batch_id, type, signed_quantity, stock_unit, before_quantity, after_quantity,
           reference_type, reference_id, reason, actor_user_id)
         VALUES ($1, 'REVERSAL', $2, $3::stock_unit, $4, $5, 'CONSUMPTION_REVERSAL', $6, $7, $8)`,
        [consumption.batch_id, consumption.total_quantity, consumption.stock_unit, before, after, consumption.id, input.reason, user.id]
      );
      await client.query(
        "UPDATE batches SET remaining_quantity = $1, status = 'ACTIVE', version = version + 1 WHERE id = $2",
        [after, consumption.batch_id]
      );
      const updated = await client.query(
        `UPDATE consumptions SET status = 'REVERSED', reversed_at = now(), reversal_reason = $1
          WHERE id = $2
          RETURNING id, status, reversed_at AS "reversedAt", reversal_reason AS "reversalReason"`,
        [input.reason, consumption.id]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "REVERSE", entityType: "CONSUMPTION", entityId: consumption.id,
        beforeData: { status: "ACTIVE", remainingQuantity: before },
        afterData: { status: "REVERSED", remainingQuantity: after, reason: input.reason },
        requestId: request.id
      });
      return updated.rows[0];
    });
    return { data: reversed };
  });
}
