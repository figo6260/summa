import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getSingleProgram } from "@/lib/services";
import { writeAudit } from "@/lib/audit";
import {
  approveCommissionReview,
  isPendingReview,
  rejectCommission,
  releaseMaturedCommissions,
} from "@/lib/commissions";
import { effectiveCommissionCents } from "@/lib/balance";
import { pageMessages } from "@/lib/page-i18n";
import type { Messages } from "@/lib/i18n";
import AdminNav from "../admin-nav";

const PAGE_SIZE = 20;

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

async function releaseAction() {
  "use server";
  const session = await requireAdmin();
  const program = await getSingleProgram(prisma);
  const result = await releaseMaturedCommissions(prisma, new Date(), {
    trigger: "admin",
    adminId: session.sub,
  });
  if (program) {
    await writeAudit(prisma, {
      programId: program.id,
      actorType: "ADMIN",
      actorId: session.sub,
      action: "commission.release_trigger",
      targetType: "Program",
      targetId: program.id,
      metadata: { releasedCount: result.count },
    });
  }
  redirect(`/admin/commissions?saved=release&released=${result.count}`);
}

async function approveAction(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  try {
    await approveCommissionReview(prisma, session.sub, id);
  } catch {
    redirect("/admin/commissions?error=action");
  }
  redirect("/admin/commissions?saved=approve");
}

async function rejectAction(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "");
  try {
    await rejectCommission(prisma, session.sub, id, reason);
  } catch {
    redirect("/admin/commissions?error=action");
  }
  redirect("/admin/commissions?saved=reject");
}

export default async function CommissionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    affiliateId?: string;
    status?: string;
    review?: string;
    page?: string;
    saved?: string;
    error?: string;
    released?: string;
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
    params.status === "HOLDING" ||
    params.status === "AVAILABLE" ||
    params.status === "PAID" ||
    params.status === "REJECTED" ||
    params.status === "REVERSED"
  ) {
    where.status = params.status;
  }
  if (params.review === "1") {
    where.status = "HOLDING";
    where.statusReason = "pending_review";
  }

  const total = await prisma.commission.count({ where });
  const commissions = await prisma.commission.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    include: {
      affiliate: { select: { name: true, email: true } },
      conversion: { select: { externalOrderId: true } },
    },
  });
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (nextPage: number) => {
    const q = new URLSearchParams();
    if (params.affiliateId) q.set("affiliateId", params.affiliateId);
    if (params.status) q.set("status", params.status);
    if (params.review) q.set("review", params.review);
    q.set("page", String(nextPage));
    return `/admin/commissions?${q.toString()}`;
  };

  return (
    <main className="panel wide">
      <AdminNav />
      <h1>{m.commissions.title}</h1>
      <p>{m.commissions.intro}</p>
      {params.saved === "approve" ? (
        <p className="ok">{m.commissions.savedApprove}</p>
      ) : null}
      {params.saved === "reject" ? (
        <p className="ok">{m.commissions.savedReject}</p>
      ) : null}
      {params.saved === "release" ? (
        <p className="ok">
          {m.commissions.savedRelease} {m.commissions.releasedCount}{" "}
          {params.released ?? "0"}
        </p>
      ) : null}
      {params.error ? <p className="error">{m.commissions.actionError}</p> : null}

      <form action={releaseAction} className="form">
        <button type="submit">{m.commissions.releaseNow}</button>
      </form>

      <form method="get" className="form">
        <label>
          {m.commissions.affiliate}
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
            <option value="HOLDING">{m.commissions.statusHOLDING}</option>
            <option value="AVAILABLE">{m.commissions.statusAVAILABLE}</option>
            <option value="PAID">{m.commissions.statusPAID}</option>
            <option value="REJECTED">{m.commissions.statusREJECTED}</option>
            <option value="REVERSED">{m.commissions.statusREVERSED}</option>
          </select>
        </label>
        <label className="check">
          <input
            name="review"
            type="checkbox"
            value="1"
            defaultChecked={params.review === "1"}
          />
          {m.commissions.reviewOnly}
        </label>
        <button type="submit">{m.common.filter}</button>
      </form>

      {commissions.length === 0 ? (
        <p>{m.commissions.empty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{m.common.createdAt}</th>
              <th>{m.commissions.order}</th>
              <th>{m.commissions.affiliate}</th>
              <th>{m.commissions.gross}</th>
              <th>{m.commissions.reversed}</th>
              <th>{m.commissions.effective}</th>
              <th>{m.common.status}</th>
              <th>{m.commissions.holdUntil}</th>
              <th>{m.common.actions}</th>
            </tr>
          </thead>
          <tbody>
            {commissions.map((commission) => {
              const pending = isPendingReview(commission);
              return (
                <tr key={commission.id}>
                  <td>{fmt(commission.createdAt)}</td>
                  <td>{commission.conversion.externalOrderId}</td>
                  <td>
                    {commission.affiliate.name} · {commission.affiliate.email}
                  </td>
                  <td>
                    {commission.amountCents} {commission.currency}
                  </td>
                  <td>{commission.reversedCents}</td>
                  <td>{effectiveCommissionCents(commission)}</td>
                  <td>
                    {statusLabel(m, commission.status)}
                    {pending ? ` · ${m.commissions.pendingReview}` : ""}
                    {commission.statusReason && !pending
                      ? ` · ${commission.statusReason}`
                      : ""}
                  </td>
                  <td>{fmt(commission.holdUntil)}</td>
                  <td className="rowactions">
                    {pending ? (
                      <form action={approveAction}>
                        <input type="hidden" name="id" value={commission.id} />
                        <button type="submit">{m.commissions.approve}</button>
                      </form>
                    ) : null}
                    {commission.status === "HOLDING" ? (
                      <form action={rejectAction}>
                        <input type="hidden" name="id" value={commission.id} />
                        <input
                          name="reason"
                          required
                          maxLength={200}
                          placeholder={m.commissions.rejectReason}
                        />
                        <button type="submit">{m.commissions.reject}</button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p>
        {page > 1 ? <Link href={qs(page - 1)}>{m.common.prev}</Link> : null}{" "}
        {m.common.page} {page} / {pageCount}{" "}
        {page < pageCount ? <Link href={qs(page + 1)}>{m.common.next}</Link> : null}
      </p>
    </main>
  );
}
