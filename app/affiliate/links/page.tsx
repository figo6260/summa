import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAffiliate } from "@/lib/auth";
import { createReferralLink, setReferralLinkActive } from "@/lib/services";
import { pageMessages } from "@/lib/page-i18n";
import AffiliateNav from "../affiliate-nav";
import CopyButton from "./copy-button";

async function createLinkAction(formData: FormData) {
  "use server";
  const session = await requireAffiliate();
  try {
    await createReferralLink(
      prisma,
      { type: "AFFILIATE", id: session.sub },
      session.sub,
      {
        channel: String(formData.get("channel") ?? ""),
        targetUrl: String(formData.get("targetUrl") ?? ""),
      },
    );
  } catch {
    redirect("/affiliate/links?error=create");
  }
  redirect("/affiliate/links?saved=link");
}

async function toggleLinkAction(formData: FormData) {
  "use server";
  const session = await requireAffiliate();
  const id = String(formData.get("id") ?? "");
  const next = String(formData.get("next") ?? "");
  if (id && (next === "true" || next === "false")) {
    await setReferralLinkActive(
      prisma,
      { type: "AFFILIATE", id: session.sub },
      id,
      next === "true",
    );
  }
  redirect("/affiliate/links");
}

export default async function AffiliateLinksPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const session = await requireAffiliate();
  const m = await pageMessages();
  const { saved, error } = await searchParams;
  const affiliate = await prisma.affiliate.findUnique({
    where: { id: session.sub },
    include: { program: { select: { defaultTargetUrl: true } } },
  });
  if (!affiliate || affiliate.status !== "ACTIVE") notFound();
  const links = await prisma.referralLink.findMany({
    where: { affiliateId: affiliate.id },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { clicks: true } } },
  });
  const codes = await prisma.discountCode.findMany({
    where: { affiliateId: affiliate.id },
    orderBy: { createdAt: "asc" },
  });
  const hdrs = await headers();
  const host = hdrs.get("host") ?? "localhost:3457";
  const proto = hdrs.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? "http";
  const origin = `${proto}://${host}`;

  return (
    <main className="panel wide">
      <AffiliateNav email={affiliate.email} />
      <h1>{m.links.title}</h1>
      <p>{m.links.intro}</p>
      {saved === "link" ? <p className="ok">{m.links.created}</p> : null}
      {error === "create" ? <p className="error">{m.links.createError}</p> : null}

      <h2>{m.links.createTitle}</h2>
      <form action={createLinkAction} className="form">
        <label>
          {m.links.channel}
          <input name="channel" placeholder={m.links.channelHint} />
        </label>
        <label>
          {m.links.targetUrl}
          <input name="targetUrl" placeholder={affiliate.program.defaultTargetUrl ?? ""} />
          <small>{m.links.targetHint}</small>
        </label>
        <button type="submit">{m.links.create}</button>
      </form>

      <h2>{m.links.yourLinks}</h2>
      {links.length === 0 ? (
        <p>{m.links.empty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{m.links.url}</th>
              <th>{m.links.channel}</th>
              <th>{m.links.targetUrl}</th>
              <th>{m.links.clicks}</th>
              <th>{m.common.status}</th>
              <th>{m.common.actions}</th>
            </tr>
          </thead>
          <tbody>
            {links.map((link) => {
              const url = `${origin}/r/${link.code}`;
              return (
                <tr key={link.id}>
                  <td className="urlcell">
                    {url}
                    <br />
                    <CopyButton
                      text={url}
                      copyLabel={m.links.copy}
                      copiedLabel={m.links.copied}
                    />
                  </td>
                  <td>{link.channel ?? m.common.none}</td>
                  <td className="urlcell">
                    {link.targetUrl ?? affiliate.program.defaultTargetUrl ?? m.common.none}
                  </td>
                  <td>{link._count.clicks}</td>
                  <td>{link.isActive ? m.links.statusActive : m.links.statusDisabled}</td>
                  <td className="rowactions">
                    <form action={toggleLinkAction}>
                      <input type="hidden" name="id" value={link.id} />
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
              );
            })}
          </tbody>
        </table>
      )}

      <h2>{m.links.codesTitle}</h2>
      <p>{m.links.codesIntro}</p>
      {codes.length === 0 ? (
        <p>{m.links.codesEmpty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{m.links.code}</th>
              <th>{m.links.discount}</th>
              <th>{m.common.status}</th>
            </tr>
          </thead>
          <tbody>
            {codes.map((code) => (
              <tr key={code.id}>
                <td>{code.code}</td>
                <td>{(code.discountBps / 100).toFixed(2).replace(/\.?0+$/, "")}%</td>
                <td>{code.isActive ? m.links.statusActive : m.links.statusDisabled}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
