import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAffiliate } from "@/lib/auth";
import { effectiveCommissionCents } from "@/lib/balance";
import { pageMessages } from "@/lib/page-i18n";
import AffiliateNav from "../../affiliate-nav";
import StatusBadge from "../../../status-badge";

export default async function AffiliatePayoutDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireAffiliate();
  const m = await pageMessages();
  const { id } = await params;
  const affiliate = await prisma.affiliate.findUnique({
    where: { id: session.sub },
  });
  if (!affiliate || affiliate.status !== "ACTIVE") notFound();
  const payout = await prisma.payout.findUnique({ where: { id } });
  // Ownership check: another affiliate's payout is indistinguishable
  // from a missing one.
  if (!payout || payout.affiliateId !== affiliate.id) notFound();
  const commissions = await prisma.commission.findMany({
    where: { payoutId: id },
    orderBy: { createdAt: "asc" },
    include: {
      conversion: {
        select: { externalOrderId: true, amountCents: true, createdAt: true },
      },
    },
  });

  return (
    <main className="panel wide">
      <AffiliateNav email={affiliate.email} />
      <p>
        <Link href="/affiliate/payouts">{m.payouts.backToList}</Link>
      </p>
      <h1>{m.affiliatePayouts.detailTitle}</h1>
      <table className="table">
        <tbody>
          <tr>
            <th>{m.payouts.period}</th>
            <td>
              {payout.periodStart.toISOString().slice(0, 10)} –{" "}
              {payout.periodEnd.toISOString().slice(0, 10)}
            </td>
          </tr>
          <tr>
            <th>{m.payouts.gross}</th>
            <td>
              {payout.grossCents.toLocaleString()} {payout.currency}
            </td>
          </tr>
          <tr>
            <th>{m.payouts.debtOffset}</th>
            <td>
              {payout.debtOffsetCents.toLocaleString()} {payout.currency}
            </td>
          </tr>
          <tr>
            <th>{m.payouts.total}</th>
            <td>
              {payout.totalCents.toLocaleString()} {payout.currency}
            </td>
          </tr>
          <tr>
            <th>{m.payouts.status}</th>
            <td><StatusBadge status={payout.status} label={payout.status} /></td>
          </tr>
          <tr>
            <th>{m.payouts.method}</th>
            <td>{payout.method ? m.payoutMethods[payout.method] : "—"}</td>
          </tr>
          <tr>
            <th>{m.payouts.externalRef}</th>
            <td>{payout.externalRef ?? "—"}</td>
          </tr>
          <tr>
            <th>{m.payouts.paidAt}</th>
            <td>
              {payout.paidAt ? payout.paidAt.toISOString().slice(0, 16) : "—"}
            </td>
          </tr>
        </tbody>
      </table>

      <h2>{m.payouts.commissionsTitle}</h2>
      {commissions.length === 0 ? (
        <p>{m.payouts.commissionsEmpty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{m.payouts.orderId}</th>
              <th>{m.payouts.conversionDate}</th>
              <th>{m.payouts.orderAmount}</th>
              <th>{m.payouts.commissionAmount}</th>
              <th>{m.payouts.commissionStatus}</th>
            </tr>
          </thead>
          <tbody>
            {commissions.map((commission) => (
              <tr key={commission.id}>
                <td>{commission.conversion?.externalOrderId ?? "—"}</td>
                <td>
                  {commission.conversion
                    ? commission.conversion.createdAt
                        .toISOString()
                        .slice(0, 10)
                    : "—"}
                </td>
                <td>
                  {commission.conversion
                    ? `${commission.conversion.amountCents.toLocaleString()} ${commission.currency}`
                    : "—"}
                </td>
                <td>
                  {effectiveCommissionCents(commission).toLocaleString()}{" "}
                  {commission.currency}
                </td>
                <td><StatusBadge status={commission.status} label={commission.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
