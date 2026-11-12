import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { createProgram, getSingleProgram, updateProgram } from "@/lib/services";
import { parseProgramForm, type ProgramInput } from "@/lib/program-form";
import { pageMessages } from "@/lib/page-i18n";
import AdminNav from "../admin-nav";

function fieldsFrom(formData: FormData): Record<string, string | undefined> {
  const get = (k: string) => {
    const v = formData.get(k);
    return v === null ? undefined : String(v);
  };
  return {
    name: get("name"),
    slug: get("slug"),
    commissionRateBps: get("commissionRateBps"),
    commissionRounding: get("commissionRounding"),
    buyerDiscountBps: get("buyerDiscountBps"),
    currency: get("currency"),
    attributionWindowDays: get("attributionWindowDays"),
    holdDays: get("holdDays"),
    minPayoutCents: get("minPayoutCents"),
    payoutDayOfMonth: get("payoutDayOfMonth"),
    defaultTargetUrl: get("defaultTargetUrl"),
    isActive: get("isActive"),
  };
}

async function saveProgramAction(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const parsed = parseProgramForm(fieldsFrom(formData));
  if (!parsed.ok) redirect("/admin/program?error=form");
  const input: ProgramInput = parsed.value;
  const existing = await getSingleProgram(prisma);
  if (existing) {
    await updateProgram(prisma, session.sub, existing.id, input);
  } else {
    await createProgram(prisma, session.sub, input);
  }
  redirect("/admin/program?saved=1");
}

export default async function ProgramPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  await requireAdmin();
  const m = await pageMessages();
  const { saved, error } = await searchParams;
  const program = await getSingleProgram(prisma);
  const p = program ?? {
    name: "",
    slug: "",
    commissionRateBps: 1500,
    commissionRounding: "FLOOR" as const,
    buyerDiscountBps: 0,
    currency: "USD",
    attributionWindowDays: 30,
    holdDays: 30,
    minPayoutCents: 0,
    payoutDayOfMonth: 10,
    defaultTargetUrl: null,
    isActive: true,
  };
  return (
    <main className="panel wide">
      <AdminNav />
      <h1>{program ? m.program.title : m.program.createTitle}</h1>
      {!program ? <p>{m.program.createIntro}</p> : null}
      {saved ? <p className="ok">{m.program.saved}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      <form action={saveProgramAction} className="form">
        <label>
          {m.program.name}
          <input name="name" defaultValue={p.name} required />
        </label>
        <label>
          {m.program.slug}
          <input name="slug" defaultValue={p.slug} required />
        </label>
        <label>
          {m.program.commissionRateBps}
          <input name="commissionRateBps" type="number" min={0} max={10000} defaultValue={p.commissionRateBps} required />
        </label>
        <label>
          {m.program.commissionRounding}
          <select name="commissionRounding" defaultValue={p.commissionRounding}>
            <option value="FLOOR">{m.program.roundingFLOOR}</option>
            <option value="NEAREST">{m.program.roundingNEAREST}</option>
            <option value="CEIL">{m.program.roundingCEIL}</option>
          </select>
        </label>
        <label>
          {m.program.buyerDiscountBps}
          <input name="buyerDiscountBps" type="number" min={0} max={10000} defaultValue={p.buyerDiscountBps} required />
        </label>
        <label>
          {m.program.currency}
          <input name="currency" defaultValue={p.currency} required maxLength={3} />
        </label>
        <label>
          {m.program.attributionWindowDays}
          <input name="attributionWindowDays" type="number" min={0} defaultValue={p.attributionWindowDays} required />
        </label>
        <label>
          {m.program.holdDays}
          <input name="holdDays" type="number" min={0} defaultValue={p.holdDays} required />
        </label>
        <label>
          {m.program.minPayoutCents}
          <input name="minPayoutCents" type="number" min={0} defaultValue={p.minPayoutCents} required />
        </label>
        <label>
          {m.program.payoutDayOfMonth}
          <input name="payoutDayOfMonth" type="number" min={1} max={28} defaultValue={p.payoutDayOfMonth} required />
        </label>
        <label>
          {m.program.defaultTargetUrl}
          <input
            name="defaultTargetUrl"
            defaultValue={p.defaultTargetUrl ?? ""}
            placeholder="https://example.com/landing"
          />
          <small>{m.program.defaultTargetUrlHint}</small>
        </label>
        <label className="check">
          <input name="isActive" type="checkbox" defaultChecked={p.isActive} />
          {m.program.isActive}
        </label>
        <button type="submit">{program ? m.common.save : m.program.create}</button>
      </form>
    </main>
  );
}
