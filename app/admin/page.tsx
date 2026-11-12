import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { effectiveCommissionCents, getAffiliateBalance } from "@/lib/balance";
import { getSingleProgram } from "@/lib/services";
import { pageMessages } from "@/lib/page-i18n";
import AdminNav from "./admin-nav";
import StatusBadge from "../status-badge";

const STATUSES = ["HOLDING", "AVAILABLE", "PAID", "REJECTED", "REVERSED"] as const;

export default async function AdminDashboardPage() {
  await requireAdmin();
  const m = await pageMessages();
  const program = await getSingleProgram(prisma);

  if (!program) {
    return (
      <main className="panel wide">
        <AdminNav />
        <h1>{m.adminDashboard.title}</h1>
        <p>{m.adminDashboard.noProgram}</p>
      </main>
    );
  }

  const [conversionAgg, commissions, clicks, affiliates, pendingPayouts] =
    await Promise.all([
      prisma.conversion.aggregate({
        where: { programId: program.id },
        _count: { _all: true },
        _sum: { amountCents: true },
      }),
      prisma.commission.findMany({
        where: { programId: program.id },
        select: { status: true, amountCents: true, reversedCents: true },
      }),
      prisma.click.count({ where: { programId: program.id } }),
      prisma.affiliate.findMany({
        where: { programId: program.id },
        select: { id: true, status: true },
      }),
      prisma.payout.findMany({
        where: { programId: program.id, status: "PENDING" },
        select: { totalCents: true },
      }),
    ]);

  const byStatus = new Map<string, number>();
  for (const commission of commissions) {
    byStatus.set(
      commission.status,
      (byStatus.get(commission.status) ?? 0) +
        effectiveCommissionCents(commission),
    );
  }

  let payableTotal = 0;
  for (const affiliate of affiliates) {
    if (affiliate.status !== "ACTIVE") continue;
    const balance = await getAffiliateBalance(prisma, affiliate.id);
    payableTotal += balance.payableCents;
  }

  const pendingTotal = pendingPayouts.reduce((sum, p) => sum + p.totalCents, 0);

  return (
    <main className="panel wide">
      <AdminNav />
      <h1>{m.adminDashboard.title}</h1>

      <section className="statgrid">
        <div className="statcard">
          <span className="statlabel">{m.adminDashboard.conversions}</span>
          <strong>{conversionAgg._count._all}</strong>
          <span>
            {m.adminDashboard.conversionAmount}:{" "}
            {(conversionAgg._sum.amountCents ?? 0).toLocaleString()}{" "}
            {program.currency}
          </span>
        </div>
        <div className="statcard">
          <span className="statlabel">{m.adminDashboard.clicks}</span>
          <strong>{clicks}</strong>
        </div>
        <div className="statcard">
          <span className="statlabel">{m.adminDashboard.affiliates}</span>
          <strong>{affiliates.length}</strong>
        </div>
        <div className="statcard">
          <span className="statlabel">{m.adminDashboard.payableTotal}</span>
          <strong>
            {payableTotal.toLocaleString()} {program.currency}
          </strong>
        </div>
        <div className="statcard">
          <span className="statlabel">{m.adminDashboard.pendingPayouts}</span>
          <strong>{pendingPayouts.length}</strong>
          <span>
            {pendingTotal.toLocaleString()} {program.currency}
          </span>
        </div>
      </section>

      <h2>{m.adminDashboard.byStatusTitle}</h2>
      <table className="table">
        <thead>
          <tr>
            <th>{m.common.status}</th>
            <th className="num">{m.commissions.effective}</th>
          </tr>
        </thead>
        <tbody>
          {STATUSES.map((status) => (
            <tr key={status}>
              <td><StatusBadge status={status} label={m.commissions[`status${status}`]} /></td>
              <td className="num">
                {(byStatus.get(status) ?? 0).toLocaleString()} {program.currency}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
