import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { convertQuantity, projectInputSchema, projectStatusSchema, requirementInputSchema } from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";

type Query = Record<string, string | undefined>;
const projectPatchSchema = projectInputSchema.partial().extend({ version: z.number().int().positive() });
const requirementPatchSchema = requirementInputSchema.partial().extend({ version: z.number().int().positive().optional() });

function dateOnly(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Query }>("/projects", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (request.query.archived === "true") {
      conditions.push("p.archived_at IS NOT NULL");
    } else if (!request.query.status) {
      conditions.push("p.archived_at IS NULL");
    }
    if (request.query.q?.trim()) {
      values.push(`%${request.query.q.trim()}%`);
      conditions.push(`(p.name ILIKE $${values.length} OR p.description ILIKE $${values.length} OR EXISTS (SELECT 1 FROM unnest(p.tags) tag WHERE tag ILIKE $${values.length}))`);
    }
    if (request.query.craftType) {
      values.push(request.query.craftType);
      conditions.push(`p.craft_type = $${values.length}::craft_type`);
    }
    if (request.query.status) {
      values.push(request.query.status);
      conditions.push(`p.status = $${values.length}::project_status`);
    }
    if (request.query.dueBefore) {
      values.push(request.query.dueBefore);
      conditions.push(`p.due_date IS NOT NULL AND p.due_date <= $${values.length}::date`);
    }
    const where = conditions.join(" AND ");
    const total = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM projects p WHERE ${where}`, values);
    values.push(pageSize, offset);
    const rows = await pool.query(
      `SELECT p.id, p.name, p.craft_type AS "craftType", p.status, p.start_date AS "startDate", p.due_date AS "dueDate",
              p.completed_at AS "completedAt", p.description, p.target_color_name AS "targetColorName",
              p.target_color_hex AS "targetColorHex", p.tags, p.archived_at AS "archivedAt",
              p.created_at AS "createdAt", p.updated_at AS "updatedAt", p.version,
              (SELECT count(*)::int FROM project_requirements r WHERE r.project_id = p.id) AS "requirementCount",
              (SELECT count(*)::int FROM consumptions c WHERE c.project_id = p.id AND c.status = 'ACTIVE') AS "consumptionCount"
         FROM projects p WHERE ${where}
         ORDER BY CASE p.status WHEN 'IN_PROGRESS' THEN 0 WHEN 'PLANNED' THEN 1 WHEN 'COMPLETED' THEN 2 ELSE 3 END,
                  p.due_date ASC NULLS LAST, p.updated_at DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.get<{ Params: { id: string } }>("/projects/:id", async (request) => {
    const project = await pool.query(
      `SELECT id, name, craft_type AS "craftType", status, start_date AS "startDate", due_date AS "dueDate",
              completed_at AS "completedAt", description, target_color_name AS "targetColorName",
              target_color_hex AS "targetColorHex", tags, archived_at AS "archivedAt",
              created_at AS "createdAt", updated_at AS "updatedAt", version
         FROM projects WHERE id = $1`,
      [request.params.id]
    );
    if (!project.rows[0]) throw new AppError(404, "NOT_FOUND", "项目不存在");
    const requirements = await pool.query(
      `SELECT r.id, r.material_id AS "materialId", m.name AS "materialName", m.stock_unit AS "materialStockUnit",
              r.required_quantity::text AS "requiredQuantity", r.stock_unit AS "stockUnit", r.purpose, r.notes,
              coalesce(sum(c.total_quantity) FILTER (WHERE c.status = 'ACTIVE'), 0)::text AS "actualQuantity",
              coalesce(sum(c.used_quantity) FILTER (WHERE c.status = 'ACTIVE'), 0)::text AS "usedQuantity",
              coalesce(sum(c.waste_quantity) FILTER (WHERE c.status = 'ACTIVE'), 0)::text AS "wasteQuantity",
              count(c.id) FILTER (WHERE c.status = 'ACTIVE')::int AS "consumptionCount",
              count(c.id)::int AS "referenceCount"
         FROM project_requirements r JOIN materials m ON m.id = r.material_id
         LEFT JOIN consumptions c ON c.project_requirement_id = r.id
        WHERE r.project_id = $1 GROUP BY r.id, m.name, m.stock_unit ORDER BY r.created_at`,
      [request.params.id]
    );
    const [consumptions, colors, attachments] = await Promise.all([
      pool.query(
        `SELECT c.id, c.batch_id AS "batchId", b.batch_code AS "batchCode", m.name AS "materialName",
                c.used_quantity::text AS "usedQuantity", c.waste_quantity::text AS "wasteQuantity",
                c.total_quantity::text AS "totalQuantity", c.stock_unit AS "stockUnit", c.consumed_at AS "consumedAt",
                c.purpose, c.notes, c.status, c.reversed_at AS "reversedAt", c.reversal_reason AS "reversalReason",
                c.project_requirement_id AS "projectRequirementId"
           FROM consumptions c JOIN batches b ON b.id = c.batch_id JOIN materials m ON m.id = b.material_id
          WHERE c.project_id = $1 ORDER BY c.consumed_at DESC`,
        [request.params.id]
      ),
      pool.query(
        `SELECT cc.id, cc.batch_id AS "batchId", b.batch_code AS "batchCode", cc.change_type AS "changeType",
                cc.before_color_name AS "beforeColorName", cc.before_color_hex AS "beforeColorHex",
                cc.after_color_name AS "afterColorName", cc.after_color_hex AS "afterColorHex",
                cc.occurred_at AS "occurredAt", cc.notes
           FROM color_changes cc JOIN batches b ON b.id = cc.batch_id
          WHERE cc.project_id = $1 ORDER BY cc.occurred_at DESC`,
        [request.params.id]
      ),
      pool.query(
        `SELECT id, original_name AS "originalName", mime_type AS "mimeType", byte_size::text AS "byteSize", created_at AS "createdAt"
           FROM attachments WHERE owner_type = 'PROJECT' AND owner_id = $1 ORDER BY created_at DESC`,
        [request.params.id]
      )
    ]);
    return { data: { ...project.rows[0], requirements: requirements.rows, consumptions: consumptions.rows, colorChanges: colors.rows, attachments: attachments.rows } };
  });

  app.post("/projects", async (request, reply) => {
    const input = parseInput(projectInputSchema, request.body);
    let effectiveStartDate = input.startDate;
    if (!effectiveStartDate && ["IN_PROGRESS", "COMPLETED"].includes(input.status ?? "PLANNED")) {
      const today = await pool.query<{ today: string }>("SELECT current_date::text AS today");
      effectiveStartDate = today.rows[0]?.today ?? null;
    }
    if (effectiveStartDate && input.dueDate && input.dueDate < effectiveStartDate) {
      throw new AppError(422, "INVALID_PROJECT_DATES", "截止日期不能早于开始日期");
    }
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO projects(name, craft_type, status, start_date, due_date, description, target_color_name,
           target_color_hex, tags, completed_at)
         VALUES ($1, $2::craft_type, $3::project_status,
                 coalesce($4::date, CASE WHEN $3 IN ('IN_PROGRESS', 'COMPLETED') THEN current_date ELSE NULL END),
                 $5::date, $6, $7, $8, $9::text[], CASE WHEN $3 = 'COMPLETED' THEN now() ELSE NULL END)
         RETURNING *`,
        [input.name, input.craftType, input.status, input.startDate || null, input.dueDate || null,
         input.description || null, input.targetColorName || null, input.targetColorHex || null, input.tags]
      );
      await writeAudit(client, { actorUserId: user.id, action: "CREATE", entityType: "PROJECT", entityId: result.rows[0]?.id, afterData: result.rows[0], requestId: request.id });
      return result.rows[0];
    });
    return reply.status(201).send({ data: created });
  });

  app.patch<{ Params: { id: string } }>("/projects/:id", async (request) => {
    const input = parseInput(projectPatchSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const before = await client.query("SELECT * FROM projects WHERE id = $1 FOR UPDATE", [request.params.id]);
      const old = before.rows[0];
      if (!old) throw new AppError(404, "NOT_FOUND", "项目不存在");
      if (input.status !== undefined && input.status !== old.status) {
        throw new AppError(422, "USE_STATUS_ENDPOINT", "项目状态变更必须使用专门的状态接口");
      }
      if (["COMPLETED", "ARCHIVED"].includes(old.status)) throw new AppError(409, "PROJECT_READ_ONLY", "已完成或已归档项目不能修改，请先重新打开");
      if (old.version !== input.version) throw new AppError(409, "VERSION_CONFLICT", "项目已被其他操作修改，请刷新后重试");
      let startDate = input.startDate !== undefined ? input.startDate : dateOnly(old.start_date);
      if (!startDate && ["IN_PROGRESS", "COMPLETED"].includes(old.status)) {
        const today = await client.query<{ today: string }>("SELECT current_date::text AS today");
        startDate = today.rows[0]?.today ?? null;
      }
      const dueDate = input.dueDate !== undefined ? input.dueDate : dateOnly(old.due_date);
      if (startDate && dueDate && dueDate < startDate) {
        throw new AppError(422, "INVALID_PROJECT_DATES", "截止日期不能早于开始日期");
      }
      const result = await client.query(
        `UPDATE projects SET
          name = coalesce($1, name), craft_type = coalesce($2::craft_type, craft_type),
          start_date = CASE WHEN $3::boolean THEN $4::date ELSE start_date END,
          due_date = CASE WHEN $5::boolean THEN $6::date ELSE due_date END,
          description = CASE WHEN $7::boolean THEN $8 ELSE description END,
          target_color_name = CASE WHEN $9::boolean THEN $10 ELSE target_color_name END,
          target_color_hex = CASE WHEN $11::boolean THEN $12 ELSE target_color_hex END,
          tags = coalesce($13::text[], tags), version = version + 1
         WHERE id = $14 RETURNING *`,
        [input.name ?? null, input.craftType ?? null, "startDate" in input, input.startDate || null,
         "dueDate" in input, input.dueDate || null, "description" in input, input.description || null,
         "targetColorName" in input, input.targetColorName || null, "targetColorHex" in input,
         input.targetColorHex || null, input.tags ?? null, request.params.id]
      );
      await writeAudit(client, { actorUserId: user.id, action: "UPDATE", entityType: "PROJECT", entityId: request.params.id, beforeData: old, afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  });

  app.post<{ Params: { id: string } }>("/projects/:id/status", async (request) => {
    const input = parseInput(projectStatusSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const before = await client.query("SELECT * FROM projects WHERE id = $1 FOR UPDATE", [request.params.id]);
      const old = before.rows[0];
      if (!old) throw new AppError(404, "NOT_FOUND", "项目不存在");
      if (old.version !== input.version) throw new AppError(409, "VERSION_CONFLICT", "项目已被其他操作修改，请刷新后重试");
      if (old.status === input.status) return { data: old };
      if (old.status === "ARCHIVED" && input.status !== "ARCHIVED") throw new AppError(409, "PROJECT_ARCHIVED", "已归档项目不能直接重新打开");
      if (input.status === "ARCHIVED" && old.status === "IN_PROGRESS") {
        throw new AppError(409, "PROJECT_IN_PROGRESS", "进行中的项目不能归档");
      }
      if (["IN_PROGRESS", "COMPLETED"].includes(input.status)) {
        const startDate = dateOnly(old.start_date);
        if (!startDate) {
          const today = await client.query<{ today: string }>("SELECT current_date::text AS today");
          const dueDate = dateOnly(old.due_date);
          if (dueDate && dueDate < (today.rows[0]?.today ?? dueDate)) {
            throw new AppError(422, "INVALID_PROJECT_DATES", "请先调整截止日期，再开始或完成项目");
          }
        }
      }
      const result = await client.query(
        `UPDATE projects SET status = $1::project_status,
          start_date = CASE WHEN $1 IN ('IN_PROGRESS', 'COMPLETED') THEN coalesce(start_date, current_date) ELSE start_date END,
          completed_at = CASE WHEN $1 = 'COMPLETED' THEN now() WHEN $1 IN ('PLANNED', 'IN_PROGRESS') THEN NULL ELSE completed_at END,
          archived_at = CASE WHEN $1 = 'ARCHIVED' THEN now() ELSE archived_at END,
          version = version + 1
         WHERE id = $2 RETURNING *`,
        [input.status, request.params.id]
      );
      await writeAudit(client, { actorUserId: user.id, action: "STATUS", entityType: "PROJECT", entityId: request.params.id, beforeData: old, afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  });

  app.post<{ Params: { id: string } }>("/projects/:id/archive", async (request) => {
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const before = await client.query("SELECT * FROM projects WHERE id = $1 FOR UPDATE", [request.params.id]);
      if (!before.rows[0]) throw new AppError(404, "NOT_FOUND", "项目不存在");
      if (before.rows[0].status === "ARCHIVED") return { data: before.rows[0] };
      if (before.rows[0].status === "IN_PROGRESS") throw new AppError(409, "PROJECT_IN_PROGRESS", "进行中的项目不能归档");
      const result = await client.query("UPDATE projects SET status = 'ARCHIVED', archived_at = now(), version = version + 1 WHERE id = $1 RETURNING *", [request.params.id]);
      await writeAudit(client, { actorUserId: user.id, action: "ARCHIVE", entityType: "PROJECT", entityId: request.params.id, afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  });

  app.post<{ Params: { id: string } }>("/projects/:id/requirements", async (request, reply) => {
    const input = parseInput(requirementInputSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      const project = await client.query("SELECT id, status FROM projects WHERE id = $1 FOR SHARE", [request.params.id]);
      if (!project.rows[0]) throw new AppError(404, "NOT_FOUND", "项目不存在");
      if (["COMPLETED", "ARCHIVED"].includes(project.rows[0].status)) throw new AppError(409, "PROJECT_READ_ONLY", "已完成或已归档项目不能新增材料需求");
      const material = await client.query<{ id: string; stock_unit: string; archived_at: string | null }>("SELECT id, stock_unit, archived_at FROM materials WHERE id = $1 FOR SHARE", [input.materialId]);
      if (!material.rows[0] || material.rows[0].archived_at) throw new AppError(422, "INVALID_MATERIAL", "材料不存在或已归档");
      let quantity: string;
      try {
        quantity = convertQuantity(input.requiredQuantity, input.unit, material.rows[0].stock_unit as any);
      } catch {
        throw new AppError(422, "UNIT_INCOMPATIBLE", "需求单位与材料库存单位不兼容");
      }
      const result = await client.query(
        `INSERT INTO project_requirements(project_id, material_id, required_quantity, stock_unit, purpose, notes)
         VALUES ($1, $2, $3, $4::stock_unit, $5, $6) RETURNING *`,
        [request.params.id, input.materialId, quantity, material.rows[0].stock_unit, input.purpose || null, input.notes || null]
      );
      await writeAudit(client, { actorUserId: user.id, action: "CREATE", entityType: "PROJECT_REQUIREMENT", entityId: result.rows[0]?.id, afterData: result.rows[0], requestId: request.id });
      return result.rows[0];
    });
    return reply.status(201).send({ data: created });
  });

  app.patch<{ Params: { id: string; requirementId: string } }>("/projects/:id/requirements/:requirementId", async (request) => {
    const input = parseInput(requirementPatchSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const project = await client.query<{ status: string }>("SELECT status FROM projects WHERE id = $1 FOR SHARE", [request.params.id]);
      if (!project.rows[0]) throw new AppError(404, "NOT_FOUND", "项目不存在");
      if (["COMPLETED", "ARCHIVED"].includes(project.rows[0].status)) {
        throw new AppError(409, "PROJECT_READ_ONLY", "已完成或已归档项目不能修改材料需求");
      }

      const before = await client.query("SELECT * FROM project_requirements WHERE id = $1 AND project_id = $2 FOR UPDATE", [request.params.requirementId, request.params.id]);
      const old = before.rows[0];
      if (!old) throw new AppError(404, "NOT_FOUND", "材料需求不存在");
      const materialId = input.materialId ?? old.material_id;
      const materialChanged = materialId !== old.material_id;
      if (materialChanged) {
        const used = await client.query("SELECT 1 FROM consumptions WHERE project_requirement_id = $1 LIMIT 1", [request.params.requirementId]);
        if (used.rowCount) throw new AppError(409, "REQUIREMENT_IN_USE", "已有消耗记录的需求不能更换材料");
      }

      const material = await client.query<{ stock_unit: string; archived_at: string | null }>("SELECT stock_unit, archived_at FROM materials WHERE id = $1 FOR SHARE", [materialId]);
      if (!material.rows[0] || material.rows[0].archived_at) throw new AppError(422, "INVALID_MATERIAL", "材料不存在或已归档");

      let requiredQuantity = old.required_quantity as string;
      if (input.requiredQuantity !== undefined) {
        const sourceUnit = input.unit ?? material.rows[0].stock_unit;
        try {
          requiredQuantity = convertQuantity(input.requiredQuantity, sourceUnit as any, material.rows[0].stock_unit as any);
        } catch {
          throw new AppError(422, "UNIT_INCOMPATIBLE", "需求单位与材料库存单位不兼容");
        }
      } else if (materialChanged) {
        try {
          requiredQuantity = convertQuantity(old.required_quantity as string, old.stock_unit as any, material.rows[0].stock_unit as any);
        } catch {
          throw new AppError(422, "UNIT_INCOMPATIBLE", "更换材料时原计划数量无法换算，请同时提供新的数量和单位");
        }
      }

      const result = await client.query(
        `UPDATE project_requirements SET material_id = $1, required_quantity = $2, stock_unit = $3::stock_unit,
          purpose = CASE WHEN $4::boolean THEN $5 ELSE purpose END,
          notes = CASE WHEN $6::boolean THEN $7 ELSE notes END
         WHERE id = $8 RETURNING *`,
        [materialId, requiredQuantity, material.rows[0].stock_unit, "purpose" in input, input.purpose || null, "notes" in input, input.notes || null, request.params.requirementId]
      );
      await writeAudit(client, { actorUserId: user.id, action: "UPDATE", entityType: "PROJECT_REQUIREMENT", entityId: request.params.requirementId, beforeData: old, afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  });

  app.delete<{ Params: { id: string; requirementId: string } }>("/projects/:id/requirements/:requirementId", async (request, reply) => {
    const user = (request as AuthenticatedRequest).authUser;
    await withTransaction(async (client) => {
      const project = await client.query<{ status: string }>("SELECT status FROM projects WHERE id = $1 FOR SHARE", [request.params.id]);
      if (!project.rows[0]) throw new AppError(404, "NOT_FOUND", "项目不存在");
      if (["COMPLETED", "ARCHIVED"].includes(project.rows[0].status)) {
        throw new AppError(409, "PROJECT_READ_ONLY", "已完成或已归档项目不能删除材料需求");
      }
      const requirement = await client.query(
        "SELECT id FROM project_requirements WHERE id = $1 AND project_id = $2 FOR UPDATE",
        [request.params.requirementId, request.params.id]
      );
      if (!requirement.rowCount) throw new AppError(404, "NOT_FOUND", "材料需求不存在");
      const used = await client.query("SELECT 1 FROM consumptions WHERE project_requirement_id = $1 LIMIT 1", [request.params.requirementId]);
      if (used.rowCount) throw new AppError(409, "REQUIREMENT_IN_USE", "该需求已有消耗记录，不能删除");
      const result = await client.query("DELETE FROM project_requirements WHERE id = $1 AND project_id = $2 RETURNING *", [request.params.requirementId, request.params.id]);
      await writeAudit(client, { actorUserId: user.id, action: "DELETE", entityType: "PROJECT_REQUIREMENT", entityId: request.params.requirementId, beforeData: result.rows[0], requestId: request.id });
    });
    return reply.status(204).send();
  });
}
