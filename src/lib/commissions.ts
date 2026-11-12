import type { Commission, PrismaClient } from "@prisma/client";
import { writeAudit } from "./audit";
import { effectiveCommissionCents } from "./balance";
import {
  sendCommissionAvailableEmail,
  sendCommissionRejectedEmail,
} from "./mailer";

/**
 * Commission lifecycle operations (M4): hold release and admin review.
 *
 * Release rule: a HOLDING commission whose holdUntil has passed matures
 * into AVAILABLE — EXCEPT commissions stamped `pending_review` (a
 * pipeline hook asked for a human look in M3). Those never auto-release;
 * an admin must approve them first (which simply clears the stamp).
 *
 * Release is driven from outside the web process (scripts/
 * release-commissions.mjs via cron/systemd) or by an admin pressing the
 * button on /admin/commissions; both paths call the same function.
 */

/** statusReason value the conversion pipeline stamps for hook reviews. */
export const PENDING_REVIEW_REASON = "pending_review";

export function isPendingReview(commission: {
  status: string;
  statusReason: string | null;
}): boolean {
  return (
    commission.status === "HOLDING" &&
    commission.statusReason === PENDING_REVIEW_REASON
  );
}

export interface ReleaseResult {
  releasedIds: string[];
  count: number;
}

/**
 * Mature every due, non-review HOLDING commission. Each released
 * commission gets its own SYSTEM audit entry (actorId null) — also when
 * an admin triggered the run; the admin trigger itself is audited
 * separately by the caller.
 */
export async function releaseMaturedCommissions(
  db: PrismaClient,
  now: Date = new Date(),
  opts: { trigger?: "schedule" | "admin"; adminId?: string } = {},
): Promise<ReleaseResult> {
  const due = await db.commission.findMany({
    where: {
      status: "HOLDING",
      holdUntil: { lte: now },
      // Pending-review commissions are held for a human, not the clock.
      OR: [
        { statusReason: null },
        { statusReason: { not: PENDING_REVIEW_REASON } },
      ],
    },
    orderBy: { holdUntil: "asc" },
    select: {
      id: true,
      programId: true,
      affiliateId: true,
      holdUntil: true,
      amountCents: true,
      reversedCents: true,
      currency: true,
    },
  });

  const releasedIds: string[] = [];
  const releasedByAffiliate = new Map<
    string,
    { programId: string; count: number; amountCents: number; currency: string }
  >();
  for (const commission of due) {
    // Guarded update: only flip if it is still HOLDING (a concurrent
    // reject must win over a release).
    const { count } = await db.commission.updateMany({
      where: { id: commission.id, status: "HOLDING" },
      data: { status: "AVAILABLE" },
    });
    if (count === 0) continue;
    releasedIds.push(commission.id);
    const bucket = releasedByAffiliate.get(commission.affiliateId) ?? {
      programId: commission.programId,
      count: 0,
      amountCents: 0,
      currency: commission.currency,
    };
    bucket.count += 1;
    bucket.amountCents += effectiveCommissionCents(commission);
    releasedByAffiliate.set(commission.affiliateId, bucket);
    await writeAudit(db, {
      programId: commission.programId,
      actorType: "SYSTEM",
      actorId: null,
      action: "commission.release",
      targetType: "Commission",
      targetId: commission.id,
      metadata: {
        affiliateId: commission.affiliateId,
        holdUntil: commission.holdUntil.toISOString(),
        trigger: opts.trigger ?? "schedule",
        ...(opts.adminId ? { triggeredByAdminId: opts.adminId } : {}),
      },
    });
  }

  // One aggregated availability email per affiliate per release run
  // (M5). sendMail never throws and the sender honours the affiliate's
  // notification preferences, so a mail problem can never fail a release.
  for (const [affiliateId, bucket] of releasedByAffiliate) {
    const affiliate = await db.affiliate.findUnique({
      where: { id: affiliateId },
    });
    const program = await db.program.findUnique({
      where: { id: bucket.programId },
      select: { name: true },
    });
    if (!affiliate || !program) continue;
    await sendCommissionAvailableEmail(db, {
      affiliate,
      programName: program.name,
      count: bucket.count,
      amountCents: bucket.amountCents,
      currency: bucket.currency,
    });
  }
  return { releasedIds, count: releasedIds.length };
}

/**
 * Approve a pending-review commission: clears the review stamp so the
 * normal hold clock (and the release job) applies to it again.
 */
export async function approveCommissionReview(
  db: PrismaClient,
  actorId: string,
  commissionId: string,
): Promise<Commission> {
  const commission = await db.commission.findUnique({
    where: { id: commissionId },
  });
  if (!commission) throw new Error("commission_not_found");
  if (!isPendingReview(commission)) throw new Error("not_pending_review");
  const updated = await db.commission.update({
    where: { id: commissionId },
    data: { statusReason: null },
  });
  await writeAudit(db, {
    programId: commission.programId,
    actorType: "ADMIN",
    actorId,
    action: "commission.review_approve",
    targetType: "Commission",
    targetId: commission.id,
  });
  return updated;
}

/**
 * Reject a HOLDING commission (terminal). A reason is mandatory: it is
 * stored on the commission (statusReason) so the affiliate sees it in
 * their portal, and mirrored into the audit entry.
 */
export async function rejectCommission(
  db: PrismaClient,
  actorId: string,
  commissionId: string,
  reason: string,
): Promise<Commission> {
  if (!reason || reason.trim() === "") throw new Error("reason_required");
  const commission = await db.commission.findUnique({
    where: { id: commissionId },
  });
  if (!commission) throw new Error("commission_not_found");
  if (commission.status !== "HOLDING") {
    throw new Error("commission_not_holding");
  }
  const trimmed = reason.trim();
  const updated = await db.commission.update({
    where: { id: commissionId },
    data: { status: "REJECTED", statusReason: trimmed },
  });
  await writeAudit(db, {
    programId: commission.programId,
    actorType: "ADMIN",
    actorId,
    action: "commission.review_reject",
    targetType: "Commission",
    targetId: commission.id,
    metadata: { reason: trimmed },
  });

  // Notify the affiliate (M5). sendMail never throws, so a mail
  // problem cannot roll back the rejection.
  const affiliate = await db.affiliate.findUnique({
    where: { id: commission.affiliateId },
  });
  const program = await db.program.findUnique({
    where: { id: commission.programId },
    select: { name: true },
  });
  const conversion = await db.conversion.findUnique({
    where: { id: commission.conversionId },
    select: { externalOrderId: true },
  });
  if (affiliate && program) {
    await sendCommissionRejectedEmail(db, {
      affiliate,
      programName: program.name,
      commissionId,
      orderId: conversion?.externalOrderId ?? commissionId,
      amountCents: effectiveCommissionCents(commission),
      currency: commission.currency,
      reason: trimmed,
    });
  }
  return updated;
}
