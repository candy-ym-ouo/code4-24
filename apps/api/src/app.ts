import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { authenticate } from "./lib/auth.js";
import { checkDatabase, pool } from "./lib/db.js";
import { AppError, isClientError, sendError } from "./lib/errors.js";
import { runMigrations } from "./migrate.js";
import { checkStorageWritable } from "./lib/storage.js";
import { authRoutes } from "./routes/auth.js";
import { catalogRoutes } from "./routes/catalog.js";
import { materialRoutes } from "./routes/materials.js";
import { batchRoutes } from "./routes/batches.js";
import { projectRoutes } from "./routes/projects.js";
import { consumptionRoutes } from "./routes/consumptions.js";
import { colorChangeRoutes } from "./routes/colorChanges.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { insightRoutes } from "./routes/insights.js";

export async function buildApp(options: { runDatabaseMigrations?: boolean } = {}): Promise<FastifyInstance> {
  if (options.runDatabaseMigrations) {
    await runMigrations();
  }

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']"]
    },
    trustProxy: true,
    bodyLimit: config.MAX_UPLOAD_BYTES + 1024 * 1024
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: config.PUBLIC_APP_URL,
    credentials: true
  });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    limits: {
      fileSize: config.MAX_UPLOAD_BYTES,
      files: 1,
      fields: 10
    }
  });

  app.addHook("preValidation", async (request) => {
    const query = request.query as Record<string, unknown>;
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        throw new AppError(422, "DUPLICATE_QUERY_PARAM", `查询参数 ${key} 只能出现一次`);
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "请求过于频繁，请稍后重试",
          fieldErrors: {},
          requestId: request.id
        }
      });
    }
    if (!isClientError(error)) {
      request.log.error({ err: error }, "request failed");
    }
    return sendError(reply, error, request.id);
  });

  app.get("/health/live", async () => ({ status: "ok", timestamp: new Date().toISOString() }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await Promise.all([checkDatabase(), checkStorageWritable()]);
      const migration = await pool.query("SELECT count(*)::int AS count FROM app_migrations");
      return { status: "ready", migrations: migration.rows[0]?.count ?? 0, timestamp: new Date().toISOString() };
    } catch {
      return reply.status(503).send({ status: "not_ready" });
    }
  });

  await app.register(authRoutes, { prefix: "/api/v1" });
  await app.register(async (protectedRoutes) => {
    protectedRoutes.addHook("preHandler", authenticate);
    await protectedRoutes.register(catalogRoutes);
    await protectedRoutes.register(materialRoutes);
    await protectedRoutes.register(batchRoutes);
    await protectedRoutes.register(projectRoutes);
    await protectedRoutes.register(consumptionRoutes);
    await protectedRoutes.register(colorChangeRoutes);
    await protectedRoutes.register(attachmentRoutes);
    await protectedRoutes.register(insightRoutes);
  }, { prefix: "/api/v1" });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: "接口不存在",
        fieldErrors: {},
        requestId: request.id
      }
    });
  });

  return app;
}
