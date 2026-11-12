import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getSingleProgram } from "@/lib/services";
import { pageMessages } from "@/lib/page-i18n";
import type { Messages } from "@/lib/i18n";
import AdminNav from "../admin-nav";
import StatusBadge from "../../status-badge";

const PAGE_SIZE = 20;

function fmt(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function conversionStatusLabel(m: Messages, status: string): string {
  if (status === "REFUNDED") return m.conversions.statusRefunded;
  if (status === "CHARGEBACKED") return m.conversions.statusChargebacked;
  return m.conversions.statusConfirmed;
}

export default async function ConversionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    affiliateId?: string;
    status?: string;
    page?: string;
  }>;
}) {
  await requireAdmin();
  const m = await pageMessages();
  const params = await searchParams;
  const program = await getSingleProgram(prisma);
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  const affiliates = program
    ? await prisma.affiliate.findMany({
        where: { programId: program.id },
        orderBy: { name: "asc" },
        select: { id: true, name: true, email: true },
      })
    : [];

  const where: Record<string, unknown> = program
    ? { programId: program.id }
    : { id: "__none__" };
  if (params.affiliateId) where.affiliateId = params.affiliateId;
  if (
    params.status === "CONFIRMED" ||
    params.status === "REFUNDED" ||
    params.status === "CHARGEBACKED"
  ) {
    where.status = params.status;
  }

  const total = await prisma.conversion.count({ where });
  const conversions = await prisma.conversion.findMany({
    where,
    orderBy: { occurredAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    include: {
      affiliate: { select: { name: true, email: true } },
      commission: {
        select: { amountCents: true, reversedCents: true, status: true },
      },
    },
  });
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (nextPage: number) => {
    const q = new URLSearchParams();
    if (params.affiliateId) q.set("affiliateId", params.affiliateId);
    if (params.status) q.set("status", params.status);
    q.set("page", String(nextPage));
    return `/admin/conversions?${q.toString()}`;
  };

  return (
    <main className="panel wide">
      <AdminNav />
      <h1>{m.conversions.title}</h1>
      <p>{m.conversions.intro}</p>
      <form method="get" className="form">
        <label>
          {m.conversions.affiliate}
          <select name="affiliateId" defaultValue={params.affiliateId ?? ""}>
            <option value="">{m.common.all}</option>
            {affiliates.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.email}
              </option>
            ))}
          </select>
        </label>
        <label>
          {m.common.status}
          <select name="status" defaultValue={params.status ?? ""}>
            <option value="">{m.common.all}</option>
            <option value="CONFIRMED">{m.conversions.statusConfirmed}</option>
            <option value="REFUNDED">{m.conversions.statusRefunded}</option>
            <option value="CHARGEBACKED">
              {m.conversions.statusChargebacked}
            </option>
          </select>
        </label>
        <button type="submit">{m.common.filter}</button>
      </form>
      {conversions.length === 0 ? (
        <p>{m.conversions.empty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{m.conversions.occurredAt}</th>
              <th>{m.conversions.order}</th>
              <th>{m.conversions.affiliate}</th>
              <th>{m.conversions.amount}</th>
              <th>{m.common.status}</th>
              <th>{m.conversions.source}</th>
              <th>{m.conversions.commission}</th>
              <th>{m.common.actions}</th>
            </tr>
          </thead>
          <tbody>
            {conversions.map((conversion) => (
              <tr key={conversion.id}>
                <td>{fmt(conversion.occurredAt)}</td>
                <td>{conversion.externalOrderId}</td>
                <td>
                  {conversion.affiliate.name} · {conversion.affiliate.email}
                </td>
                <td>
                  {conversion.amountCents} {conversion.currency}
                  {conversion.isRenewal ? ` · ${m.conversions.renewal}` : ""}
                  {conversion.refundedCents > 0
                    ? ` · ${m.conversions.refundedAmount} ${conversion.refundedCents}`
                    : ""}
                </td>
                <td><StatusBadge status={conversion.status} label={conversionStatusLabel(m, conversion.status)} /></td>
                <td>{conversion.source}</td>
                <td>
                  {conversion.commission
                    ? `${conversion.commission.amountCents - conversion.commission.reversedCents} · ${conversion.commission.status}`
                    : m.common.none}
                </td>
                <td>
                  <Link href={`/admin/conversions/${conversion.id}`}>
                    {m.conversions.detail}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        {page > 1 ? <Link href={qs(page - 1)}>{m.common.prev}</Link> : null}{" "}
        {m.common.page} {page} / {pageCount}{" "}
        {page < pageCount ? (
          <Link href={qs(page + 1)}>{m.common.next}</Link>
        ) : null}
      </p>
    </main>
  );
}
