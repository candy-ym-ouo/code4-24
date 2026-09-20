import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const production = process.env.NODE_ENV === "production";
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_HOST: z.string().min(1).default(production ? "0.0.0.0" : "127.0.0.1"),
  APP_PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().optional(),
  PGHOST: z.string().min(1).optional(),
  PGPORT: z.coerce.number().int().positive().default(5432),
  PGDATABASE: z.string().min(1).optional(),
  PGUSER: z.string().min(1).optional(),
  PGPASSWORD: z.string().optional(),
  SESSION_SECRET: z.string().min(32).default(production ? "" : "development-only-secret-change-me-123456"),
  COOKIE_SECURE: z.enum(["true", "false"]).default(production ? "true" : "false").transform((value) => value === "true"),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:8080").transform((value) => new URL(value).origin),
  UPLOAD_DIR: z.string().min(1).default("./uploads"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")
});

const environment = { ...process.env };
if (!environment.DATABASE_URL && !environment.PGHOST) {
  environment.DATABASE_URL = "postgresql://handcraft:change-me@localhost:55432/handcraft";
}

const parsed = schema.parse(environment);

if (parsed.NODE_ENV === "production" && (parsed.DATABASE_URL?.includes("change-me") || parsed.PGPASSWORD === "change-me")) {
  throw new Error("Production database password must not use the example value");
}

if (parsed.NODE_ENV === "production" && (parsed.SESSION_SECRET.includes("development-only") || parsed.SESSION_SECRET.startsWith("replace-with"))) {
  throw new Error("Production SESSION_SECRET must be a unique random value");
}

if (parsed.NODE_ENV === "production" && parsed.PUBLIC_APP_URL.startsWith("https://") && !parsed.COOKIE_SECURE) {
  throw new Error("COOKIE_SECURE must be true when PUBLIC_APP_URL uses HTTPS");
}

export const config = parsed;

export const databaseConnection = parsed.DATABASE_URL
  ? { connectionString: parsed.DATABASE_URL }
  : {
      host: parsed.PGHOST,
      port: parsed.PGPORT,
      database: parsed.PGDATABASE,
      user: parsed.PGUSER,
      password: parsed.PGPASSWORD
    };
