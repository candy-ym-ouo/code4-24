import type { FastifyInstance } from "fastify";
import { colorChangeInputSchema, colorChangePatchSchema, convertQuantity } from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";

type Query = Record<string, string | undefined>;

export async function colorChangeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Query }>("/color-changes", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions = ["1 = 1"];
    for (const [key, column] of [["batchId", "cc.batch_id"], ["projectId", "cc.project_id"], ["consumptionId", "cc.consumption_id"]] as const) {
      if (request.query[key]) {
        values.push(request.query[key]);
        conditions.push(`${column} = $${values.length}::uuid`);
      }
    }
    if (request.query.type) {
      values.push(request.query.type);
      conditions.push(`cc.change_type = $${values.length}::color_change_type`);
    }
    if (request.query.color?.trim()) {
      values.push(`%${request.query.color.trim()}%`);
      conditions.push(`(cc.before_color_name ILIKE $${values.length} OR cc.after_color_name ILIKE $${values.length} OR cc.before_color_hex ILIKE $${values.length} OR cc.after_color_hex ILIKE $${values.length})`);
    }
    const where = conditions.join(" AND ");
    const base = `FROM color_changes cc JOIN batches b ON b.id = cc.batch_id JOIN materials m ON m.id = b.material_id
      LEFT JOIN projects p ON p.id = cc.project_id WHERE ${where}`;
    const total = await pool.query<{ count: string }>(`SELECT count(*)::text AS count ${base}`, values);
    values.push(pageSize, offset);
    const rows = await pool.query(
      `SELECT cc.id, cc.batch_id AS "batchId", b.batch_code AS "batchCode", m.name AS "materialName",
              cc.project_id AS "projectId", p.name AS "projectName", cc.consumption_id AS "consumptionId",
              cc.change_type AS "changeType", cc.before_color_name AS "beforeColorName", cc.before_color_hex AS "beforeColorHex",
              cc.after_color_name AS "afterColorName", cc.after_color_hex AS "afterColorHex",
              cc.affected_quantity::text AS "affectedQuantity", cc.stock_unit AS "stockUnit",
              cc.temperature_c::text AS "temperatureC", cc.humidity_percent::text AS "humidityPercent",
              cc.ph_value::text AS "phValue", cc.environment_notes AS "environmentNotes", cc.occurred_at AS "occurredAt",
              cc.notes, cc.created_at AS "createdAt"
         ${base} ORDER BY cc.occurred_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.get<{ Params: { id: string } }>("/color-changes/:id", async (request) => {
    const result = await pool.query(
      `SELECT cc.*, b.batch_code AS "batchCode", m.name AS "materialName"
         FROM color_changes cc JOIN batches b ON b.id = cc.batch_id JOIN materials m ON m.id = b.material_id
        WHERE cc.id = $1`,
      [request.params.id]
    );
    if (!result.rows[0]) throw new AppError(404, "NOT_FOUND", "颜色变化记录不存在");
    const attachments = await pool.query(
      `SELECT id, original_name AS "originalName", mime_type AS "mimeType", byte_size::text AS "byteSize", created_at AS "createdAt"
         FROM attachments WHERE owner_type = 'COLOR_CHANGE' AND owner_id = $1 ORDER BY created_at DESC`,
      [request.params.id]
    );
    return { data: { ...result.rows[0], attachments: attachments.rows } };
  });

  app.post("/color-changes", async (request, reply) => {
    const input = parseInput(colorChangeInputSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      const batchResult = await client.query<{
        id: string;
        stock_unit: string;
        initial_color_name: string | null;
        initial_color_hex: string | null;
        current_color_name: string | null;
        current_color_hex: string | null;
        status: string;
        material_id: string;
      }>(
        `SELECT b.id, b.material_id, b.stock_unit, b.initial_color_name, b.initial_color_hex,
                b.current_color_name, b.current_color_hex, b.status
           FROM batches b WHERE b.id = $1 FOR UPDATE OF b`,
        [input.batchId]
      );
      const batch = batchResult.rows[0];
      if (!batch) throw new AppError(422, "INVALID_BATCH", "批次不存在");
      if (batch.status === "ARCHIVED") throw new AppError(409, "BATCH_ARCHIVED", "已归档批次不能记录颜色变化");
      const material = await client.query("SELECT id FROM materials WHERE id = $1 AND archived_at IS NULL FOR SHARE", [batch.material_id]);
      if (!material.rowCount) throw new AppError(409, "MATERIAL_ARCHIVED", "材料已归档，不能记录颜色变化");

      let projectId = input.projectId || null;
      if (input.consumptionId) {
        const consumption = await client.query<{ id: string; project_id: string; batch_id: string }>(
          "SELECT id, project_id, batch_id FROM consumptions WHERE id = $1",
          [input.consumptionId]
        );
        const row = consumption.rows[0];
        if (!row || row.batch_id !== input.batchId) throw new AppError(422, "INVALID_CONSUMPTION", "消耗记录与批次不匹配");
        if (input.projectId && input.projectId !== row.project_id) {
          throw new AppError(422, "INVALID_CONSUMPTION", "消耗记录与项目不匹配");
        }
        projectId = input.projectId || row.project_id;
      }
      if (projectId) {
        const project = await client.query<{ id: string; status: string }>("SELECT id, status FROM projects WHERE id = $1 FOR SHARE", [projectId]);
        if (!project.rows[0]) throw new AppError(422, "INVALID_PROJECT", "项目不存在");
        if (project.rows[0].status === "ARCHIVED") throw new AppError(409, "PROJECT_ARCHIVED", "已归档项目不能新增颜色变化");
      }

      let affectedQuantity: string | null = null;
      if (input.affectedQuantity !== undefined && input.affectedQuantity !== null) {
        if (!input.unit) throw new AppError(422, "UNIT_REQUIRED", "记录影响数量时必须提供单位");
        try {
          affectedQuantity = convertQuantity(input.affectedQuantity, input.unit, batch.stock_unit as any);
        } catch {
          throw new AppError(422, "UNIT_INCOMPATIBLE", "影响数量单位与批次库存单位不兼容");
        }
      }

      const previousColor = await client.query<{ after_color_name: string | null; after_color_hex: string | null }>(
        `SELECT after_color_name, after_color_hex
           FROM color_changes
          WHERE batch_id = $1 AND occurred_at <= $2::timestamptz
          ORDER BY occurred_at DESC, created_at DESC
          LIMIT 1`,
        [input.batchId, input.occurredAt]
      );
      const beforeColorName = input.beforeColorName || previousColor.rows[0]?.after_color_name || batch.initial_color_name;
      const beforeColorHex = input.beforeColorHex || previousColor.rows[0]?.after_color_hex || batch.initial_color_hex;

      const latest = await client.query<{ occurred_at: Date }>(
        `SELECT occurred_at FROM color_changes
          WHERE batch_id = $1 ORDER BY occurred_at DESC, created_at DESC LIMIT 1`,
        [input.batchId]
      );
      const occurredAt = new Date(input.occurredAt);
      const isCurrent = !latest.rows[0] || occurredAt.getTime() >= new Date(latest.rows[0].occurred_at).getTime();

      const result = await client.query(
        `INSERT INTO color_changes(batch_id, project_id, consumption_id, change_type,
           before_color_name, before_color_hex, after_color_name, after_color_hex,
           affected_quantity, stock_unit, temperature_c, humidity_percent, ph_value,
           environment_notes, occurred_at, notes)
         VALUES ($1, $2, $3, $4::color_change_type, $5, $6, $7, $8, $9, $10::stock_unit,
                 $11, $12, $13, $14, $15::timestamptz, $16)
         RETURNING id, batch_id AS "batchId", project_id AS "projectId", consumption_id AS "consumptionId",
                   change_type AS "changeType", before_color_name AS "beforeColorName",
                   before_color_hex AS "beforeColorHex", after_color_name AS "afterColorName",
                   after_color_hex AS "afterColorHex", affected_quantity::text AS "affectedQuantity",
                   stock_unit AS "stockUnit", occurred_at AS "occurredAt", notes, created_at AS "createdAt"`,
        [input.batchId, projectId, input.consumptionId || null, input.changeType,
         beforeColorName, beforeColorHex, input.afterColorName, input.afterColorHex || null,
         affectedQuantity, affectedQuantity ? batch.stock_unit : null,
         input.temperatureC ?? null, input.humidityPercent ?? null, input.phValue ?? null,
         input.environmentNotes || null, input.occurredAt, input.notes || null]
      );

      if (isCurrent) {
        await client.query(
          `UPDATE batches SET current_color_name = $1, current_color_hex = $2,
             color_updated_at = $3::timestamptz, version = version + 1 WHERE id = $4`,
          [input.afterColorName, input.afterColorHex || null, input.occurredAt, input.batchId]
        );
      }

      await writeAudit(client, {
        actorUserId: user.id, action: "COLOR_CHANGE", entityType: "COLOR_CHANGE", entityId: result.rows[0]?.id,
        afterData: { ...result.rows[0], isCurrent }, requestId: request.id
      });
      return { ...result.rows[0], isCurrent };
    });
    return reply.status(201).send({ data: created });
  });

  app.patch<{ Params: { id: string } }>("/color-changes/:id", async (request) => {
    const patch = parseInput(colorChangePatchSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const before = await client.query("SELECT * FROM color_changes WHERE id = $1 FOR UPDATE", [request.params.id]);
      if (!before.rows[0]) throw new AppError(404, "NOT_FOUND", "颜色变化记录不存在");
      const notes = "notes" in patch ? patch.notes : null;
      const environmentNotes = "environmentNotes" in patch ? patch.environmentNotes : null;
      const result = await client.query(
        `UPDATE color_changes SET
          notes = CASE WHEN $1::boolean THEN $2 ELSE notes END,
          environment_notes = CASE WHEN $3::boolean THEN $4 ELSE environment_notes END
         WHERE id = $5 RETURNING *`,
        ["notes" in patch, notes || null, "environmentNotes" in patch, environmentNotes || null, request.params.id]
      );
      await writeAudit(client, { actorUserId: user.id, action: "UPDATE", entityType: "COLOR_CHANGE", entityId: request.params.id, beforeData: before.rows[0], afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  });

  app.delete<{ Params: { id: string } }>("/color-changes/:id", async (request, reply) => {
    const user = (request as AuthenticatedRequest).authUser;
    await withTransaction(async (client) => {
      const lookup = await client.query<{ batch_id: string }>("SELECT batch_id FROM color_changes WHERE id = $1", [request.params.id]);
      if (!lookup.rows[0]) throw new AppError(404, "NOT_FOUND", "颜色变化记录不存在");
      await client.query("SELECT id FROM batches WHERE id = $1 FOR UPDATE", [lookup.rows[0].batch_id]);
      const current = await client.query("SELECT * FROM color_changes WHERE id = $1 FOR UPDATE", [request.params.id]);
      if (!current.rows[0]) throw new AppError(404, "NOT_FOUND", "颜色变化记录不存在");
      const used = await client.query("SELECT 1 FROM attachments WHERE owner_type = 'COLOR_CHANGE' AND owner_id = $1 LIMIT 1", [request.params.id]);
      if (used.rowCount) throw new AppError(409, "COLOR_CHANGE_HAS_ATTACHMENTS", "请先删除该记录的照片");
      const latest = await client.query("SELECT id FROM color_changes WHERE batch_id = $1 ORDER BY occurred_at DESC, created_at DESC LIMIT 1", [current.rows[0].batch_id]);
      if (latest.rows[0]?.id !== request.params.id) throw new AppError(409, "NOT_LATEST_COLOR_CHANGE", "只能删除批次最新一条误录颜色记录");
      await client.query("DELETE FROM color_changes WHERE id = $1", [request.params.id]);
      const previous = await client.query(
        `SELECT after_color_name, after_color_hex, occurred_at FROM color_changes
          WHERE batch_id = $1 ORDER BY occurred_at DESC, created_at DESC LIMIT 1`,
        [current.rows[0].batch_id]
      );
      const material = await client.query(
        `SELECT m.default_color_name, m.default_color_hex, b.created_at
           FROM batches b JOIN materials m ON m.id = b.material_id WHERE b.id = $1`,
        [current.rows[0].batch_id]
      );
      const nextColorName = previous.rows[0]?.after_color_name ?? material.rows[0]?.default_color_name ?? null;
      const nextColorHex = previous.rows[0]?.after_color_hex ?? material.rows[0]?.default_color_hex ?? null;
      const nextColorUpdatedAt = previous.rows[0]?.occurred_at ?? material.rows[0]?.created_at ?? new Date();
      await client.query(
        `UPDATE batches SET current_color_name = $1, current_color_hex = $2,
           color_updated_at = $3::timestamptz, version = version + 1 WHERE id = $4`,
        [nextColorName, nextColorHex, nextColorUpdatedAt, current.rows[0].batch_id]
      );
      await writeAudit(client, { actorUserId: user.id, action: "DELETE", entityType: "COLOR_CHANGE", entityId: request.params.id, beforeData: current.rows[0], requestId: request.id });
    });
    return reply.status(204).send();
  });
}
