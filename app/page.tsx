import Link from "next/link";
import { cookies } from "next/headers";
import { getMessages, resolveLocale, LOCALE_COOKIE } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { adminExists } from "@/lib/services";
import LanguageSwitcher from "./language-switcher";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value);
  const m = getMessages(locale);
  let hasAdmin = true;
  try {
    hasAdmin = await adminExists(prisma);
  } catch {
    hasAdmin = true;
  }

  return (
    <main className="home">
      <p className="brand">{m.home.brand}</p>
      <h1>{m.home.headline}</h1>
      <p className="tagline">{m.home.tagline}</p>
      <nav className="homelinks">
        <Link href="/admin/login">{m.home.adminLogin}</Link>
        <Link href="/affiliate/login">{m.home.affiliateLogin}</Link>
        {!hasAdmin ? <Link href="/setup">{m.home.setup}</Link> : null}
      </nav>
      <p className="status">{m.home.status}</p>
      <LanguageSwitcher current={locale} label={m.home.languageLabel} />
    </main>
  );
}
