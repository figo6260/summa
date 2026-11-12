import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { PayoutMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import {
  createDiscountCode,
  payoutDetailsText,
  setDiscountCodeActive,
  setReferralLinkActive,
  updateAffiliatePayout,
  updateAffiliateProfile,
} from "@/lib/services";
import { pageMessages } from "@/lib/page-i18n";
import AdminNav from "../../admin-nav";

const METHODS: PayoutMethod[] = ["MANUAL", "BANK_TRANSFER", "PAYPAL", "WISE", "OTHER"];

async function profileAction(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  await updateAffiliateProfile(
    prisma,
    { type: "ADMIN", id: session.sub },
    id,
    {
      name: String(formData.get("name") ?? ""),
      email: String(formData.get("email") ?? ""),
    },
  );
  redirect(`/admin/affiliates/${id}?saved=profile`);
}

async function payoutAction(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const method = String(formData.get("method") ?? "MANUAL") as PayoutMethod;
  await updateAffiliatePayout(
    prisma,
    { type: "ADMIN", id: session.sub },
    id,
    { method, detailsText: String(formData.get("details") ?? "") },
  );
  redirect(`/admin/affiliates/${id}?saved=payout`);
}

async function toggleLinkAction(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const affiliateId = String(formData.get("affiliateId") ?? "");
  const linkId = String(formData.get("linkId") ?? "");
  const next = String(formData.get("next") ?? "");
  if (linkId && (next === "true" || next === "false")) {
    await setReferralLinkActive(
      prisma,
      { type: "ADMIN", id: session.sub },
      linkId,
      next === "true",
    );
  }
  redirect(`/admin/affiliates/${affiliateId}`);
}

async function createCodeAction(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const affiliateId = String(formData.get("affiliateId") ?? "");
  const code = String(formData.get("code") ?? "");
  const discountBps = Number(formData.get("discountBps") ?? "");
  try {
    await createDiscountCode(prisma, session.sub, affiliateId, { code, discountBps });
  } catch {
    redirect(`/admin/affiliates/${affiliateId}?error=code`);
  }
  redirect(`/admin/affiliates/${affiliateId}?saved=code`);
}

async function toggleCodeAction(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const affiliateId = String(formData.get("affiliateId") ?? "");
  const codeId = String(formData.get("codeId") ?? "");
  const next = String(formData.get("next") ?? "");
  if (codeId && (next === "true" || next === "false")) {
    await setDiscountCodeActive(prisma, session.sub, codeId, next === "true");
  }
  redirect(`/admin/affiliates/${affiliateId}`);
}

export default async function AffiliateDetailPage({
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
  const affiliate = await prisma.affiliate.findUnique({ where: { id } });
  if (!affiliate) notFound();
  const program = await prisma.program.findUnique({
    where: { id: affiliate.programId },
  });
  const links = await prisma.referralLink.findMany({
    where: { affiliateId: affiliate.id },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { clicks: true } } },
  });
  const codes = await prisma.discountCode.findMany({
    where: { affiliateId: affiliate.id },
    orderBy: { createdAt: "asc" },
  });
  return (
    <main className="panel wide">
      <AdminNav />
      <h1>{m.affiliates.detailTitle}</h1>
      <p>
        {affiliate.name} · {affiliate.email}
      </p>
      {saved === "profile" ? <p className="ok">{m.affiliates.profileSaved}</p> : null}
      {saved === "payout" ? <p className="ok">{m.affiliates.payoutSaved}</p> : null}
      {saved === "code" ? <p className="ok">{m.affiliates.codeSaved}</p> : null}
      {error === "code" ? <p className="error">{m.affiliates.codeError}</p> : null}
      <form action={profileAction} className="form">
        <input type="hidden" name="id" value={affiliate.id} />
        <label>
          {m.common.name}
          <input name="name" defaultValue={affiliate.name} required />
        </label>
        <label>
          {m.common.email}
          <input name="email" type="email" defaultValue={affiliate.email} required />
        </label>
        <button type="submit">{m.affiliates.saveProfile}</button>
      </form>
      <form action={payoutAction} className="form">
        <input type="hidden" name="id" value={affiliate.id} />
        <label>
          {m.affiliates.payoutMethod}
          <select name="method" defaultValue={affiliate.payoutMethod}>
            {METHODS.map((method) => (
              <option key={method} value={method}>
                {m.payoutMethods[method]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {m.affiliates.payoutDetails}
          <textarea name="details" defaultValue={payoutDetailsText(affiliate)} rows={3} />
        </label>
        <button type="submit">{m.affiliates.savePayout}</button>
      </form>
      <h2>{m.affiliates.linksTitle}</h2>
      {links.length === 0 ? (
        <p>{m.affiliates.linksEmpty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{m.links.code}</th>
              <th>{m.links.channel}</th>
              <th>{m.links.targetUrl}</th>
              <th>{m.links.clicks}</th>
              <th>{m.common.status}</th>
              <th>{m.common.actions}</th>
            </tr>
          </thead>
          <tbody>
            {links.map((link) => (
              <tr key={link.id}>
                <td>{link.code}</td>
                <td>{link.channel ?? m.common.none}</td>
                <td className="urlcell">
                  {link.targetUrl ?? program?.defaultTargetUrl ?? m.common.none}
                </td>
                <td>{link._count.clicks}</td>
                <td>{link.isActive ? m.links.statusActive : m.links.statusDisabled}</td>
                <td className="rowactions">
                  <form action={toggleLinkAction}>
                    <input type="hidden" name="affiliateId" value={affiliate.id} />
                    <input type="hidden" name="linkId" value={link.id} />
                    <input
                      type="hidden"
                      name="next"
                      value={link.isActive ? "false" : "true"}
                    />
                    <button type="submit">
                      {link.isActive ? m.links.disable : m.links.enable}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>{m.affiliates.codesTitle}</h2>
      <p>{m.affiliates.codesIntro}</p>
      <form action={createCodeAction} className="form inline">
        <input type="hidden" name="affiliateId" value={affiliate.id} />
        <label>
          {m.affiliates.codeLabel}
          <input name="code" required placeholder="PARTNER15" />
        </label>
        <label>
          {m.affiliates.codeDiscountBps}
          <input
            name="discountBps"
            type="number"
            min={0}
            max={10000}
            defaultValue={program?.buyerDiscountBps ?? 0}
            required
          />
        </label>
        <button type="submit">{m.affiliates.codeCreate}</button>
      </form>
      {codes.length === 0 ? (
        <p>{m.affiliates.codesEmpty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{m.links.code}</th>
              <th>{m.affiliates.codeDiscountBps}</th>
              <th>{m.common.status}</th>
              <th>{m.common.actions}</th>
            </tr>
          </thead>
          <tbody>
            {codes.map((code) => (
              <tr key={code.id}>
                <td>{code.code}</td>
                <td>{code.discountBps}</td>
                <td>{code.isActive ? m.links.statusActive : m.links.statusDisabled}</td>
                <td className="rowactions">
                  <form action={toggleCodeAction}>
                    <input type="hidden" name="affiliateId" value={affiliate.id} />
                    <input type="hidden" name="codeId" value={code.id} />
                    <input
                      type="hidden"
                      name="next"
                      value={code.isActive ? "false" : "true"}
                    />
                    <button type="submit">
                      {code.isActive ? m.links.disable : m.links.enable}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        <Link href="/admin/affiliates">{m.common.back}</Link>
      </p>
    </main>
  );
}
