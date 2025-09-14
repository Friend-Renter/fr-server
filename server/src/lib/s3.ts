// server/src/lib/s3.ts
import path from "node:path";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { nanoid } from "nanoid";

import { env } from "../config/env.js";

const s3 = new S3Client({
  region: env.S3_REGION,
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : undefined, // allow default AWS provider chain if you prefer
});

const CONTENT_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "application/pdf": ".pdf",
};

function chooseExt(contentType: string, pathHint?: string) {
  const fromHint = pathHint ? path.extname(pathHint) : "";
  if (fromHint) return fromHint;
  return CONTENT_EXT[contentType] ?? "";
}

export function buildKey(opts: {
  folder: "assets" | "checkins" | "checkouts";
  contentType: string;
  pathHint?: string;
}) {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const id = nanoid(16);
  const ext = chooseExt(opts.contentType, opts.pathHint);
  const prefix = env.S3_KEY_PREFIX || "fr";
  const key = `${prefix}/${opts.folder}/${yyyy}/${mm}/${id}${ext}`;
  return { key, ext };
}

export async function presignPut(key: string, contentType: string) {
  if (!env.S3_BUCKET) throw new Error("S3_BUCKET not configured");
  const put = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ContentType: contentType,
    // long-lived browser cache for immutable media
    CacheControl: "public,max-age=31536000,immutable",
  });
  const uploadUrl = await getSignedUrl(s3, put, { expiresIn: 60 * 5 }); // 5 minutes
  return {
    uploadUrl,
    headers: { "Content-Type": contentType },
    method: "PUT" as const,
  };
}

export function toPublicUrl(key: string) {
  if (env.CDN_DOMAIN) {
    return `https://${env.CDN_DOMAIN}/${key}`;
  }
  // virtual-hosted–style S3 URL
  return `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com/${key}`;
}
