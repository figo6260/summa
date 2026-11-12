import { pageMessages, pageLocale } from "@/lib/page-i18n";
import SideNav from "../side-nav";
import LanguageSwitcher from "../language-switcher";

/**
 * Affiliate portal chrome (v1.1): sidebar navigation plus a top bar
 * showing the signed-in affiliate's email, the language switcher and
 * sign-out. Same shell as the admin portal.
 */
export default async function AffiliateNav({ email }: { email: string }) {
  const m = await pageMessages();
  const locale = await pageLocale();
  const links = [
    { href: "/affiliate", label: m.affiliateNav.overview },
    { href: "/affiliate/links", label: m.links.title },
    { href: "/affiliate/commissions", label: m.affiliateCommissions.title },
    { href: "/affiliate/payouts", label: m.affiliateNav.payouts },
    { href: "/affiliate/profile", label: m.affiliateProfile.title },
  ];
  return (
    <>
      <SideNav
        brand={m.home.brand}
        subtitle={m.affiliateNav.title}
        links={links}
      />
      <header className="topbar">
        <span className="topbar-title">{m.affiliateNav.title}</span>
        <div className="topbar-actions">
          <span className="topbar-email">{email}</span>
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
