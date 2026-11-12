import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAffiliate } from "@/lib/auth";
import {
  effectiveCommissionCents,
  getAffiliateBalance,
} from "@/lib/balance";
import { isPendingReview } from "@/lib/commissions";
import { pageMessages } from "@/lib/page-i18n";
import AffiliateNav from "../affiliate-nav";
import type { Messages } from "@/lib/i18n";

function fmt(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function statusLabel(m: Messages, status: string): string {
  switch (status) {
    case "HOLDING":
      return m.commissions.statusHOLDING;
    case "AVAILABLE":
      return m.commissions.statusAVAILABLE;
    case "PAID":
      return m.commissions.statusPAID;
    case "REJECTED":
      return m.commissions.statusREJECTED;
    case "REVERSED":
      return m.commissions.statusREVERSED;
    default:
      return status;
  }
}

const STATUS_ORDER = ["HOLDING", "AVAILABLE", "PAID", "REJECTED", "REVERSED"];

export default async function AffiliateCommissionsPage() {
  const session = await requireAffiliate();
  const m = await pageMessages();
  const affiliate = await prisma.affiliate.findUnique({
    where: { id: session.sub },
  });
  if (!affiliate || affiliate.status !== "ACTIVE") notFound();

  // The same balance function the admin side (and M5 payouts) uses.
  const balance = await getAffiliateBalance(prisma, affiliate.id);
  const commissions = await prisma.commission.findMany({
    where: { affiliateId: affiliate.id },
    orderBy: { createdAt: "desc" },
    include: {
      conversion: {
        select: {
          externalOrderId: true,
          amountCents: true,
          occurredAt: true,
          isRenewal: true,
        },
      },
    },
  });
  const currency = balance.currency;

  return (
    <main className="panel wide">
      <AffiliateNav email={affiliate.email} />
      <h1>{m.affiliateCommissions.title}</h1>
      <p>{m.affiliateCommissions.intro}</p>

      <table className="table">
        <tbody>
          <tr>
            <th>{m.affiliateCommissions.balanceHolding}</th>
            <td>
              {balance.holdingCents} {currency}
            </td>
          </tr>
          <tr>
            <th>{m.affiliateCommissions.balanceAvailable}</th>
            <td>
              {balance.availableBalanceCents} {currency}
            </td>
          </tr>
          {balance.availableBalanceCents < 0 ? (
            <tr>
              <th>{m.affiliateCommissions.balanceDebt}</th>
              <td className="error">
                {-balance.availableBalanceCents} {currency}
              </td>
            </tr>
          ) : null}
          <tr>
            <th>{m.affiliateCommissions.balancePayable}</th>
            <td>
              {balance.payableCents} {currency}
            </td>
          </tr>
          <tr>
            <th>{m.affiliateCommissions.balancePaid}</th>
            <td>
              {balance.paidNetCents} {currency}
            </td>
          </tr>
          <tr>
            <th>{m.affiliateCommissions.balanceReversed}</th>
            <td>
              {balance.reversedCentsTotal} {currency}
            </td>
          </tr>
        </tbody>
      </table>

      {commissions.length === 0 ? (
        <p>{m.affiliateCommissions.empty}</p>
      ) : (
        STATUS_ORDER.map((status) => {
          const group = commissions.filter((c) => c.status === status);
          if (group.length === 0) return null;
          const total = group.reduce(
            (sum, c) => sum + effectiveCommissionCents(c),
            0,
          );
          return (
            <section key={status}>
              <h2>
                {statusLabel(m, status)} · {m.affiliateCommissions.groupTotal}{" "}
                {total} {currency}
              </h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>{m.affiliateCommissions.order}</th>
                    <th>{m.affiliateCommissions.date}</th>
                    <th>{m.affiliateCommissions.conversionAmount}</th>
                    <th>{m.affiliateCommissions.commission}</th>
                    <th>{m.affiliateCommissions.holdUntil}</th>
                    <th>{m.affiliateCommissions.reason}</th>
                  </tr>
                </thead>
                <tbody>
                  {group.map((commission) => (
                    <tr key={commission.id}>
                      <td>
                        {commission.conversion.externalOrderId}{" "}
                        {commission.conversion.isRenewal
                          ? `· ${m.affiliateCommissions.renewal}`
                          : `· ${m.affiliateCommissions.firstOrder}`}
                      </td>
                      <td>{fmt(commission.conversion.occurredAt)}</td>
                      <td>
                        {commission.conversion.amountCents}{" "}
                        {commission.currency}
                      </td>
                      <td>
                        {commission.amountCents}
                        {commission.reversedCents > 0
                          ? ` − ${commission.reversedCents} = ${effectiveCommissionCents(commission)}`
                          : ""}{" "}
                        {commission.currency}
                        {isPendingReview(commission)
                          ? ` · ${m.commissions.pendingReview}`
                          : ""}
                      </td>
                      <td>
                        {commission.status === "HOLDING"
                          ? fmt(commission.holdUntil)
                          : m.common.none}
                      </td>
                      <td>
                        {isPendingReview(commission)
                          ? m.commissions.pendingReview
                          : (commission.statusReason ?? m.common.none)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })
      )}
    </main>
  );
}
