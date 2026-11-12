import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getSingleProgram } from "@/lib/services";
import { pageMessages } from "@/lib/page-i18n";
import AdminNav from "../admin-nav";

const PAGE_SIZE = 20;

function fmt(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export default async function ClicksPage({
  searchParams,
}: {
  searchParams: Promise<{
    affiliateId?: string;
    linkId?: string;
    from?: string;
    to?: string;
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
  const links = program
    ? await prisma.referralLink.findMany({
        where: { programId: program.id },
        orderBy: { createdAt: "desc" },
        select: { id: true, code: true, channel: true, affiliateId: true },
      })
    : [];

  const where: Record<string, unknown> = program ? { programId: program.id } : { id: "__none__" };
  if (params.linkId) where.linkId = params.linkId;
  if (params.affiliateId) {
    where.link = { affiliateId: params.affiliateId };
  }
  const createdAt: Record<string, Date> = {};
  if (params.from) {
    const from = new Date(`${params.from}T00:00:00.000Z`);
    if (!Number.isNaN(from.getTime())) createdAt.gte = from;
  }
  if (params.to) {
    const to = new Date(`${params.to}T23:59:59.999Z`);
    if (!Number.isNaN(to.getTime())) createdAt.lte = to;
  }
  if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;

  const total = await prisma.click.count({ where });
  const clicks = await prisma.click.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    include: {
      link: {
        select: {
          code: true,
          channel: true,
          affiliate: { select: { name: true, email: true } },
        },
      },
    },
  });
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (nextPage: number) => {
    const q = new URLSearchParams();
    if (params.affiliateId) q.set("affiliateId", params.affiliateId);
    if (params.linkId) q.set("linkId", params.linkId);
    if (params.from) q.set("from", params.from);
    if (params.to) q.set("to", params.to);
    q.set("page", String(nextPage));
    return `/admin/clicks?${q.toString()}`;
  };

  return (
    <main className="panel wide">
      <AdminNav />
      <h1>{m.clicks.title}</h1>
      <p>{m.clicks.intro}</p>
      <form method="get" className="form">
        <label>
          {m.clicks.affiliate}
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
          {m.clicks.link}
          <select name="linkId" defaultValue={params.linkId ?? ""}>
            <option value="">{m.common.all}</option>
            {links.map((l) => (
              <option key={l.id} value={l.id}>
                {l.code}
                {l.channel ? ` · ${l.channel}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          {m.clicks.from}
          <input type="date" name="from" defaultValue={params.from ?? ""} />
        </label>
        <label>
          {m.clicks.to}
          <input type="date" name="to" defaultValue={params.to ?? ""} />
        </label>
        <button type="submit">{m.common.filter}</button>
      </form>
      {clicks.length === 0 ? (
        <p>{m.clicks.empty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{m.clicks.time}</th>
              <th>{m.clicks.affiliate}</th>
              <th>{m.clicks.link}</th>
              <th>{m.clicks.referrer}</th>
              <th>{m.clicks.ip}</th>
              <th>{m.clicks.userAgent}</th>
              <th>{m.clicks.visitor}</th>
            </tr>
          </thead>
          <tbody>
            {clicks.map((click) => (
              <tr key={click.id}>
                <td>{fmt(click.createdAt)}</td>
                <td>
                  {click.link.affiliate.name} · {click.link.affiliate.email}
                </td>
                <td>
                  {click.link.code}
                  {click.link.channel ? ` · ${click.link.channel}` : ""}
                </td>
                <td>{click.referrer ?? m.common.none}</td>
                <td>{click.ipAddress ?? m.common.none}</td>
                <td>{(click.userAgent ?? "").slice(0, 60)}</td>
                <td>
                  <code>{(click.visitorToken ?? "").slice(0, 10)}</code>
                </td>
              </tr>
            ))}
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
