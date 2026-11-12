import type { Payout, PayoutMethod, PrismaClient } from "@prisma/client";
import { writeAudit } from "./audit";
import { effectiveCommissionCents, getAffiliateBalance } from "./balance";
import { sendPayoutPaidEmail } from "./mailer";

/**
 * Payout settlement (M5).
 *
 * Settlement rule (decided 2026-11-12): generating a settlement sweeps
 * ALL of an affiliate's currently AVAILABLE commissions into one
 * payout — no calendar-month slicing. The program's payout day only
 * decides when the operator runs generation; the period recorded on
 * the payout is the generation month (periodStart = the 1st,
 * periodEnd = the generation instant).
 *
 * A payout carries three money figures:
 *   grossCents      = Σ effective amounts of the commissions swept in
 *   debtOffsetCents = the share of gross that repays old clawback debt
 *   totalCents      = grossCents - debtOffsetCents (the cash paid out)
 *
 * Debt is only *booked* against the balance while a payout is pending:
 * generation reserves the commissions (payoutId set, status stays
 * AVAILABLE) and marking the payout PAID is what actually settles the
 * debt (debt-source commissions get debtSettledCents raised to their
 * reversedCents). Marking FAILED hands the commissions back to the
 * available pool untouched, debt included.
 *
 * Amounts always come from getAffiliateBalance (the one balance
 * formula); an affiliate with a PENDING payout is skipped so reserved
 * commissions can never be counted twice.
 */

export interface PayoutActor {
  type: "ADMIN" | "SYSTEM";
  id: string | null;
}

export interface GeneratePayoutsResult {
  payouts: Payout[];
  count: number;
}

const PAYOUT_METHODS: PayoutMethod[] = [
  "MANUAL",
  "BANK_TRANSFER",
  "PAYPAL",
  "WISE",
  "OTHER",
];

export async function generatePayouts(
  db: PrismaClient,
  now: Date = new Date(),
  actor: PayoutActor,
): Promise<GeneratePayoutsResult> {
  const created: Payout[] = [];
  const programs = await db.program.findMany({ orderBy: { createdAt: "asc" } });

  for (const program of programs) {
    const affiliates = await db.affiliate.findMany({
      where: { programId: program.id, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
    });
    for (const affiliate of affiliates) {
      // A pending payout already reserves this affiliate's available
      // pool; generating again would double-count it.
      const pending = await db.payout.findFirst({
        where: {
          programId: program.id,
          affiliateId: affiliate.id,
          status: "PENDING",
        },
        select: { id: true },
      });
      if (pending) continue;

      const candidates = await db.commission.findMany({
        where: { affiliateId: affiliate.id, status: "AVAILABLE", payoutId: null },
        orderBy: { createdAt: "asc" },
      });
      if (candidates.length === 0) continue;

      const balance = await getAffiliateBalance(db, affiliate.id);
      const payable = balance.payableCents;
      if (payable <= 0) continue;
      if (program.minPayoutCents > 0 && payable < program.minPayoutCents) {
        continue;
      }

      const grossCents = candidates.reduce(
        (sum, commission) => sum + effectiveCommissionCents(commission),
        0,
      );
      const debtOffsetCents = grossCents - payable;
      const periodStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );

      const payout = await db.$transaction(async (tx) => {
        const row = await tx.payout.create({
          data: {
            programId: program.id,
            affiliateId: affiliate.id,
            periodStart,
            periodEnd: now,
            grossCents,
            debtOffsetCents,
            totalCents: payable,
            currency: program.currency,
            status: "PENDING",
            method: affiliate.payoutMethod,
          },
        });
        const reserved = await tx.commission.updateMany({
          where: {
            id: { in: candidates.map((c) => c.id) },
            status: "AVAILABLE",
            payoutId: null,
          },
          data: { payoutId: row.id },
        });
        if (reserved.count !== candidates.length) {
          throw new Error("payout_reservation_conflict");
        }
        // The gross figure already nets out these commissions' own
        // clawed-back shares, so mark that share as settled right away:
        // it must never resurface as "debt" once the payout reserves
        // them (the balance formula counts reversedCents of paid-out
        // commissions as debt, minus what has been settled).
        for (const commission of candidates) {
          if (commission.reversedCents > commission.debtSettledCents) {
            await tx.commission.update({
              where: { id: commission.id },
              data: { debtSettledCents: commission.reversedCents },
            });
          }
        }
        await writeAudit(tx as unknown as PrismaClient, {
          programId: program.id,
          actorType: actor.type,
          actorId: actor.id,
          action: "payout.generate",
          targetType: "Payout",
          targetId: row.id,
          metadata: {
            affiliateId: affiliate.id,
            grossCents,
            debtOffsetCents,
            totalCents: payable,
            commissionCount: candidates.length,
          },
        });
        return row;
      });
      created.push(payout);
    }
  }
  return { payouts: created, count: created.length };
}

/**
 * Mark a PENDING payout as paid. Method + external reference are
 * mandatory — a payout without a traceable transfer is not "paid".
 * Inside one transaction: commissions flip to PAID, outstanding
 * clawback debt from earlier payouts is settled (debtSettledCents
 * raised to reversedCents on the debt sources), and the payout row is
 * stamped. The affiliate's payout_paid email goes out afterwards and
 * can never roll the payment back.
 */
export async function markPayoutPaid(
  db: PrismaClient,
  actorId: string,
  payoutId: string,
  input: { method: PayoutMethod; externalRef: string },
): Promise<Payout> {
  const externalRef = input.externalRef?.trim() ?? "";
  if (externalRef === "") throw new Error("external_ref_required");
  if (!PAYOUT_METHODS.includes(input.method)) {
    throw new Error("method_invalid");
  }
  const existing = await db.payout.findUnique({ where: { id: payoutId } });
  if (!existing) throw new Error("payout_not_found");
  if (existing.status !== "PENDING") throw new Error("payout_not_pending");

  const { payout, debtSettledCents, debtSources } = await db.$transaction(
    async (tx) => {
      const row = await tx.payout.update({
        where: { id: payoutId },
        data: {
          status: "PAID",
          method: input.method,
          externalRef,
          paidAt: new Date(),
        },
      });
      await tx.commission.updateMany({
        where: { payoutId, status: "AVAILABLE" },
        data: { status: "PAID" },
      });
      // Settle outstanding clawback debt from EARLIER payouts (this
      // payout's own commissions had their reversed shares settled at
      // generation time, when gross was computed).
      const sources = await tx.commission.findMany({
        where: {
          affiliateId: existing.affiliateId,
          payoutId: { not: null },
          NOT: { payoutId },
        },
        select: { id: true, reversedCents: true, debtSettledCents: true },
      });
      let settled = 0;
      for (const source of sources) {
        const outstanding = source.reversedCents - source.debtSettledCents;
        if (outstanding <= 0) continue;
        await tx.commission.update({
          where: { id: source.id },
          data: { debtSettledCents: source.reversedCents },
        });
        settled += outstanding;
      }
      await writeAudit(tx as unknown as PrismaClient, {
        programId: existing.programId,
        actorType: "ADMIN",
        actorId,
        action: "payout.mark_paid",
        targetType: "Payout",
        targetId: payoutId,
        metadata: {
          affiliateId: existing.affiliateId,
          method: input.method,
          externalRef,
          grossCents: existing.grossCents,
          debtOffsetCents: existing.debtOffsetCents,
          totalCents: existing.totalCents,
          debtSettledCents: settled,
          // Normally settled === debtOffsetCents. A mismatch means the
          // outstanding debt moved between generation and payment
          // (e.g. another late refund); actual outstanding debt wins.
          debtSettledAsExpected: settled === existing.debtOffsetCents,
        },
      });
      return { payout: row, debtSettledCents: settled, debtSources: sources.length };
    },
  );

  const affiliate = await db.affiliate.findUnique({
    where: { id: payout.affiliateId },
  });
  const program = await db.program.findUnique({
    where: { id: payout.programId },
    select: { name: true },
  });
  if (affiliate && program) {
    await sendPayoutPaidEmail(db, {
      affiliate,
      programName: program.name,
      payoutId: payout.id,
      totalCents: payout.totalCents,
      currency: payout.currency,
      method: input.method,
      externalRef,
    });
  }
  void debtSettledCents;
  void debtSources;
  return payout;
}

/**
 * Mark a PENDING payout as failed (the transfer did not happen). The
 * reserved commissions return to the available pool (payoutId cleared,
 * status stays AVAILABLE) and the debt is left exactly as it was — it
 * will be offset by whichever payout eventually succeeds.
 */
export async function markPayoutFailed(
  db: PrismaClient,
  actorId: string,
  payoutId: string,
  reason: string,
): Promise<Payout> {
  if (!reason || reason.trim() === "") throw new Error("reason_required");
  const existing = await db.payout.findUnique({ where: { id: payoutId } });
  if (!existing) throw new Error("payout_not_found");
  if (existing.status !== "PENDING") throw new Error("payout_not_pending");
  const trimmed = reason.trim();

  const payout = await db.$transaction(async (tx) => {
    const row = await tx.payout.update({
      where: { id: payoutId },
      data: { status: "FAILED" },
    });
    await tx.commission.updateMany({
      where: { payoutId },
      data: { payoutId: null },
    });
    await writeAudit(tx as unknown as PrismaClient, {
      programId: existing.programId,
      actorType: "ADMIN",
      actorId,
      action: "payout.mark_failed",
      targetType: "Payout",
      targetId: payoutId,
      metadata: { affiliateId: existing.affiliateId, reason: trimmed },
    });
    return row;
  });
  return payout;
}
