import { notFound, redirect } from "next/navigation";
import type { PayoutMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAffiliate } from "@/lib/auth";
import {
  changeAffiliatePassword,
  payoutDetailsText,
  updateAffiliateNotificationPrefs,
  updateAffiliatePayout,
  updateAffiliateProfile,
} from "@/lib/services";
import { notificationPrefsOf } from "@/lib/mailer";
import { pageMessages } from "@/lib/page-i18n";
import AffiliateNav from "../affiliate-nav";

const METHODS: PayoutMethod[] = ["MANUAL", "BANK_TRANSFER", "PAYPAL", "WISE", "OTHER"];

async function profileAction(formData: FormData) {
  "use server";
  const session = await requireAffiliate();
  await updateAffiliateProfile(
    prisma,
    { type: "AFFILIATE", id: session.sub },
    session.sub,
    { name: String(formData.get("name") ?? "") },
  );
  redirect("/affiliate/profile?saved=profile");
}

async function payoutAction(formData: FormData) {
  "use server";
  const session = await requireAffiliate();
  const method = String(formData.get("method") ?? "MANUAL") as PayoutMethod;
  await updateAffiliatePayout(
    prisma,
    { type: "AFFILIATE", id: session.sub },
    session.sub,
    { method, detailsText: String(formData.get("details") ?? "") },
  );
  redirect("/affiliate/profile?saved=payout");
}

async function prefsAction(formData: FormData) {
  "use server";
  const session = await requireAffiliate();
  await updateAffiliateNotificationPrefs(
    prisma,
    { type: "AFFILIATE", id: session.sub },
    session.sub,
    {
      commission: formData.get("commission") === "on",
      payout: formData.get("payout") === "on",
    },
  );
  redirect("/affiliate/profile?saved=prefs");
}

async function passwordAction(formData: FormData) {
  "use server";
  const session = await requireAffiliate();
  const ok = await changeAffiliatePassword(
    prisma,
    session.sub,
    String(formData.get("currentPassword") ?? ""),
    String(formData.get("newPassword") ?? ""),
  );
  redirect(ok ? "/affiliate/profile?saved=password" : "/affiliate/profile?error=password");
}

export default async function AffiliateProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const session = await requireAffiliate();
  const m = await pageMessages();
  const { saved, error } = await searchParams;
  const affiliate = await prisma.affiliate.findUnique({ where: { id: session.sub } });
  if (!affiliate || affiliate.status !== "ACTIVE") notFound();
  const prefs = notificationPrefsOf(affiliate);
  return (
    <main className="panel">
      <AffiliateNav email={affiliate.email} />
      <h1>{m.affiliateProfile.title}</h1>
      <p>{m.affiliateProfile.intro}</p>
      {saved === "profile" ? <p className="ok">{m.affiliates.profileSaved}</p> : null}
      {saved === "payout" ? <p className="ok">{m.affiliates.payoutSaved}</p> : null}
      {saved === "prefs" ? <p className="ok">{m.affiliateProfile.prefsSaved}</p> : null}
      {saved === "password" ? <p className="ok">{m.affiliateProfile.passwordChanged}</p> : null}
      {error === "password" ? <p className="error">{m.affiliateProfile.passwordMismatch}</p> : null}
      <form action={profileAction} className="form">
        <label>
          {m.common.name}
          <input name="name" defaultValue={affiliate.name} required />
        </label>
        <button type="submit">{m.affiliates.saveProfile}</button>
      </form>
      <form action={payoutAction} className="form">
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
      <h2>{m.affiliateProfile.notificationsTitle}</h2>
      <p>{m.affiliateProfile.notificationsIntro}</p>
      <form action={prefsAction} className="form">
        <label>
          <input
            type="checkbox"
            name="commission"
            defaultChecked={prefs.commission}
          />{" "}
          {m.affiliateProfile.notifyCommission}
        </label>
        <label>
          <input type="checkbox" name="payout" defaultChecked={prefs.payout} />{" "}
          {m.affiliateProfile.notifyPayout}
        </label>
        <button type="submit">{m.affiliateProfile.savePrefs}</button>
      </form>
      <h2>{m.affiliateProfile.changePassword}</h2>
      <form action={passwordAction} className="form">
        <label>
          {m.affiliateProfile.currentPassword}
          <input name="currentPassword" type="password" required autoComplete="current-password" />
        </label>
        <label>
          {m.affiliateProfile.newPassword}
          <input name="newPassword" type="password" required minLength={8} autoComplete="new-password" />
        </label>
        <button type="submit">{m.affiliateProfile.savePassword}</button>
      </form>
    </main>
  );
}
