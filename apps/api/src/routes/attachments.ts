import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { attachmentOwnerTypes, type AttachmentOwnerType } from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { config } from "../config.js";

const mimeExtensions: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp"
};

const ownerTable: Record<AttachmentOwnerType, string> = {
  BATCH: "batches",
  COLOR_CHANGE: "color_changes",
  PROJECT: "projects",
  CONSUMPTION: "consumptions"
};

function hasExpectedMagic(buffer: Buffer, mime: string): boolean {
  if (mime === "image/jpeg") return buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (mime === "image/png") return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === "image/webp") return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

function uploadPath(storageKey: string): string {
  const root = path.resolve(config.UPLOAD_DIR);
  const resolved = path.resolve(root, storageKey);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new AppError(400, "INVALID_STORAGE_KEY", "附件存储路径无效");
  }
  return resolved;
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/attachments", async (request, reply) => {
    const fields: Record<string, string> = {};
    let filePart: { filename: string; mimetype: string; buffer: Buffer } | null = null;

    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (filePart) throw new AppError(422, "MULTIPLE_FILES", "每次只能上传一个文件");
        const buffer = await part.toBuffer();
        filePart = { filename: part.filename, mimetype: part.mimetype, buffer };
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    if (!fields.ownerType || !attachmentOwnerTypes.includes(fields.ownerType as AttachmentOwnerType)) {
      throw new AppError(422, "INVALID_OWNER_TYPE", "附件归属类型无效");
    }
    if (!fields.ownerId) throw new AppError(422, "INVALID_OWNER_ID", "附件归属记录不能为空");
    if (!filePart) throw new AppError(422, "FILE_REQUIRED", "请选择图片文件");
    if (!mimeExtensions[filePart.mimetype]) throw new AppError(415, "UNSUPPORTED_FILE_TYPE", "只支持 JPG、PNG 和 WebP 图片");
    if (filePart.buffer.length <= 0 || filePart.buffer.length > config.MAX_UPLOAD_BYTES) {
      throw new AppError(413, "FILE_TOO_LARGE", `图片不能超过 ${Math.floor(config.MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
    }
    if (!hasExpectedMagic(filePart.buffer, filePart.mimetype)) {
      throw new AppError(415, "INVALID_FILE_CONTENT", "文件内容与图片类型不匹配");
    }

    const ownerType = fields.ownerType as AttachmentOwnerType;

    const storageKey = `${ownerType.toLowerCase()}/${randomUUID()}${mimeExtensions[filePart.mimetype]}`;
    const destination = uploadPath(storageKey);
    const temporary = `${destination}.tmp`;
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await writeFile(temporary, filePart.buffer, { flag: "wx" });
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }

    const sha256 = createHash("sha256").update(filePart.buffer).digest("hex");
    const originalName = path.basename(filePart.filename).slice(0, 255);
    const user = (request as AuthenticatedRequest).authUser;
    try {
      const created = await withTransaction(async (client) => {
        const ownerExists = await client.query(`SELECT 1 FROM ${ownerTable[ownerType]} WHERE id = $1 FOR SHARE`, [fields.ownerId]);
        if (!ownerExists.rowCount) throw new AppError(422, "INVALID_OWNER", "附件归属记录不存在");
        const result = await client.query(
          `INSERT INTO attachments(owner_type, owner_id, original_name, storage_key, mime_type, byte_size, sha256)
           VALUES ($1::attachment_owner_type, $2, $3, $4, $5, $6, $7)
           RETURNING id, owner_type AS "ownerType", owner_id AS "ownerId", original_name AS "originalName",
                     mime_type AS "mimeType", byte_size::text AS "byteSize", sha256, created_at AS "createdAt"`,
          [ownerType, fields.ownerId, originalName, storageKey, filePart.mimetype, filePart.buffer.length, sha256]
        );
        await writeAudit(client, {
          actorUserId: user.id, action: "UPLOAD", entityType: "ATTACHMENT", entityId: result.rows[0]?.id,
          afterData: { ownerType, ownerId: fields.ownerId, originalName, byteSize: filePart.buffer.length },
          requestId: request.id
        });
        return result.rows[0];
      });
      return reply.status(201).send({ data: created });
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/attachments/:id", async (request, reply) => {
    const result = await pool.query<{ original_name: string; storage_key: string; mime_type: string }>(
      "SELECT original_name, storage_key, mime_type FROM attachments WHERE id = $1",
      [request.params.id]
    );
    const attachment = result.rows[0];
    if (!attachment) throw new AppError(404, "NOT_FOUND", "附件不存在");
    try {
      await access(uploadPath(attachment.storage_key));
    } catch {
      throw new AppError(404, "ATTACHMENT_FILE_MISSING", "附件文件不存在");
    }
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
    reply.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`);
    return reply.type(attachment.mime_type).send(createReadStream(uploadPath(attachment.storage_key)));
  });

  app.delete<{ Params: { id: string } }>("/attachments/:id", async (request, reply) => {
    const user = (request as AuthenticatedRequest).authUser;
    const result = await pool.query<{ id: string; storage_key: string; owner_type: string; owner_id: string }>(
      "SELECT id, storage_key, owner_type, owner_id FROM attachments WHERE id = $1",
      [request.params.id]
    );
    const attachment = result.rows[0];
    if (!attachment) throw new AppError(404, "NOT_FOUND", "附件不存在");
    const filePath = uploadPath(attachment.storage_key);
    const trashPath = `${filePath}.deleting-${Date.now()}`;
    let movedFile = false;
    try {
      await rename(filePath, trashPath);
      movedFile = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await withTransaction(async (client) => {
        await client.query("DELETE FROM attachments WHERE id = $1", [attachment.id]);
        await writeAudit(client, {
          actorUserId: user.id, action: "DELETE", entityType: "ATTACHMENT", entityId: attachment.id,
          beforeData: { ownerType: attachment.owner_type, ownerId: attachment.owner_id },
          requestId: request.id
        });
      });
      if (movedFile) await unlink(trashPath).catch(() => undefined);
    } catch (error) {
      if (movedFile) await rename(trashPath, filePath).catch(() => undefined);
      throw error;
    }
    return reply.status(204).send();
  });
}
