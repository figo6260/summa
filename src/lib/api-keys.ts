import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiKey, PrismaClient } from "@prisma/client";
import { writeAudit } from "./audit";

/**
 * API keys for the server-to-server conversion API (M3).
 *
 * A key looks like `summa_<32 base64url chars>`. Only its SHA-256 hash is
 * stored; the first 14 characters are kept as a display/lookup prefix so
 * authentication can find the (few) candidate rows by prefix and then
 * compare hashes in constant time. The plain key is shown exactly once,
 * at creation time.
 */

const KEY_PREFIX_LENGTH = 14; // "summa_" + 8 chars

export function hashApiKey(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

export function apiKeyPrefix(plain: string): string {
  return plain.slice(0, KEY_PREFIX_LENGTH);
}

export interface CreatedApiKey {
  apiKey: ApiKey;
  /** The plain key — available only in this return value, never stored. */
  plain: string;
}

export async function createApiKey(
  db: PrismaClient,
  actorId: string,
  programId: string,
  name: string,
): Promise<CreatedApiKey> {
  const plain = `summa_${randomBytes(24).toString("base64url")}`;
  const apiKey = await db.apiKey.create({
    data: {
      programId,
      name: name.trim(),
      prefix: apiKeyPrefix(plain),
      keyHash: hashApiKey(plain),
    },
  });
  await writeAudit(db, {
    programId,
    actorType: "ADMIN",
    actorId,
    action: "api_key.create",
    targetType: "ApiKey",
    targetId: apiKey.id,
    metadata: { name: apiKey.name, prefix: apiKey.prefix },
  });
  return { apiKey, plain };
}

export async function revokeApiKey(
  db: PrismaClient,
  actorId: string,
  apiKeyId: string,
): Promise<ApiKey> {
  const existing = await db.apiKey.findUnique({ where: { id: apiKeyId } });
  if (!existing) throw new Error("api_key_not_found");
  const updated = await db.apiKey.update({
    where: { id: apiKeyId },
    data: { revokedAt: new Date() },
  });
  await writeAudit(db, {
    programId: existing.programId,
    actorType: "ADMIN",
    actorId,
    action: "api_key.revoke",
    targetType: "ApiKey",
    targetId: existing.id,
    metadata: { prefix: existing.prefix },
  });
  return updated;
}

/**
 * Authenticate a presented key. Returns the ApiKey row (and stamps
 * lastUsedAt) or null for missing / unknown / revoked keys — callers map
 * every failure to the same 401 so nothing about key existence leaks.
 */
export async function authenticateApiKey(
  db: PrismaClient,
  presented: string | null | undefined,
): Promise<ApiKey | null> {
  if (!presented) return null;
  const candidates = await db.apiKey.findMany({
    where: { prefix: apiKeyPrefix(presented), revokedAt: null },
  });
  const presentedHash = Buffer.from(hashApiKey(presented), "hex");
  for (const candidate of candidates) {
    const storedHash = Buffer.from(candidate.keyHash, "hex");
    if (
      storedHash.length === presentedHash.length &&
      timingSafeEqual(storedHash, presentedHash)
    ) {
      await db.apiKey.update({
        where: { id: candidate.id },
        data: { lastUsedAt: new Date() },
      });
      return candidate;
    }
  }
  return null;
}
