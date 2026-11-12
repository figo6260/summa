import Link from "next/link";
import { pageMessages } from "@/lib/page-i18n";

/**
 * Shared affiliate-portal navigation (M5): overview / links &
 * creatives / commissions / payouts / profile. The email of the signed
 * in affiliate is shown on the right, next to the logout button.
 */
export default async function AffiliateNav({ email }: { email: string }) {
  const m = await pageMessages();
  return (
    <nav className="topnav">
      <strong>{m.affiliateNav.title}</strong>
      <Link href="/affiliate">{m.affiliateNav.overview}</Link>
      <Link href="/affiliate/links">{m.links.title}</Link>
      <Link href="/affiliate/commissions">{m.affiliateCommissions.title}</Link>
      <Link href="/affiliate/payouts">{m.affiliateNav.payouts}</Link>
      <Link href="/affiliate/profile">{m.affiliateProfile.title}</Link>
      <span>{email}</span>
      <form action="/logout" method="post">
        <button type="submit" className="linklike">
          {m.common.logout}
        </button>
      </form>
    </nav>
  );
}
