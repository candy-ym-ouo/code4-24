import type { FastifyReply } from "fastify";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly fieldErrors: Record<string, string[]> = {}
  ) {
    super(message);
    this.name = "AppError";
  }
}

type ErrorWithMetadata = {
  code?: string;
  statusCode?: number;
  constraint?: string;
};

function errorMetadata(error: unknown): ErrorWithMetadata {
  return typeof error === "object" && error !== null ? (error as ErrorWithMetadata) : {};
}

export function isClientError(error: unknown): boolean {
  if (error instanceof AppError) return error.statusCode < 500;
  const metadata = errorMetadata(error);
  if (typeof metadata.statusCode === "number" && metadata.statusCode >= 400 && metadata.statusCode < 500) return true;
  return [
    "23505", "23503", "23502", "23514", "23P01", "40001", "40P01",
    "22001", "22003", "22P02", "22007", "22008", "22023"
  ].includes(metadata.code ?? "");
}

export function sendError(reply: FastifyReply, error: unknown, requestId: string): void {
  if (error instanceof AppError) {
    reply.status(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
        fieldErrors: error.fieldErrors,
        requestId
      }
    });
    return;
  }

  const metadata = errorMetadata(error);
  const databaseCode = metadata.code;

  if (databaseCode === "40001" || databaseCode === "40P01") {
    reply.status(409).send({
      error: {
        code: "CONCURRENT_TRANSACTION",
        message: "数据正在被其他操作修改，请重试",
        fieldErrors: {},
        requestId
      }
    });
    return;
  }

  if (databaseCode === "23505") {
    reply.status(409).send({
      error: {
        code: "DUPLICATE_DATA",
        message: "数据已存在，请检查唯一字段",
        fieldErrors: {},
        requestId
      }
    });
    return;
  }

  if (databaseCode === "23503") {
    reply.status(409).send({
      error: {
        code: "REFERENCE_CONFLICT",
        message: "该记录仍被其他数据引用，无法完成当前操作",
        fieldErrors: {},
        requestId
      }
    });
    return;
  }

  if (databaseCode === "23502" || databaseCode === "23514" || databaseCode === "23P01") {
    reply.status(422).send({
      error: {
        code: "DATA_RULE_VIOLATION",
        message: "数据不符合业务规则",
        fieldErrors: {},
        requestId
      }
    });
    return;
  }

  if (databaseCode === "22001" || databaseCode === "22003" || databaseCode === "22P02" || databaseCode === "22007" || databaseCode === "22008" || databaseCode === "22023") {
    reply.status(422).send({
      error: {
        code: "INVALID_PARAMETER",
        message: "请求参数格式或取值无效",
        fieldErrors: {},
        requestId
      }
    });
    return;
  }

  const statusCode = metadata.statusCode;
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    const code = metadata.code === "FST_ERR_CTP_INVALID_JSON_BODY" ? "INVALID_JSON" : metadata.code || "BAD_REQUEST";
    const message = metadata.code === "FST_ERR_CTP_INVALID_JSON_BODY"
      ? "请求体不是有效的 JSON"
      : statusCode === 413
        ? "上传内容超过大小限制"
        : statusCode === 429
          ? "请求过于频繁，请稍后重试"
          : "请求参数不符合要求";
    reply.status(statusCode).send({
      error: {
        code,
        message,
        fieldErrors: {},
        requestId
      }
    });
    return;
  }

  reply.status(500).send({
    error: {
      code: "INTERNAL_ERROR",
      message: "服务器处理失败",
      fieldErrors: {},
      requestId
    }
  });
}
