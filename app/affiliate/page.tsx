import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAffiliate } from "@/lib/auth";
import { effectiveCommissionCents, getAffiliateBalance } from "@/lib/balance";
import { pageMessages } from "@/lib/page-i18n";
import AffiliateNav from "./affiliate-nav";

export default async function AffiliateDashboardPage() {
  const session = await requireAffiliate();
  const m = await pageMessages();
  const affiliate = await prisma.affiliate.findUnique({
    where: { id: session.sub },
  });
  if (!affiliate || affiliate.status !== "ACTIVE") notFound();

  const [clicks, conversionCount, commissions, balance, recentPayouts] =
    await Promise.all([
      prisma.click.count({
        where: { link: { affiliateId: affiliate.id } },
      }),
      prisma.conversion.count({ where: { affiliateId: affiliate.id } }),
      prisma.commission.findMany({
        where: { affiliateId: affiliate.id },
        orderBy: { createdAt: "desc" },
        include: { conversion: { select: { externalOrderId: true } } },
      }),
      getAffiliateBalance(prisma, affiliate.id),
      prisma.payout.findMany({
        where: { affiliateId: affiliate.id },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
    ]);

  const commissionTotal = commissions
    .filter((commission) => commission.status !== "REJECTED")
    .reduce((sum, commission) => sum + effectiveCommissionCents(commission), 0);
  const recentCommissions = commissions.slice(0, 5);
  const currency = commissions[0]?.currency ?? "USD";

  return (
    <main className="panel wide">
      <AffiliateNav email={affiliate.email} />
      <h1>{m.affiliateDashboard.title}</h1>
      <p>{m.affiliateDashboard.intro}</p>

      <section className="statgrid">
        <div className="statcard">
          <span className="statlabel">{m.affiliateDashboard.totalClicks}</span>
          <strong>{clicks}</strong>
        </div>
        <div className="statcard">
          <span className="statlabel">{m.affiliateDashboard.conversions}</span>
          <strong>{conversionCount}</strong>
        </div>
        <div className="statcard">
          <span className="statlabel">
            {m.affiliateDashboard.commissionTotal}
          </span>
          <strong>
            {commissionTotal.toLocaleString()} {currency}
          </strong>
        </div>
        <div className="statcard">
          <span className="statlabel">{m.affiliateDashboard.payable}</span>
          <strong>
            {balance.payableCents.toLocaleString()} {currency}
          </strong>
        </div>
      </section>

      <h2>{m.affiliateDashboard.recentCommissions}</h2>
      {recentCommissions.length === 0 ? (
        <p>{m.affiliateDashboard.noCommissions}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{m.affiliateCommissions.order}</th>
              <th>{m.affiliateCommissions.commission}</th>
              <th>{m.common.status}</th>
              <th>{m.affiliateCommissions.date}</th>
            </tr>
          </thead>
          <tbody>
            {recentCommissions.map((commission) => (
              <tr key={commission.id}>
                <td>{commission.conversion?.externalOrderId ?? "—"}</td>
                <td>
                  {effectiveCommissionCents(commission).toLocaleString()}{" "}
                  {commission.currency}
                </td>
                <td>{commission.status}</td>
                <td>{commission.createdAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        <Link href="/affiliate/commissions">
          {m.affiliateDashboard.viewCommissions}
        </Link>
      </p>

      <h2>{m.affiliateDashboard.recentPayouts}</h2>
      {recentPayouts.length === 0 ? (
        <p>{m.affiliateDashboard.noPayouts}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{m.payouts.period}</th>
              <th>{m.payouts.total}</th>
              <th>{m.payouts.status}</th>
              <th>{m.payouts.paidAt}</th>
            </tr>
          </thead>
          <tbody>
            {recentPayouts.map((payout) => (
              <tr key={payout.id}>
                <td>
                  {payout.periodStart.toISOString().slice(0, 10)} –{" "}
                  {payout.periodEnd.toISOString().slice(0, 10)}
                </td>
                <td>
                  {payout.totalCents.toLocaleString()} {payout.currency}
                </td>
                <td>{payout.status}</td>
                <td>
                  {payout.paidAt
                    ? payout.paidAt.toISOString().slice(0, 10)
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        <Link href="/affiliate/payouts">{m.affiliateDashboard.viewPayouts}</Link>
      </p>
    </main>
  );
}
