import pg from "pg";
import { databaseConnection } from "../config.js";

const { Pool } = pg;

export const pool = new Pool({
  ...databaseConnection,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error", error);
});

export type DbClient = pg.PoolClient;

/** PostgreSQL 序列化失败（40001）与死锁（40P01），调用方应重试整个事务。 */
const SERIALIZATION_FAILURE_CODES = new Set(["40001", "40P01"]);

export function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && SERIALIZATION_FAILURE_CODES.has(code);
}

const DEFAULT_TRANSACTION_ATTEMPTS = 3;

/**
 * 在事务中执行工作；遇到死锁/序列化失败时用全新事务自动重试。
 * 业务错误（AppError）不重试，直接抛出由路由层处理。
 */
export async function withTransaction<T>(
  work: (client: DbClient) => Promise<T>,
  options: { attempts?: number } = {}
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_TRANSACTION_ATTEMPTS);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Transaction rollback failed", rollbackError);
      }
      if (!isRetryableTransactionError(error) || attempt === attempts) throw error;
    } finally {
      client.release();
    }
  }
  // 理论上不可达：循环必然 return 或 throw，这里仅为类型收窄。
  throw new Error("withTransaction exited without committing");
}

export async function checkDatabase(): Promise<void> {
  await pool.query("SELECT 1");
}
