import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAffiliate } from "@/lib/auth";
import { pageMessages } from "@/lib/page-i18n";
import type { Messages } from "@/lib/i18n";
import AffiliateNav from "../affiliate-nav";

function statusLabel(m: Messages, status: string): string {
  if (status === "PAID") return m.payouts.statusPaid;
  if (status === "FAILED") return m.payouts.statusFailed;
  return m.payouts.statusPending;
}

export default async function AffiliatePayoutsPage() {
  const session = await requireAffiliate();
  const m = await pageMessages();
  const affiliate = await prisma.affiliate.findUnique({
    where: { id: session.sub },
  });
  if (!affiliate || affiliate.status !== "ACTIVE") notFound();
  const payouts = await prisma.payout.findMany({
    where: { affiliateId: affiliate.id },
    orderBy: { createdAt: "desc" },
  });

  return (
    <main className="panel wide">
      <AffiliateNav email={affiliate.email} />
      <h1>{m.affiliatePayouts.title}</h1>
      <p>{m.affiliatePayouts.intro}</p>
      {payouts.length === 0 ? (
        <p>{m.affiliatePayouts.empty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{m.payouts.period}</th>
              <th>{m.payouts.gross}</th>
              <th>{m.payouts.debtOffset}</th>
              <th>{m.payouts.total}</th>
              <th>{m.payouts.status}</th>
              <th>{m.payouts.method}</th>
              <th>{m.payouts.externalRef}</th>
              <th>{m.payouts.paidAt}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {payouts.map((payout) => (
              <tr key={payout.id}>
                <td>
                  {payout.periodStart.toISOString().slice(0, 10)} –{" "}
                  {payout.periodEnd.toISOString().slice(0, 10)}
                </td>
                <td>
                  {payout.grossCents.toLocaleString()} {payout.currency}
                </td>
                <td>
                  {payout.debtOffsetCents.toLocaleString()} {payout.currency}
                </td>
                <td>
                  {payout.totalCents.toLocaleString()} {payout.currency}
                </td>
                <td>{statusLabel(m, payout.status)}</td>
                <td>
                  {payout.method ? m.payoutMethods[payout.method] : "—"}
                </td>
                <td>{payout.externalRef ?? "—"}</td>
                <td>
                  {payout.paidAt
                    ? payout.paidAt.toISOString().slice(0, 10)
                    : "—"}
                </td>
                <td>
                  <Link href={`/affiliate/payouts/${payout.id}`}>
                    {m.payouts.details}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
