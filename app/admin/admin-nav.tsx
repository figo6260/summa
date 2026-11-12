import Link from "next/link";
import { pageMessages } from "@/lib/page-i18n";

export default async function AdminNav() {
  const m = await pageMessages();
  return (
    <nav className="topnav">
      <strong>{m.adminNav.title}</strong>
      <Link href="/admin">{m.adminNav.dashboard}</Link>
      <Link href="/admin/program">{m.adminNav.program}</Link>
      <Link href="/admin/affiliates">{m.adminNav.affiliates}</Link>
      <Link href="/admin/clicks">{m.adminNav.clicks}</Link>
      <Link href="/admin/conversions">{m.adminNav.conversions}</Link>
      <Link href="/admin/commissions">{m.adminNav.commissions}</Link>
      <Link href="/admin/payouts">{m.adminNav.payouts}</Link>
      <Link href="/admin/api-keys">{m.adminNav.apiKeys}</Link>
      <Link href="/admin/emails">{m.adminNav.emails}</Link>
      <Link href="/admin/audit">{m.adminNav.audit}</Link>
      <form action="/logout" method="post">
        <button type="submit" className="linklike">
          {m.common.logout}
        </button>
      </form>
    </nav>
  );
}
