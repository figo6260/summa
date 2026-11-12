import type { ActorType, Prisma, PrismaClient } from "@prisma/client";

export interface AuditEntry {
  programId?: string | null;
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Prisma.InputJsonValue;
}

/** Append one audit-log row. Key operations must never happen unaudited. */
export async function writeAudit(db: PrismaClient, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      programId: entry.programId ?? null,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? undefined,
    },
  });
}
