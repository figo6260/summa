/**
 * Extension point 4 of 4 — brand configuration point.
 *
 * All brand-facing values (product name, logo, colors, domain, email
 * sender) are read through this single configuration surface, so there is
 * exactly one place where branding is decided.
 *
 * - Core (open source): branding is locked to the product's own brand —
 *   DEFAULT_BRAND below.
 * - Pro (hosted only, NOT in this repo): white-label unlocks this surface
 *   per tenant (custom logo / colors / domain / sender). The unlocking
 *   logic is not part of the open-source core.
 */

export interface BrandConfig {
  productName: string;
  logoUrl?: string;
  primaryColor?: string;
  /** Custom domain the portals are served from, if any. */
  customDomain?: string;
  /** From-address used for transactional email. */
  emailFrom?: string;
}

export const DEFAULT_BRAND: BrandConfig = {
  productName: "Summa",
  primaryColor: "#4f46e5",
  emailFrom: "no-reply@summa.local",
};

/**
 * Resolve the active brand configuration. The core always returns the
 * product's own brand; the hosted Pro environment may wrap this resolver
 * to return per-tenant white-label values.
 */
export function resolveBrand(): BrandConfig {
  return DEFAULT_BRAND;
}
