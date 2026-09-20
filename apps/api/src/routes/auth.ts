import type { FastifyInstance } from "fastify";
import { loginSchema, passwordChangeSchema, setupSchema } from "@handcraft/contracts";
import { hashPassword, verifyPassword, createSession, setSessionCookie, revokeSession, hashSessionToken, authenticate, type AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { parseInput } from "../lib/validation.js";
import { config } from "../config.js";
import { writeAudit } from "../lib/audit.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get("/setup/status", async () => {
    const result = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM users");
    return { data: { initialized: Number(result.rows[0]?.count ?? 0) > 0 } };
  });

  app.post("/setup", async (request, reply) => {
    const input = parseInput(setupSchema, request.body);
    const passwordHash = await hashPassword(input.password);
    const user = await withTransaction(async (client) => {
      const existing = await client.query("SELECT id FROM users LIMIT 1 FOR UPDATE");
      if (existing.rowCount) {
        throw new AppError(409, "ALREADY_INITIALIZED", "应用已经完成初始化");
      }
      const created = await client.query<{ id: string; display_name: string }>(
        `INSERT INTO users(display_name, password_hash)
         VALUES ($1, $2)
         RETURNING id, display_name`,
        [input.displayName, passwordHash]
      );
      const row = created.rows[0];
      if (!row) {
        throw new AppError(500, "USER_CREATE_FAILED", "操作员创建失败");
      }
      await writeAudit(client, {
        actorUserId: row.id,
        action: "CREATE",
        entityType: "USER",
        entityId: row.id,
        afterData: { displayName: row.display_name },
        requestId: request.id
      });
      return row;
    });

    const session = await createSession(user.id);
    setSessionCookie(reply, session.token, session.expiresAt, config.COOKIE_SECURE);
    return reply.status(201).send({ data: { id: user.id, displayName: user.display_name } });
  });

  app.post(
    "/auth/login",
    {
      config: {
        rateLimit: {
          max: 8,
          timeWindow: "15 minutes"
        }
      }
    },
    async (request, reply) => {
      const input = parseInput(loginSchema, request.body);
      const authenticated = await withTransaction(async (client) => {
        const result = await client.query<{ id: string; display_name: string; password_hash: string }>(
          "SELECT id, display_name, password_hash FROM users LIMIT 1 FOR SHARE"
        );
        const user = result.rows[0];
        if (!user || !(await verifyPassword(user.password_hash, input.password))) {
          throw new AppError(401, "INVALID_CREDENTIALS", "密码错误");
        }
        const session = await createSession(user.id, client);
        await client.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
        return { user, session };
      });

      setSessionCookie(reply, authenticated.session.token, authenticated.session.expiresAt, config.COOKIE_SECURE);
      return { data: { id: authenticated.user.id, displayName: authenticated.user.display_name } };
    }
  );

  app.post("/auth/logout", async (request, reply) => {
    await revokeSession(request);
    reply.clearCookie("handcraft_session", { path: "/" });
    return reply.status(204).send();
  });

  app.get("/auth/me", async (request) => {
    const token = request.cookies.handcraft_session;
    if (!token) {
      throw new AppError(401, "UNAUTHENTICATED", "请先登录");
    }
    const result = await pool.query<{ id: string; displayName: string }>(
      `SELECT u.id, u.display_name AS "displayName"
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [hashSessionToken(token)]
    );
    const user = result.rows[0];
    if (!user) {
      throw new AppError(401, "SESSION_EXPIRED", "登录已失效，请重新登录");
    }
    return { data: user };
  });

  app.post("/auth/password", { preHandler: authenticate }, async (request, reply) => {
    const user = (request as AuthenticatedRequest).authUser;
    const input = parseInput(passwordChangeSchema, request.body);
    await withTransaction(async (client) => {
      const result = await client.query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE id = $1 FOR UPDATE",
        [user.id]
      );
      const current = result.rows[0];
      if (!current || !(await verifyPassword(current.password_hash, input.currentPassword))) {
        throw new AppError(401, "INVALID_CURRENT_PASSWORD", "当前密码错误");
      }
      const nextHash = await hashPassword(input.newPassword);
      await client.query("UPDATE users SET password_hash = $1 WHERE id = $2", [nextHash, user.id]);
      await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [user.id]);
      await writeAudit(client, {
        actorUserId: user.id,
        action: "UPDATE_PASSWORD",
        entityType: "USER",
        entityId: user.id,
        requestId: request.id
      });
    });
    reply.clearCookie("handcraft_session", { path: "/" });
    return reply.status(204).send();
  });
}
