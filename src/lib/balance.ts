import type { PrismaClient } from "@prisma/client";

/**
 * The affiliate balance — the ONE formula every money figure in Summa
 * traces back to (M4). Admin pages, the affiliate portal and the M5
 * payout run all call getAffiliateBalance; nobody recomputes locally.
 *
 * A commission's EFFECTIVE amount is `amountCents - reversedCents`
 * (refunds claw back cumulatively, see src/lib/reversal.ts). With that:
 *
 *   holdingCents        = Σ effective(HOLDING)
 *   availableGrossCents = Σ effective(AVAILABLE)
 *   paidNetCents        = Σ effective(PAID)
 *   grossDebtCents      = Σ (reversedCents - debtSettledCents) over
 *                         commissions that were already paid out
 *                         (payoutId set): that money left the building
 *                         and was then clawed back, so the affiliate
 *                         owes it back — minus the share a later
 *                         payout has already settled (M5 raises
 *                         debtSettledCents when the debt is repaid, so
 *                         settled debt never double-counts).
 *   availableBalanceCents = availableGrossCents - grossDebtCents
 *                         → MAY BE NEGATIVE (the affiliate is in debt).
 *   payableCents        = max(0, availableBalanceCents)
 *
 * Netting is purely derivational — nothing is moved or rewritten when a
 * new commission matures: it lands in AVAILABLE, raises
 * availableGrossCents, and the balance figure automatically absorbs the
 * debt first. M5 payout generation MUST build on payableCents /
 * availableBalanceCents from this function (and respect the program's
 * minPayoutCents), never on a hand-rolled sum.
 */

export interface AffiliateBalance {
  affiliateId: string;
  programId: string;
  currency: string;
  /** Σ effective HOLDING commissions (still frozen). */
  holdingCents: number;
  /** Σ effective AVAILABLE commissions, before debt netting. */
  availableGrossCents: number;
  /** Outstanding clawback debt: Σ (reversedCents - debtSettledCents)
   *  on commissions that had already been paid out. */
  grossDebtCents: number;
  /** availableGrossCents - grossDebtCents; negative means debt. */
  availableBalanceCents: number;
  /** What a payout could actually pay right now: max(0, balance). */
  payableCents: number;
  /** Σ effective PAID commissions (money the affiliate kept). */
  paidNetCents: number;
  /** Σ gross amounts of REJECTED commissions (never owed). */
  rejectedCents: number;
  /** Σ reversedCents across all of the affiliate's commissions. */
  reversedCentsTotal: number;
}

/** The amount of a commission that is still real money. */
export function effectiveCommissionCents(commission: {
  amountCents: number;
  reversedCents: number;
}): number {
  return commission.amountCents - commission.reversedCents;
}

export async function getAffiliateBalance(
  db: PrismaClient,
  affiliateId: string,
): Promise<AffiliateBalance> {
  const affiliate = await db.affiliate.findUnique({
    where: { id: affiliateId },
    select: { programId: true, program: { select: { currency: true } } },
  });
  if (!affiliate) throw new Error("affiliate_not_found");

  const commissions = await db.commission.findMany({
    where: { affiliateId },
    select: {
      status: true,
      amountCents: true,
      reversedCents: true,
      debtSettledCents: true,
      payoutId: true,
    },
  });

  let holdingCents = 0;
  let availableGrossCents = 0;
  let paidNetCents = 0;
  let rejectedCents = 0;
  let reversedCentsTotal = 0;
  let grossDebtCents = 0;

  for (const commission of commissions) {
    const effective = effectiveCommissionCents(commission);
    reversedCentsTotal += commission.reversedCents;
    // Money already paid out and later clawed back is debt, whatever
    // status the commission ended in (PAID partial or REVERSED full) —
    // net of what a later payout has already settled (M5).
    if (commission.payoutId) {
      grossDebtCents +=
        commission.reversedCents - commission.debtSettledCents;
    }
    switch (commission.status) {
      case "HOLDING":
        holdingCents += effective;
        break;
      case "AVAILABLE":
        availableGrossCents += effective;
        break;
      case "PAID":
        paidNetCents += effective;
        break;
      case "REJECTED":
        rejectedCents += commission.amountCents;
        break;
      case "REVERSED":
        // Fully clawed back: contributes nothing but its reversedCents
        // (already counted above, incl. the debt share when paid out).
        break;
    }
  }

  const availableBalanceCents = availableGrossCents - grossDebtCents;
  return {
    affiliateId,
    programId: affiliate.programId,
    currency: affiliate.program.currency,
    holdingCents,
    availableGrossCents,
    grossDebtCents,
    availableBalanceCents,
    payableCents: Math.max(0, availableBalanceCents),
    paidNetCents,
    rejectedCents,
    reversedCentsTotal,
  };
}
