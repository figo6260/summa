import { pageMessages, pageLocale } from "@/lib/page-i18n";
import SideNav from "../side-nav";
import LanguageSwitcher from "../language-switcher";

/**
 * Admin portal chrome (v1.1): sidebar navigation plus a top bar with
 * the language switcher and sign-out. Rendered as the first children of
 * each page's <main class="panel">; the stylesheet positions the pieces.
 */
export default async function AdminNav() {
  const m = await pageMessages();
  const locale = await pageLocale();
  const links = [
    { href: "/admin", label: m.adminNav.dashboard },
    { href: "/admin/program", label: m.adminNav.program },
    { href: "/admin/affiliates", label: m.adminNav.affiliates },
    { href: "/admin/clicks", label: m.adminNav.clicks },
    { href: "/admin/conversions", label: m.adminNav.conversions },
    { href: "/admin/commissions", label: m.adminNav.commissions },
    { href: "/admin/payouts", label: m.adminNav.payouts },
    { href: "/admin/api-keys", label: m.adminNav.apiKeys },
    { href: "/admin/emails", label: m.adminNav.emails },
    { href: "/admin/audit", label: m.adminNav.audit },
  ];
  return (
    <>
      <SideNav brand={m.home.brand} subtitle={m.adminNav.title} links={links} />
      <header className="topbar">
        <span className="topbar-title">{m.adminNav.title}</span>
        <div className="topbar-actions">
          <LanguageSwitcher current={locale} label={m.home.languageLabel} />
          <form action="/logout" method="post">
            <button type="submit" className="btn-ghost">
              {m.common.logout}
            </button>
          </form>
        </div>
      </header>
    </>
  );
}
