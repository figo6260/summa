import type { Commission, Conversion, PrismaClient } from "@prisma/client";
import { writeAudit } from "./audit";

/**
 * Refund & chargeback clawback service (M4) — the single path used by
 * the Stripe webhook and by the admin "register refund" form alike.
 * (This replaces M3's applyPaymentReversal, which only handled the
 * still-HOLDING case and deferred the rest.)
 *
 * Cumulative proportional rule (decided 2026-11-12): the caller passes
 * the order's CUMULATIVE refunded total. The commission must end up
 * clawed back by
 *
 *   target = floor(commission.amountCents × refundedCents / orderAmount)
 *
 * (a chargeback claws back everything). `Commission.reversedCents` is
 * raised to that target — never lowered — so repeated partial refunds
 * accumulate and a full refund claws back exactly the full commission.
 * When reversedCents reaches amountCents the commission turns REVERSED
 * (from HOLDING, AVAILABLE or PAID alike); a partial clawback leaves
 * the status untouched and only shrinks the effective amount
 * (amountCents - reversedCents, see src/lib/balance.ts).
 *
 * REJECTED commissions are skipped: nothing was ever owed on them.
 */

export type ReversalActor =
  | { type: "SYSTEM"; id: null }
  | { type: "ADMIN"; id: string }
  | { type: "API"; id: string };

const SYSTEM_ACTOR: ReversalActor = { type: "SYSTEM", id: null };

export interface ApplyRefundInput {
  conversionId: string;
  /** The order's cumulative refunded total in cents (chargebacks: full). */
  refundedTotalCents: number;
  kind: "refund" | "chargeback";
  reason: string;
  actor?: ReversalActor;
}

export interface ApplyRefundResult {
  conversion: Conversion;
  commission: Commission | null;
  /** True when this call actually raised the clawed-back amount. */
  clawedBack: boolean;
}

export async function applyRefund(
  db: PrismaClient,
  input: ApplyRefundInput,
): Promise<ApplyRefundResult> {
  if (
    !Number.isInteger(input.refundedTotalCents) ||
    input.refundedTotalCents < 0
  ) {
    throw new Error("refund_invalid");
  }
  const actor = input.actor ?? SYSTEM_ACTOR;
  const found = await db.conversion.findUnique({
    where: { id: input.conversionId },
    include: { commission: true },
  });
  if (!found) throw new Error("conversion_not_found");
  const { commission, ...conversion } = found;

  const refundedCents =
    input.kind === "chargeback"
      ? conversion.amountCents
      : Math.max(
          conversion.refundedCents,
          Math.min(input.refundedTotalCents, conversion.amountCents),
        );

  const conversionStatus =
    input.kind === "chargeback"
      ? "CHARGEBACKED"
      : refundedCents >= conversion.amountCents
        ? "REFUNDED"
        : conversion.status;

  let updatedCommission: Commission | null = commission;
  let clawedBack = false;
  let skippedRejected = false;
  let target = 0;
  if (commission) {
    if (commission.status === "REJECTED") {
      skippedRejected = true;
    } else {
      target =
        input.kind === "chargeback"
          ? commission.amountCents
          : Math.floor(
              (commission.amountCents * refundedCents) / conversion.amountCents,
            );
      if (target > commission.reversedCents) clawedBack = true;
    }
  }
  const newReversed = commission
    ? Math.max(commission.reversedCents, target)
    : 0;

  const updated = await db.$transaction(async (tx) => {
    const updatedConversion = await tx.conversion.update({
      where: { id: conversion.id },
      data: { refundedCents, status: conversionStatus },
    });
    let nextCommission: Commission | null = commission;
    if (commission && !skippedRejected) {
      nextCommission = await tx.commission.update({
        where: { id: commission.id },
        data: {
          reversedCents: newReversed,
          ...(newReversed >= commission.amountCents
            ? { status: "REVERSED" as const }
            : {}),
        },
      });
    }
    return { updatedConversion, nextCommission };
  });
  updatedCommission = updated.nextCommission;

  if (commission && skippedRejected) {
    await writeAudit(db, {
      programId: conversion.programId,
      actorType: actor.type,
      actorId: actor.id,
      action: "commission.reverse_skipped",
      targetType: "Commission",
      targetId: commission.id,
      metadata: {
        externalOrderId: conversion.externalOrderId,
        kind: input.kind,
        reason: input.reason,
        note: "commission REJECTED; nothing to claw back",
      },
    });
  } else if (commission && clawedBack) {
    await writeAudit(db, {
      programId: conversion.programId,
      actorType: actor.type,
      actorId: actor.id,
      action: "commission.reverse",
      targetType: "Commission",
      targetId: commission.id,
      metadata: {
        externalOrderId: conversion.externalOrderId,
        kind: input.kind,
        reason: input.reason,
        refundedCentsBefore: conversion.refundedCents,
        refundedCentsAfter: refundedCents,
        reversedCentsBefore: commission.reversedCents,
        reversedCentsAfter: newReversed,
        commissionStatusAfter: updatedCommission?.status,
      },
    });
  }

  return {
    conversion: updated.updatedConversion,
    commission: updatedCommission,
    clawedBack,
  };
}

/**
 * Webhook entry point: locate a conversion by the merchant order id and
 * apply a refund/chargeback to it. `refundedTotalCents` is the order's
 * cumulative refunded amount as reported by the payment platform
 * (charge.refunded reports exactly that); chargebacks always claw back
 * in full.
 */
export async function applyStripeReversal(
  db: PrismaClient,
  input: {
    programId: string;
    externalOrderId: string;
    kind: "refund" | "chargeback";
    refundedTotalCents: number;
    reason: string;
  },
): Promise<
  | { kind: "applied"; result: ApplyRefundResult }
  | { kind: "not_found" }
> {
  const conversion = await db.conversion.findUnique({
    where: {
      programId_externalOrderId: {
        programId: input.programId,
        externalOrderId: input.externalOrderId,
      },
    },
    select: { id: true },
  });
  if (!conversion) return { kind: "not_found" };
  const result = await applyRefund(db, {
    conversionId: conversion.id,
    refundedTotalCents: input.refundedTotalCents,
    kind: input.kind,
    reason: input.reason,
    actor: SYSTEM_ACTOR,
  });
  // Keep the conversion-level trail the M3 webhook produced.
  await writeAudit(db, {
    programId: input.programId,
    actorType: "SYSTEM",
    actorId: null,
    action:
      input.kind === "refund" ? "conversion.refunded" : "conversion.chargebacked",
    targetType: "Conversion",
    targetId: conversion.id,
    metadata: {
      externalOrderId: input.externalOrderId,
      refundedCents: result.conversion.refundedCents,
      commissionReversed: result.commission?.status === "REVERSED",
    },
  });
  return { kind: "applied", result };
}

/**
 * Admin "register refund" (conversion detail page): the form collects
 * THIS refund's amount; it is merged into the order's cumulative total
 * before hitting the shared service, and the registration itself is
 * audited as conversion.refund.
 */
export async function registerRefundByAdmin(
  db: PrismaClient,
  adminId: string,
  conversionId: string,
  input: { amountCents: number; reason: string },
): Promise<ApplyRefundResult> {
  if (!input.reason || input.reason.trim() === "") {
    throw new Error("reason_required");
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("refund_invalid");
  }
  const conversion = await db.conversion.findUnique({
    where: { id: conversionId },
    select: { refundedCents: true, programId: true, externalOrderId: true },
  });
  if (!conversion) throw new Error("conversion_not_found");
  const result = await applyRefund(db, {
    conversionId,
    refundedTotalCents: conversion.refundedCents + input.amountCents,
    kind: "refund",
    reason: input.reason.trim(),
    actor: { type: "ADMIN", id: adminId },
  });
  await writeAudit(db, {
    programId: conversion.programId,
    actorType: "ADMIN",
    actorId: adminId,
    action: "conversion.refund",
    targetType: "Conversion",
    targetId: conversionId,
    metadata: {
      externalOrderId: conversion.externalOrderId,
      refundAmountCents: input.amountCents,
      refundedTotalCents: result.conversion.refundedCents,
      reason: input.reason.trim(),
    },
  });
  return result;
}
