import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { databaseConnection } from "./config.js";

const { Client } = pg;

export async function runMigrations(): Promise<void> {
  const client = new Client(databaseConnection);
  await client.connect();
  try {
    const migrationDir = fileURLToPath(new URL("../sql", import.meta.url));
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('handcraft_material_tracker_migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_migrations (
        name text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = await readFile(path.join(migrationDir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM app_migrations WHERE name = $1",
        [file]
      );
      if (existing.rowCount) {
        if (existing.rows[0]?.checksum !== checksum) {
          throw new Error(`Migration ${file} has changed after being applied`);
        }
        continue;
      }
      await client.query(sql);
      await client.query("INSERT INTO app_migrations(name, checksum) VALUES ($1, $2)", [file, checksum]);
      console.info(`Applied migration ${file}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Migration rollback failed", rollbackError);
    }
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
