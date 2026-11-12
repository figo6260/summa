import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { generatePayouts } from "@/lib/payouts";
import { getSingleProgram } from "@/lib/services";
import { pageMessages } from "@/lib/page-i18n";
import type { Messages } from "@/lib/i18n";
import AdminNav from "../admin-nav";
import StatusBadge from "../../status-badge";

async function generateAction() {
  "use server";
  const session = await requireAdmin();
  await generatePayouts(prisma, new Date(), {
    type: "ADMIN",
    id: session.sub,
  });
  redirect("/admin/payouts?generated=1");
}

function statusLabel(m: Messages, status: string): string {
  if (status === "PAID") return m.payouts.statusPaid;
  if (status === "FAILED") return m.payouts.statusFailed;
  return m.payouts.statusPending;
}

export default async function AdminPayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ generated?: string }>;
}) {
  await requireAdmin();
  const m = await pageMessages();
  const { generated } = await searchParams;
  const program = await getSingleProgram(prisma);
  const payouts = program
    ? await prisma.payout.findMany({
        where: { programId: program.id },
        orderBy: { createdAt: "desc" },
        include: { affiliate: { select: { email: true, name: true } } },
      })
    : [];

  return (
    <main className="panel wide">
      <AdminNav />
      <h1>{m.payouts.title}</h1>
      <p>{m.payouts.intro}</p>

      {generated ? <p className="ok">{m.payouts.generated}</p> : null}

      <form action={generateAction} className="form inline">
        <button type="submit">{m.payouts.generate}</button>
      </form>
      <p>
        <a href="/admin/payouts/export">{m.payouts.exportList}</a>
      </p>

      {payouts.length === 0 ? (
        <p>{m.payouts.empty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{m.payouts.affiliate}</th>
              <th>{m.payouts.period}</th>
              <th className="num">{m.payouts.gross}</th>
              <th className="num">{m.payouts.debtOffset}</th>
              <th className="num">{m.payouts.total}</th>
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
                <td>{payout.affiliate.email}</td>
                <td>
                  {payout.periodStart.toISOString().slice(0, 10)} –{" "}
                  {payout.periodEnd.toISOString().slice(0, 10)}
                </td>
                <td className="num">
                  {payout.grossCents.toLocaleString()} {payout.currency}
                </td>
                <td className="num">
                  {payout.debtOffsetCents.toLocaleString()} {payout.currency}
                </td>
                <td className="num">
                  {payout.totalCents.toLocaleString()} {payout.currency}
                </td>
                <td><StatusBadge status={payout.status} label={statusLabel(m, payout.status)} /></td>
                <td>{payout.method ?? "—"}</td>
                <td>{payout.externalRef ?? "—"}</td>
                <td>
                  {payout.paidAt
                    ? payout.paidAt.toISOString().slice(0, 10)
                    : "—"}
                </td>
                <td>
                  <Link href={`/admin/payouts/${payout.id}`}>
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
