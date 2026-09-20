import { AppError } from "./errors.js";

export function getIdempotencyKey(headers: Record<string, unknown>): string | undefined {
  const raw = headers["idempotency-key"];
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") {
    throw new AppError(422, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key 必须是字符串");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 100) {
    throw new AppError(422, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key 长度必须为 1 到 100 个字符");
  }
  return normalized;
}
