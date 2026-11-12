import type { Commission, Conversion, PrismaClient } from "@prisma/client";
import {
  resolveAttributionByToken,
  resolveDiscountCode,
} from "./attribution";
import { writeAudit } from "./audit";
import { listConversionHooks } from "./pipeline-hooks";
import type { ConversionContext } from "./extensions/conversion-hooks";

/**
 * M3 conversion pipeline — the single path every conversion takes,
 * whether it arrives through the S2S API or a payment adapter webhook.
 *
 * Rules (decided 2026-11-12, also in docs/milestone.md M3):
 *
 * 1. Attribution priority: a discount code beats a visitor token (the
 *    code is an explicit checkout act; the token is passive). If the
 *    code does not resolve, the token still gets its chance. If neither
 *    resolves to an affiliate of this program, the conversion is
 *    REFUSED (S2S answers 422 `unattributed`) and nothing is written.
 * 2. Idempotency is a hard floor: (programId, idempotencyKey) and
 *    (programId, externalOrderId) are both unique. A repeat delivery —
 *    sequential or concurrent — returns the existing record flagged
 *    `duplicate` and never creates a second commission.
 * 3. The commission is born with the conversion (M3/M4 boundary):
 *    amount = amountCents × program.commissionRateBps / 10000, rounded
 *    with the program's commissionRounding mode (default FLOOR, which
 *    keeps the $24.65 × 15% = $3.69 anchor exact), status HOLDING,
 *    holdUntil = occurredAt + program.holdDays. A `review` hook decision
 *    still records the conversion but stamps the commission statusReason
 *    `pending_review`; M4's review queue (src/lib/commissions.ts) owns
 *    everything after birth: release, review, payout.
 * 4. Refunds/chargebacks are NOT handled here: src/lib/reversal.ts owns
 *    them (cumulative proportional clawback, negative balances via
 *    src/lib/balance.ts).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type ConversionErrorCode = "validation" | "unattributed" | "blocked";

export class ConversionPipelineError extends Error {
  readonly code: ConversionErrorCode;
  readonly reason?: string;

  constructor(code: ConversionErrorCode, reason?: string) {
    super(reason ? `${code}: ${reason}` : code);
    this.code = code;
    this.reason = reason;
  }
}

export interface RecordConversionInput {
  programId: string;
  externalOrderId: string;
  amountCents: number;
  currency: string;
  customerRef?: string | null;
  idempotencyKey: string;
  visitorToken?: string | null;
  discountCode?: string | null;
  /// Subscription renewal payment (M4 marker; same rate as first orders).
  isRenewal?: boolean;
  occurredAt?: Date | null;
  /** "api" (S2S) | "stripe" | … — stored on the conversion row. */
  source: string;
  signals?: Record<string, string | undefined>;
}

export interface RecordConversionResult {
  kind: "created" | "duplicate";
  conversion: Conversion;
  commission: Commission | null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "P2002"
  );
}

export type CommissionRoundingMode = "FLOOR" | "NEAREST" | "CEIL";

/**
 * Commission for an order amount, rounded to whole cents with the
 * program's configured mode. FLOOR (the default) is the historical
 * behaviour: 2465 × 1500bps = 369.75 → 369.
 */
export function computeCommissionCents(
  amountCents: number,
  commissionRateBps: number,
  rounding: CommissionRoundingMode = "FLOOR",
): number {
  const raw = (amountCents * commissionRateBps) / 10000;
  if (rounding === "NEAREST") return Math.round(raw);
  if (rounding === "CEIL") return Math.ceil(raw);
  return Math.floor(raw);
}

async function findExisting(
  db: PrismaClient,
  programId: string,
  idempotencyKey: string,
  externalOrderId: string,
): Promise<RecordConversionResult | null> {
  const byKey = await db.conversion.findUnique({
    where: { programId_idempotencyKey: { programId, idempotencyKey } },
    include: { commission: true },
  });
  if (byKey) {
    const { commission, ...conversion } = byKey;
    return { kind: "duplicate", conversion, commission };
  }
  const byOrder = await db.conversion.findUnique({
    where: { programId_externalOrderId: { programId, externalOrderId } },
    include: { commission: true },
  });
  if (byOrder) {
    const { commission, ...conversion } = byOrder;
    return { kind: "duplicate", conversion, commission };
  }
  return null;
}

export async function recordConversion(
  db: PrismaClient,
  input: RecordConversionInput,
): Promise<RecordConversionResult> {
  // --- validation ---------------------------------------------------------
  if (!input.externalOrderId || input.externalOrderId.trim() === "") {
    throw new ConversionPipelineError("validation", "externalOrderId is required");
  }
  if (!input.idempotencyKey || input.idempotencyKey.trim() === "") {
    throw new ConversionPipelineError("validation", "idempotencyKey is required");
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ConversionPipelineError("validation", "amountCents must be a positive integer");
  }
  if (!/^[A-Za-z]{3}$/.test(input.currency ?? "")) {
    throw new ConversionPipelineError("validation", "currency must be a 3-letter code");
  }
  const currency = input.currency.toUpperCase();
  const occurredAt = input.occurredAt ?? new Date();

  // --- idempotent replay: no hooks, no attribution, no writes --------------
  const replay = await findExisting(
    db,
    input.programId,
    input.idempotencyKey,
    input.externalOrderId,
  );
  if (replay) return replay;

  // --- attribution: discount code first, visitor token as fallback ---------
  let affiliateId: string | null = null;
  let attributionSource: "code" | "link" | null = null;
  if (input.discountCode) {
    const byCode = await resolveDiscountCode(db, input.discountCode);
    if (byCode && byCode.programId === input.programId) {
      affiliateId = byCode.affiliateId;
      attributionSource = "code";
    }
  }
  if (!affiliateId && input.visitorToken) {
    const byToken = await resolveAttributionByToken(db, input.visitorToken);
    if (byToken && byToken.programId === input.programId) {
      affiliateId = byToken.affiliateId;
      attributionSource = "link";
    }
  }
  if (!affiliateId || !attributionSource) {
    throw new ConversionPipelineError("unattributed");
  }

  const program = await db.program.findUnique({
    where: { id: input.programId },
    select: {
      commissionRateBps: true,
      commissionRounding: true,
      holdDays: true,
      isActive: true,
    },
  });
  if (!program || !program.isActive) {
    throw new ConversionPipelineError("unattributed");
  }

  // --- before hooks ----------------------------------------------------------
  const ctx: ConversionContext = {
    programId: input.programId,
    affiliateId,
    externalOrderId: input.externalOrderId,
    customerRef: input.customerRef ?? undefined,
    amountCents: input.amountCents,
    currency,
    source: attributionSource,
    signals: {
      visitorToken: input.visitorToken ?? undefined,
      discountCode: input.discountCode ?? undefined,
      ...input.signals,
    },
  };
  let reviewReason: string | null = null;
  for (const hooks of listConversionHooks()) {
    if (!hooks.beforeConversion) continue;
    const decision = await hooks.beforeConversion(ctx);
    if (decision.action === "block") {
      throw new ConversionPipelineError("blocked", decision.reason);
    }
    if (decision.action === "review" && reviewReason === null) {
      reviewReason = decision.reason;
    }
  }

  // --- record conversion + commission in one transaction ---------------------
  const commissionCents = computeCommissionCents(
    input.amountCents,
    program.commissionRateBps,
    program.commissionRounding,
  );
  const holdUntil = new Date(occurredAt.getTime() + program.holdDays * DAY_MS);
  let created: { conversion: Conversion; commission: Commission };
  try {
    created = await db.$transaction(async (tx) => {
      const conversion = await tx.conversion.create({
        data: {
          programId: input.programId,
          affiliateId: affiliateId as string,
          externalOrderId: input.externalOrderId,
          customerRef: input.customerRef ?? null,
          amountCents: input.amountCents,
          currency,
          isRenewal: input.isRenewal ?? false,
          status: "CONFIRMED",
          idempotencyKey: input.idempotencyKey,
          source: input.source,
          occurredAt,
        },
      });
      const commission = await tx.commission.create({
        data: {
          programId: input.programId,
          affiliateId: affiliateId as string,
          conversionId: conversion.id,
          amountCents: commissionCents,
          currency,
          status: "HOLDING",
          holdUntil,
          statusReason: reviewReason !== null ? "pending_review" : null,
        },
      });
      return { conversion, commission };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // A concurrent delivery won the race: return its record.
      const existing = await findExisting(
        db,
        input.programId,
        input.idempotencyKey,
        input.externalOrderId,
      );
      if (existing) return existing;
    }
    throw error;
  }

  // --- after hooks (best-effort: a reporting hook must not fail the sale) ----
  for (const hooks of listConversionHooks()) {
    if (!hooks.afterConversion) continue;
    try {
      await hooks.afterConversion({ ...ctx, conversionId: created.conversion.id });
    } catch {
      // intentionally swallowed — see note above
    }
  }

  return { kind: "created", conversion: created.conversion, commission: created.commission };
}

// ---------------------------------------------------------------------------
// Manual adjustment (admin, conversion detail page)
// ---------------------------------------------------------------------------

export async function adjustConversion(
  db: PrismaClient,
  actorId: string,
  conversionId: string,
  input: { amountCents?: number; affiliateId?: string; reason: string },
): Promise<Conversion> {
  if (!input.reason || input.reason.trim() === "") {
    throw new Error("reason_required");
  }
  const found = await db.conversion.findUnique({
    where: { id: conversionId },
    include: {
      commission: true,
      program: { select: { commissionRateBps: true, commissionRounding: true } },
    },
  });
  if (!found) throw new Error("conversion_not_found");
  if (!found.commission || found.commission.status !== "HOLDING") {
    throw new Error("commission_not_holding");
  }
  const newAmount = input.amountCents ?? found.amountCents;
  if (!Number.isInteger(newAmount) || newAmount <= 0) {
    throw new Error("amount_invalid");
  }
  const newAffiliateId = input.affiliateId ?? found.affiliateId;
  if (newAffiliateId !== found.affiliateId) {
    const affiliate = await db.affiliate.findUnique({
      where: { id: newAffiliateId },
      select: { programId: true },
    });
    if (!affiliate || affiliate.programId !== found.programId) {
      throw new Error("affiliate_not_found");
    }
  }
  const newCommission = computeCommissionCents(
    newAmount,
    found.program.commissionRateBps,
    found.program.commissionRounding,
  );
  const updated = await db.$transaction(async (tx) => {
    const conversion = await tx.conversion.update({
      where: { id: found.id },
      data: { amountCents: newAmount, affiliateId: newAffiliateId },
    });
    await tx.commission.update({
      where: { id: found.commission!.id },
      data: { amountCents: newCommission, affiliateId: newAffiliateId },
    });
    return conversion;
  });
  await writeAudit(db, {
    programId: found.programId,
    actorType: "ADMIN",
    actorId,
    action: "conversion.adjust",
    targetType: "Conversion",
    targetId: found.id,
    metadata: {
      before: { amountCents: found.amountCents, affiliateId: found.affiliateId },
      after: { amountCents: newAmount, affiliateId: newAffiliateId },
      commissionAfter: newCommission,
      reason: input.reason.trim(),
    },
  });
  return updated;
}
