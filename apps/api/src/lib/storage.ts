import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export async function checkStorageWritable(): Promise<void> {
  const directory = path.resolve(config.UPLOAD_DIR);
  await mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.health-${process.pid}-${randomUUID()}`);
  await writeFile(probe, "ok", { flag: "wx" });
  await unlink(probe);
}
