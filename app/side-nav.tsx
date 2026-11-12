"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface SideNavLink {
  href: string;
  label: string;
}

/**
 * Portal sidebar (v1.1 design system): brand block on top, vertical
 * navigation with the current page highlighted. On narrow screens the
 * stylesheet folds it into a top strip with a horizontally scrollable
 * nav row, so no client-side toggle state is needed.
 */
export default function SideNav({
  brand,
  subtitle,
  links,
}: {
  brand: string;
  subtitle: string;
  links: SideNavLink[];
}) {
  const pathname = usePathname();

  function isActive(href: string): boolean {
    if (href === "/admin" || href === "/affiliate") return pathname === href;
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="logo-mark" aria-hidden="true">
          S
        </span>
        <span className="sidebar-brand-text">
          <span className="sidebar-brand-name">{brand}</span>
          <span className="sidebar-brand-sub">{subtitle}</span>
        </span>
      </div>
      <nav className="sidenav" aria-label={subtitle}>
        {links.map((link) => {
          const active = isActive(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={active ? "sidenav-link active" : "sidenav-link"}
              aria-current={active ? "page" : undefined}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
