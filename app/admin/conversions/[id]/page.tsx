import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { adjustConversion } from "@/lib/conversion";
import { registerRefundByAdmin } from "@/lib/reversal";
import { effectiveCommissionCents } from "@/lib/balance";
import { pageMessages } from "@/lib/page-i18n";
import type { Messages } from "@/lib/i18n";
import AdminNav from "../../admin-nav";

function conversionStatusLabel(m: Messages, status: string): string {
  if (status === "REFUNDED") return m.conversions.statusRefunded;
  if (status === "CHARGEBACKED") return m.conversions.statusChargebacked;
  return m.conversions.statusConfirmed;
}

function fmt(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

async function adjustAction(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const amountRaw = String(formData.get("amountCents") ?? "");
  const affiliateId = String(formData.get("affiliateId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  try {
    await adjustConversion(prisma, session.sub, id, {
      amountCents: amountRaw === "" ? undefined : Number(amountRaw),
      affiliateId: affiliateId === "" ? undefined : affiliateId,
      reason,
    });
  } catch {
    redirect(`/admin/conversions/${id}?error=adjust`);
  }
  redirect(`/admin/conversions/${id}?saved=adjust`);
}

async function refundAction(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const amountRaw = String(formData.get("amountCents") ?? "");
  const reason = String(formData.get("reason") ?? "");
  try {
    await registerRefundByAdmin(prisma, session.sub, id, {
      amountCents: Number(amountRaw),
      reason,
    });
  } catch {
    redirect(`/admin/conversions/${id}?error=refund`);
  }
  redirect(`/admin/conversions/${id}?saved=refund`);
}

export default async function ConversionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  await requireAdmin();
  const m = await pageMessages();
  const { id } = await params;
  const { saved, error } = await searchParams;
  const conversion = await prisma.conversion.findUnique({
    where: { id },
    include: {
      affiliate: { select: { id: true, name: true, email: true } },
      commission: true,
    },
  });
  if (!conversion) notFound();
  const affiliates = await prisma.affiliate.findMany({
    where: { programId: conversion.programId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true },
  });
  const adjustable =
    conversion.commission !== null &&
    conversion.commission.status === "HOLDING";

  return (
    <main className="panel wide">
      <AdminNav />
      <h1>{m.conversions.detailTitle}</h1>
      <p>
        <Link href="/admin/conversions">{m.conversions.backToList}</Link>
      </p>
      {saved === "adjust" ? (
        <p className="ok">{m.conversions.adjustSaved}</p>
      ) : null}
      {saved === "refund" ? (
        <p className="ok">{m.conversions.refundSaved}</p>
      ) : null}
      {error === "adjust" ? (
        <p className="error">{m.conversions.adjustError}</p>
      ) : null}
      {error === "refund" ? (
        <p className="error">{m.conversions.refundError}</p>
      ) : null}
      <table className="table">
        <tbody>
          <tr>
            <th>{m.conversions.order}</th>
            <td>{conversion.externalOrderId}</td>
          </tr>
          <tr>
            <th>{m.conversions.affiliate}</th>
            <td>
              {conversion.affiliate.name} · {conversion.affiliate.email}
            </td>
          </tr>
          <tr>
            <th>{m.conversions.amount}</th>
            <td>
              {conversion.amountCents} {conversion.currency}
            </td>
          </tr>
          <tr>
            <th>{m.common.status}</th>
            <td>{conversionStatusLabel(m, conversion.status)}</td>
          </tr>
          <tr>
            <th>{m.conversions.kind}</th>
            <td>
              {conversion.isRenewal
                ? m.conversions.renewal
                : m.conversions.firstOrder}
            </td>
          </tr>
          <tr>
            <th>{m.conversions.refundedAmount}</th>
            <td>
              {conversion.refundedCents} {conversion.currency}
            </td>
          </tr>
          <tr>
            <th>{m.conversions.source}</th>
            <td>{conversion.source}</td>
          </tr>
          <tr>
            <th>{m.conversions.customerRef}</th>
            <td>{conversion.customerRef ?? m.common.none}</td>
          </tr>
          <tr>
            <th>{m.conversions.idempotencyKey}</th>
            <td>
              <code>{conversion.idempotencyKey}</code>
            </td>
          </tr>
          <tr>
            <th>{m.conversions.occurredAt}</th>
            <td>{fmt(conversion.occurredAt)}</td>
          </tr>
          <tr>
            <th>{m.conversions.commission}</th>
            <td>
              {conversion.commission
                ? `${conversion.commission.amountCents} ${conversion.commission.currency} · ${conversion.commission.status}`
                : m.common.none}
            </td>
          </tr>
          {conversion.commission ? (
            <tr>
              <th>{m.conversions.commissionReversed}</th>
              <td>
                {conversion.commission.reversedCents}{" "}
                {conversion.commission.currency}
              </td>
            </tr>
          ) : null}
          {conversion.commission ? (
            <tr>
              <th>{m.conversions.commissionEffective}</th>
              <td>
                {effectiveCommissionCents(conversion.commission)}{" "}
                {conversion.commission.currency}
              </td>
            </tr>
          ) : null}
          {conversion.commission ? (
            <tr>
              <th>{m.conversions.holdUntil}</th>
              <td>{fmt(conversion.commission.holdUntil)}</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <h2>{m.conversions.adjustTitle}</h2>
      <p>{m.conversions.adjustIntro}</p>
      {adjustable ? (
        <form action={adjustAction} className="form">
          <input type="hidden" name="id" value={conversion.id} />
          <label>
            {m.conversions.adjustAmount}
            <input
              name="amountCents"
              type="number"
              min={1}
              defaultValue={conversion.amountCents}
              required
            />
          </label>
          <label>
            {m.conversions.adjustAffiliate}
            <select name="affiliateId" defaultValue={conversion.affiliateId}>
              {affiliates.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.email}
                </option>
              ))}
            </select>
          </label>
          <label>
            {m.conversions.adjustReason}
            <input name="reason" required maxLength={200} />
          </label>
          <button type="submit">{m.conversions.adjustSubmit}</button>
        </form>
      ) : (
        <p>{m.conversions.adjustDisabledNote}</p>
      )}

      <h2>{m.conversions.refundTitle}</h2>
      <p>{m.conversions.refundIntro}</p>
      <form action={refundAction} className="form">
        <input type="hidden" name="id" value={conversion.id} />
        <label>
          {m.conversions.refundAmount}
          <input
            name="amountCents"
            type="number"
            min={1}
            defaultValue={Math.max(
              0,
              conversion.amountCents - conversion.refundedCents,
            )}
            required
          />
        </label>
        <label>
          {m.conversions.refundReason}
          <input name="reason" required maxLength={200} />
        </label>
        <button type="submit">{m.conversions.refundSubmit}</button>
      </form>
    </main>
  );
}
