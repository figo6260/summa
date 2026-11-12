import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Transactional email templates (M5).
 *
 * The copy is ours, lives in the i18n dictionaries (`mail.*` keys in
 * public/messages/{locale}.json, English is the source) and is rendered
 * here with {placeholder} substitution. Dictionaries are read from disk
 * instead of imported so this module also works from the standalone
 * scripts (release/generate CLIs compile the lib layer with plain tsc,
 * which cannot resolve the JSON imports the Next build uses).
 *
 * This product has no email-verification-code flow on purpose (M1: an
 * invite link *is* the verification — a pending account sets its
 * password through the link, so activation can never deadlock on a
 * code that never arrives). The `invite` template below is therefore
 * the verification-class email of this product.
 */

export type EmailLocale = string;

type Dict = Record<string, unknown>;

const dictCache = new Map<string, Dict>();

function loadDict(locale: string): Dict {
  const cached = dictCache.get(locale);
  if (cached) return cached;
  let dict: Dict = {};
  try {
    const raw = readFileSync(
      join(process.cwd(), "public", "messages", `${locale}.json`),
      "utf8",
    );
    dict = JSON.parse(raw) as Dict;
  } catch {
    dict = {};
  }
  dictCache.set(locale, dict);
  return dict;
}

function lookup(locale: string, path: string): string {
  let node: unknown = loadDict(locale);
  for (const part of path.split(".")) {
    if (node && typeof node === "object") {
      node = (node as Dict)[part];
    } else {
      node = undefined;
      break;
    }
  }
  if (typeof node === "string") return node;
  if (locale !== "en") return lookup("en", path);
  return path;
}

function fill(
  template: string,
  vars: Record<string, string | number>,
): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(String(value));
  }
  return out;
}

export interface RenderedEmail {
  subject: string;
  body: string;
}

function render(
  locale: EmailLocale,
  key: string,
  vars: Record<string, string | number>,
): RenderedEmail {
  return {
    subject: fill(lookup(locale, `mail.${key}Subject`), vars),
    body: fill(lookup(locale, `mail.${key}Body`), vars),
  };
}

/** Invite / re-issued activation link — the verification-class email. */
export function inviteEmail(
  locale: EmailLocale,
  vars: {
    programName: string;
    affiliateName: string;
    activationUrl: string;
    expiresAt: string;
  },
): RenderedEmail {
  return render(locale, "invite", vars);
}

/** Aggregated "your commissions became available" notice (per release run). */
export function commissionAvailableEmail(
  locale: EmailLocale,
  vars: {
    programName: string;
    affiliateName: string;
    count: number;
    amountCents: number;
    currency: string;
  },
): RenderedEmail {
  return render(locale, "commissionAvailable", vars);
}

/** A commission was rejected by an admin; the reason is included. */
export function commissionRejectedEmail(
  locale: EmailLocale,
  vars: {
    programName: string;
    affiliateName: string;
    orderId: string;
    amountCents: number;
    currency: string;
    reason: string;
  },
): RenderedEmail {
  return render(locale, "commissionRejected", vars);
}

/** A payout was marked paid. */
export function payoutPaidEmail(
  locale: EmailLocale,
  vars: {
    programName: string;
    affiliateName: string;
    totalCents: number;
    currency: string;
    method: string;
    externalRef: string;
  },
): RenderedEmail {
  return render(locale, "payoutPaid", vars);
}
