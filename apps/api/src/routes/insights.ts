import type { FastifyInstance } from "fastify";
import { pool } from "../lib/db.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";

type Query = Record<string, string | undefined>;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = Array.isArray(value) ? value.join("|") : String(value);
  if (typeof value === "string" && /^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0] ?? {});
  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
  ].join("\n");
}

export async function insightRoutes(app: FastifyInstance): Promise<void> {
  app.get("/dashboard", async () => {
    const [summary, lowStock, expiring, movements, projects] = await Promise.all([
      pool.query(
        `SELECT
          (SELECT count(*)::int FROM materials WHERE archived_at IS NULL) AS "materialCount",
          (SELECT count(*)::int FROM batches WHERE status = 'ACTIVE' AND remaining_quantity > 0) AS "activeBatchCount",
          (SELECT count(*)::int FROM batches WHERE status = 'DEPLETED') AS "depletedBatchCount",
          (SELECT count(*)::int FROM projects WHERE status = 'IN_PROGRESS' AND archived_at IS NULL) AS "activeProjectCount",
          (SELECT count(*)::int FROM consumptions WHERE status = 'ACTIVE' AND consumed_at >= date_trunc('month', now())) AS "consumptionCountThisMonth"`
      ),
      pool.query(
        `SELECT m.id, m.name, m.stock_unit AS "stockUnit", m.low_stock_threshold::text AS "lowStockThreshold",
                coalesce(sum(b.remaining_quantity) FILTER (WHERE b.status <> 'ARCHIVED'), 0)::text AS "remainingQuantity"
           FROM materials m LEFT JOIN batches b ON b.material_id = m.id
          WHERE m.archived_at IS NULL AND m.low_stock_threshold IS NOT NULL
          GROUP BY m.id HAVING coalesce(sum(b.remaining_quantity) FILTER (WHERE b.status <> 'ARCHIVED'), 0) <= m.low_stock_threshold
          ORDER BY (coalesce(sum(b.remaining_quantity) FILTER (WHERE b.status <> 'ARCHIVED'), 0) / nullif(m.low_stock_threshold, 0)) ASC NULLS LAST
          LIMIT 20`
      ),
      pool.query(
        `SELECT b.id, b.batch_code AS "batchCode", m.name AS "materialName", b.expiry_at AS "expiryAt",
                b.remaining_quantity::text AS "remainingQuantity", b.stock_unit AS "stockUnit",
                (b.expiry_at - current_date) AS "daysRemaining"
           FROM batches b JOIN materials m ON m.id = b.material_id
          WHERE b.status = 'ACTIVE' AND b.remaining_quantity > 0 AND b.expiry_at IS NOT NULL
            AND b.expiry_at <= current_date + 30
          ORDER BY b.expiry_at ASC LIMIT 20`
      ),
      pool.query(
        `SELECT sm.id, sm.type, sm.signed_quantity::text AS "signedQuantity", sm.stock_unit AS "stockUnit",
                sm.after_quantity::text AS "afterQuantity", sm.created_at AS "createdAt",
                b.id AS "batchId", b.batch_code AS "batchCode", m.name AS "materialName"
           FROM stock_movements sm JOIN batches b ON b.id = sm.batch_id JOIN materials m ON m.id = b.material_id
          ORDER BY sm.created_at DESC LIMIT 20`
      ),
      pool.query(
        `SELECT p.id, p.name, p.craft_type AS "craftType", p.status, p.due_date AS "dueDate",
                (SELECT count(*)::int FROM project_requirements r WHERE r.project_id = p.id) AS "requirementCount",
                (SELECT count(*)::int FROM consumptions c WHERE c.project_id = p.id AND c.status = 'ACTIVE') AS "consumptionCount"
           FROM projects p
          WHERE p.status IN ('PLANNED', 'IN_PROGRESS') AND p.archived_at IS NULL
          ORDER BY CASE p.status WHEN 'IN_PROGRESS' THEN 0 ELSE 1 END, p.due_date ASC NULLS LAST LIMIT 10`
      )
    ]);
    return {
      data: {
        summary: summary.rows[0],
        lowStock: lowStock.rows,
        expiring: expiring.rows,
        recentMovements: movements.rows,
        activeProjects: projects.rows,
        generatedAt: new Date().toISOString()
      }
    };
  });

  app.get<{ Querystring: Query }>("/audit-logs", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions = ["1 = 1"];
    if (request.query.entityType) {
      values.push(request.query.entityType);
      conditions.push(`a.entity_type = $${values.length}`);
    }
    if (request.query.action) {
      values.push(request.query.action);
      conditions.push(`a.action = $${values.length}`);
    }
    const where = conditions.join(" AND ");
    const total = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM audit_logs a WHERE ${where}`, values);
    values.push(pageSize, offset);
    const rows = await pool.query(
      `SELECT a.id, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId",
              a.before_data AS "beforeData", a.after_data AS "afterData", a.request_id AS "requestId",
              a.created_at AS "createdAt", u.display_name AS "actorName"
         FROM audit_logs a JOIN users u ON u.id = a.actor_user_id
        WHERE ${where} ORDER BY a.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.get("/exports/materials.csv", async (_request, reply) => {
    const result = await pool.query<Record<string, unknown>>(
      `SELECT m.name, m.code, array_to_string(m.craft_types, '|') AS craft_types, m.subtype,
              m.stock_unit, m.low_stock_threshold, m.default_color_name, m.default_color_hex,
              coalesce(sum(b.remaining_quantity) FILTER (WHERE b.status <> 'ARCHIVED'), 0) AS remaining_quantity,
              count(b.id) FILTER (WHERE b.status <> 'ARCHIVED') AS batch_count,
              array_to_string(m.tags, '|') AS tags, m.notes, m.created_at, m.updated_at
         FROM materials m LEFT JOIN batches b ON b.material_id = m.id
        WHERE m.archived_at IS NULL GROUP BY m.id ORDER BY m.name`
    );
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="materials-${new Date().toISOString().slice(0, 10)}.csv"`);
    return `\uFEFF${toCsv(result.rows)}`;
  });

  app.get("/exports/batches.csv", async (_request, reply) => {
    const result = await pool.query<Record<string, unknown>>(
      `SELECT m.name AS material_name, b.batch_code, s.name AS source_name, l.name AS location_name,
              b.received_at, b.expiry_at, b.initial_quantity, b.remaining_quantity, b.stock_unit,
              b.current_color_name, b.current_color_hex, b.status, b.notes, b.created_at, b.updated_at
         FROM batches b JOIN materials m ON m.id = b.material_id
         LEFT JOIN sources s ON s.id = b.source_id LEFT JOIN storage_locations l ON l.id = b.location_id
        ORDER BY b.created_at DESC`
    );
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="batches-${new Date().toISOString().slice(0, 10)}.csv"`);
    return `\uFEFF${toCsv(result.rows)}`;
  });

  app.get("/exports/workspace.json", async (_request, reply) => {
    const [sources, locations, materials, batches, movements, projects, requirements, consumptions, colorChanges, attachments, auditLogs] = await Promise.all([
      pool.query("SELECT * FROM sources ORDER BY created_at"),
      pool.query("SELECT * FROM storage_locations ORDER BY created_at"),
      pool.query("SELECT * FROM materials ORDER BY created_at"),
      pool.query("SELECT * FROM batches ORDER BY created_at"),
      pool.query("SELECT * FROM stock_movements ORDER BY created_at"),
      pool.query("SELECT * FROM projects ORDER BY created_at"),
      pool.query("SELECT * FROM project_requirements ORDER BY created_at"),
      pool.query("SELECT * FROM consumptions ORDER BY created_at"),
      pool.query("SELECT * FROM color_changes ORDER BY created_at"),
      pool.query("SELECT * FROM attachments ORDER BY created_at"),
      pool.query("SELECT * FROM audit_logs ORDER BY created_at")
    ]);
    reply.header("Content-Disposition", `attachment; filename="handcraft-workspace-${new Date().toISOString().slice(0, 10)}.json"`);
    return reply.send({
      exportedAt: new Date().toISOString(),
      schemaVersion: 1,
      sources: sources.rows,
      locations: locations.rows,
      materials: materials.rows,
      batches: batches.rows,
      stockMovements: movements.rows,
      projects: projects.rows,
      projectRequirements: requirements.rows,
      consumptions: consumptions.rows,
      colorChanges: colorChanges.rows,
      attachments: attachments.rows,
      auditLogs: auditLogs.rows
    });
  });
}
