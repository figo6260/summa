import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { isValidTargetUrl } from "./program-form";

/**
 * M2 attribution library — the single place that decides who (if anyone)
 * a visitor or a checkout belongs to. M3's conversion API calls these
 * functions directly; nothing else should re-implement the rules.
 *
 * Rules (also recorded in docs/milestone.md, M2):
 *
 * 1. Last click wins. Every /r/:code visit mints a FRESH visitor token
 *    and hands it to the merchant twice: as the `summa_vid` cookie on
 *    this instance, and appended as `?summa_vid=<token>` to the redirect
 *    target so the merchant can store it on their own domain. Whichever
 *    token the merchant kept most recently is the one presented at
 *    conversion time, so the affiliate whose link was clicked last gets
 *    the attribution — `resolveAttributionByToken` only ever judges the
 *    token it is given.
 * 2. Deactivation kills attribution immediately. A token or code only
 *    resolves while its link/code is active, its affiliate is ACTIVE and
 *    its program is active. Disabling any of them makes existing tokens
 *    and codes stop resolving — there is no grace period.
 * 3. The window is hard. A click attributes only while it is younger
 *    than the program's attributionWindowDays; one second past the
 *    window it no longer attributes.
 * 4. A click is recorded only for a live link: unknown code, disabled
 *    link, non-ACTIVE affiliate or inactive program (or no usable
 *    target) records nothing and the endpoint answers 404.
 */

export const VISITOR_COOKIE = "summa_vid";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Click intake (behind GET /r/:code)
// ---------------------------------------------------------------------------

export interface ClickMeta {
  referrer?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export type ReferralClickResult =
  | {
      kind: "redirect";
      /** Absolute URL to 302 to, with summa_vid already appended. */
      location: string;
      visitorToken: string;
      /** Cookie max-age in seconds (= the attribution window). */
      cookieMaxAgeSeconds: number;
      clickId: string;
    }
  | { kind: "not_found" };

/**
 * Append the visitor token to the redirect target, preserving any query
 * parameters the target already carries. Site-local targets ("/pricing")
 * are resolved against the instance's own origin.
 */
export function buildRedirectLocation(
  target: string,
  visitorToken: string,
  origin: string,
): string {
  const url = target.startsWith("/")
    ? new URL(target, origin)
    : new URL(target);
  url.searchParams.set(VISITOR_COOKIE, visitorToken);
  return url.toString();
}

/**
 * Record one click for `code` and decide where to send the visitor.
 * Deliberately light: one indexed lookup by code, one insert, no page
 * rendering and no scanning of the clicks table.
 */
export async function handleReferralClick(
  db: PrismaClient,
  code: string,
  meta: ClickMeta,
  origin: string,
): Promise<ReferralClickResult> {
  const link = await db.referralLink.findUnique({
    where: { code },
    include: {
      affiliate: { select: { status: true } },
      program: {
        select: { isActive: true, attributionWindowDays: true, defaultTargetUrl: true },
      },
    },
  });
  if (!link || !link.isActive) return { kind: "not_found" };
  if (link.affiliate.status !== "ACTIVE") return { kind: "not_found" };
  if (!link.program.isActive) return { kind: "not_found" };
  const target = link.targetUrl ?? link.program.defaultTargetUrl;
  if (!target || !isValidTargetUrl(target)) return { kind: "not_found" };

  const visitorToken = randomBytes(24).toString("base64url");
  const click = await db.click.create({
    data: {
      programId: link.programId,
      linkId: link.id,
      visitorToken,
      referrer: meta.referrer ?? null,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    },
  });
  return {
    kind: "redirect",
    location: buildRedirectLocation(target, visitorToken, origin),
    visitorToken,
    cookieMaxAgeSeconds: link.program.attributionWindowDays * 24 * 60 * 60,
    clickId: click.id,
  };
}

// ---------------------------------------------------------------------------
// Attribution resolution (consumed by M3)
// ---------------------------------------------------------------------------

export interface TokenAttribution {
  programId: string;
  affiliateId: string;
  linkId: string;
  clickId: string;
}

/**
 * Judge one visitor token: find its (most recent) click and apply the
 * rules above. Returns null when the click does not attribute.
 */
export async function resolveAttributionByToken(
  db: PrismaClient,
  token: string | null | undefined,
): Promise<TokenAttribution | null> {
  if (!token) return null;
  const click = await db.click.findFirst({
    where: { visitorToken: token },
    orderBy: { createdAt: "desc" },
    include: {
      link: {
        include: {
          affiliate: { select: { status: true } },
          program: { select: { isActive: true, attributionWindowDays: true } },
        },
      },
    },
  });
  if (!click) return null;
  const { link } = click;
  if (!link.isActive) return null;
  if (link.affiliate.status !== "ACTIVE") return null;
  if (!link.program.isActive) return null;
  const windowMs = link.program.attributionWindowDays * DAY_MS;
  if (Date.now() - click.createdAt.getTime() > windowMs) return null;
  return {
    programId: click.programId,
    affiliateId: link.affiliateId,
    linkId: link.id,
    clickId: click.id,
  };
}

// ---------------------------------------------------------------------------
// Discount codes
// ---------------------------------------------------------------------------

/** Codes are stored and looked up upper-cased, without surrounding space. */
export function normalizeDiscountCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export interface DiscountCodeAttribution {
  programId: string;
  affiliateId: string;
  discountCodeId: string;
  discountBps: number;
}

/**
 * Reverse-look-up a checkout code to its affiliate. Same liveness rules
 * as tokens: disabled code, non-ACTIVE affiliate or inactive program
 * means the code does not validate (null).
 */
export async function resolveDiscountCode(
  db: PrismaClient,
  rawCode: string | null | undefined,
): Promise<DiscountCodeAttribution | null> {
  if (!rawCode) return null;
  const code = normalizeDiscountCode(rawCode);
  if (code === "") return null;
  const found = await db.discountCode.findUnique({
    where: { code },
    include: {
      affiliate: { select: { status: true } },
      program: { select: { isActive: true } },
    },
  });
  if (!found || !found.isActive) return null;
  if (found.affiliate.status !== "ACTIVE") return null;
  if (!found.program.isActive) return null;
  return {
    programId: found.programId,
    affiliateId: found.affiliateId,
    discountCodeId: found.id,
    discountBps: found.discountBps,
  };
}
