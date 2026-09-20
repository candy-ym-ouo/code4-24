import type { ZodType } from "zod";
import { AppError } from "./errors.js";

export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  const fieldErrors: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "request";
    fieldErrors[key] ??= [];
    fieldErrors[key].push(issue.message);
  }

  throw new AppError(422, "VALIDATION_ERROR", "请求参数不符合要求", fieldErrors);
}
