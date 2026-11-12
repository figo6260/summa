import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import {
  getSingleProgram,
  inviteAffiliate,
  reissueActivationToken,
  setAffiliateStatus,
} from "@/lib/services";
import { pageMessages } from "@/lib/page-i18n";
import type { Messages } from "@/lib/i18n";
import AdminNav from "../admin-nav";
import StatusBadge from "../../status-badge";

async function requestBaseUrl(): Promise<string> {
  const hdrs = await headers();
  const host = hdrs.get("host") ?? "localhost:3457";
  const proto = hdrs.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? "http";
  return `${proto}://${host}`;
}

async function inviteAction(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const program = await getSingleProgram(prisma);
  if (!program) redirect("/admin/program");
  const name = String(formData.get("name") ?? "");
  const email = String(formData.get("email") ?? "");
  if (name.trim() === "" || email.trim() === "") redirect("/admin/affiliates?error=form");
  const result = await inviteAffiliate(prisma, session.sub, program.id, { name, email }, {
    baseUrl: await requestBaseUrl(),
  });
  redirect(
    `/admin/affiliates?invited=${result.affiliate.id}&token=${encodeURIComponent(result.token)}`,
  );
}

async function toggleStatusAction(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const next = String(formData.get("next") ?? "");
  if (id && (next === "ACTIVE" || next === "DISABLED")) {
    await setAffiliateStatus(prisma, session.sub, id, next);
  }
  redirect("/admin/affiliates");
}

async function resendAction(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const result = await reissueActivationToken(prisma, session.sub, id, {
    baseUrl: await requestBaseUrl(),
  });
  redirect(
    `/admin/affiliates?invited=${result.affiliate.id}&token=${encodeURIComponent(result.token)}`,
  );
}

function statusLabel(m: Messages, status: string): string {
  if (status === "ACTIVE") return m.affiliates.statusActive;
  if (status === "DISABLED") return m.affiliates.statusDisabled;
  return m.affiliates.statusPending;
}

export default async function AffiliatesPage({
  searchParams,
}: {
  searchParams: Promise<{ invited?: string; token?: string }>;
}) {
  await requireAdmin();
  const m = await pageMessages();
  const { invited, token } = await searchParams;
  const program = await getSingleProgram(prisma);
  const affiliates = program
    ? await prisma.affiliate.findMany({
        where: { programId: program.id },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const hdrs = await headers();
  const host = hdrs.get("host") ?? "localhost:3457";
  // Build the link from how the admin actually reached this page: a TLS
  // proxy sets x-forwarded-proto, a plain local/self-hosted HTTP install
  // gets http. Guessing https from NODE_ENV would hand out dead links on
  // HTTP installs.
  const proto = hdrs.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? "http";
  const activationLink =
    invited && token ? `${proto}://${host}/activate?token=${token}` : null;

  return (
    <main className="panel wide">
      <AdminNav />
      <h1>{m.affiliates.title}</h1>

      {activationLink ? (
        <section className="linkbox">
          <h2>{m.affiliates.activationLinkTitle}</h2>
          <p>{m.affiliates.activationLinkHint}</p>
          <p>{m.affiliates.copyHint}</p>
          <code className="activation-link">{activationLink}</code>
        </section>
      ) : null}

      <h2>{m.affiliates.inviteTitle}</h2>
      <form action={inviteAction} className="form inline">
        <label>
          {m.common.name}
          <input name="name" required />
        </label>
        <label>
          {m.common.email}
          <input name="email" type="email" required />
        </label>
        <button type="submit">{m.affiliates.invite}</button>
      </form>

      {affiliates.length === 0 ? (
        <p>{m.affiliates.empty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{m.common.name}</th>
              <th>{m.common.email}</th>
              <th>{m.common.status}</th>
              <th>{m.common.createdAt}</th>
              <th>{m.common.actions}</th>
            </tr>
          </thead>
          <tbody>
            {affiliates.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td>{a.email}</td>
                <td><StatusBadge status={a.status} label={statusLabel(m, a.status)} /></td>
                <td>{a.createdAt.toISOString().slice(0, 10)}</td>
                <td className="rowactions">
                  <Link href={`/admin/affiliates/${a.id}`}>{m.affiliates.edit}</Link>
                  {a.status === "ACTIVE" ? (
                    <form action={toggleStatusAction}>
                      <input type="hidden" name="id" value={a.id} />
                      <input type="hidden" name="next" value="DISABLED" />
                      <button type="submit" className="btn-danger">{m.affiliates.disable}</button>
                    </form>
                  ) : null}
                  {a.status === "DISABLED" ? (
                    <form action={toggleStatusAction}>
                      <input type="hidden" name="id" value={a.id} />
                      <input type="hidden" name="next" value="ACTIVE" />
                      <button type="submit">{m.affiliates.enable}</button>
                    </form>
                  ) : null}
                  {a.status === "PENDING_ACTIVATION" ? (
                    <form action={resendAction}>
                      <input type="hidden" name="id" value={a.id} />
                      <button type="submit">{m.affiliates.resendActivation}</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
