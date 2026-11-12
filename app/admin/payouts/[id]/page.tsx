import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { PayoutMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { effectiveCommissionCents } from "@/lib/balance";
import { markPayoutFailed, markPayoutPaid } from "@/lib/payouts";
import { pageMessages } from "@/lib/page-i18n";
import AdminNav from "../../admin-nav";

const METHODS: PayoutMethod[] = [
  "MANUAL",
  "BANK_TRANSFER",
  "PAYPAL",
  "WISE",
  "OTHER",
];

async function markPaidAction(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const method = String(formData.get("method") ?? "") as PayoutMethod;
  const externalRef = String(formData.get("externalRef") ?? "");
  if (externalRef.trim() === "") {
    redirect(`/admin/payouts/${id}?error=ref`);
  }
  try {
    await markPayoutPaid(prisma, session.sub, id, { method, externalRef });
  } catch {
    redirect(`/admin/payouts/${id}?error=state`);
  }
  redirect(`/admin/payouts/${id}?paid=1`);
}

async function markFailedAction(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "");
  if (reason.trim() === "") {
    redirect(`/admin/payouts/${id}?error=reason`);
  }
  try {
    await markPayoutFailed(prisma, session.sub, id, reason);
  } catch {
    redirect(`/admin/payouts/${id}?error=state`);
  }
  redirect(`/admin/payouts/${id}?failed=1`);
}

export default async function AdminPayoutDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ paid?: string; failed?: string; error?: string }>;
}) {
  await requireAdmin();
  const m = await pageMessages();
  const { id } = await params;
  const query = await searchParams;
  const payout = await prisma.payout.findUnique({
    where: { id },
    include: { affiliate: { select: { email: true, name: true } } },
  });
  if (!payout) notFound();
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
      <AdminNav />
      <p>
        <Link href="/admin/payouts">{m.payouts.backToList}</Link>
      </p>
      <h1>{m.payouts.detailTitle}</h1>

      {query.paid ? <p className="ok">{m.payouts.markedPaid}</p> : null}
      {query.failed ? <p className="ok">{m.payouts.markedFailed}</p> : null}
      {query.error === "ref" ? (
        <p className="error">{m.payouts.errorRefRequired}</p>
      ) : null}
      {query.error === "reason" ? (
        <p className="error">{m.payouts.errorReasonRequired}</p>
      ) : null}
      {query.error === "state" ? (
        <p className="error">{m.payouts.errorNotPending}</p>
      ) : null}

      <table className="table">
        <tbody>
          <tr>
            <th>{m.payouts.affiliate}</th>
            <td>{payout.affiliate.email}</td>
          </tr>
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
            <td>{payout.status}</td>
          </tr>
          <tr>
            <th>{m.payouts.method}</th>
            <td>{payout.method ?? "—"}</td>
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
      <p>
        <a href={`/admin/payouts/${payout.id}/export`}>
          {m.payouts.exportDetail}
        </a>
      </p>
      {commissions.length === 0 ? (
        <p>{m.payouts.commissionsEmpty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{m.payouts.commissionId}</th>
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
                <td>{commission.id}</td>
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
                <td>{commission.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {payout.status === "PENDING" ? (
        <>
          <h2>{m.payouts.markPaidTitle}</h2>
          <form action={markPaidAction} className="form">
            <input type="hidden" name="id" value={payout.id} />
            <label>
              {m.payouts.method}
              <select name="method" defaultValue={payout.method ?? "MANUAL"}>
                {METHODS.map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {m.payouts.externalRef}
              <input name="externalRef" required />
            </label>
            <button type="submit">{m.payouts.markPaid}</button>
          </form>

          <h2>{m.payouts.markFailedTitle}</h2>
          <form action={markFailedAction} className="form">
            <input type="hidden" name="id" value={payout.id} />
            <label>
              {m.payouts.failReason}
              <input name="reason" required />
            </label>
            <button type="submit">{m.payouts.markFailed}</button>
          </form>
        </>
      ) : null}
    </main>
  );
}
