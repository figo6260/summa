/**
 * Pure parsing/validation for the program settings form.
 *
 * Zero-value rule: a field the admin
 * explicitly set to 0 must stay 0. Parsers therefore distinguish
 * "not provided" (undefined) from "provided as 0" and never fall back
 * through `||` on numeric values.
 */

export type CommissionRoundingInput = "FLOOR" | "NEAREST" | "CEIL";

export interface ProgramInput {
  name: string;
  slug: string;
  commissionRateBps: number;
  /// How fractional commissions round to whole cents (M4).
  commissionRounding: CommissionRoundingInput;
  buyerDiscountBps: number;
  currency: string;
  attributionWindowDays: number;
  holdDays: number;
  minPayoutCents: number;
  payoutDayOfMonth: number;
  /// Default landing page for referral links without their own target
  /// (M2). Absent/blank in the form means null, never a fallback string.
  defaultTargetUrl: string | null;
  isActive: boolean;
}

export type ProgramFormResult =
  | { ok: true; value: ProgramInput }
  | { ok: false; error: string };

/**
 * A referral target is either an absolute http(s) URL or a site-local
 * path starting with "/" (but not a protocol-relative "//host" URL).
 * Shared by the program form, link creation and the redirect endpoint.
 */
export function isValidTargetUrl(raw: string): boolean {
  if (raw.startsWith("/")) return !raw.startsWith("//");
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseIntField(
  raw: string | undefined,
  field: string,
  min: number,
  max: number,
): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === undefined || raw.trim() === "") {
    return { ok: false, error: `${field} is required` };
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    return { ok: false, error: `${field} must be a whole number` };
  }
  if (value < min || value > max) {
    return { ok: false, error: `${field} must be between ${min} and ${max}` };
  }
  // Explicit zero is a real value: return it as-is (never `value || fallback`).
  return { ok: true, value };
}

/**
 * Parse program form fields. `fields` maps field name to the raw string
 * from the form (undefined when the input was absent). Percentages are
 * given in basis points by the form itself, so no conversion happens here.
 */
export function parseProgramForm(
  fields: Record<string, string | undefined>,
): ProgramFormResult {
  const name = fields.name?.trim() ?? "";
  if (name === "") return { ok: false, error: "name is required" };
  const slug = (fields.slug?.trim() ?? "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return { ok: false, error: "slug must use lowercase letters, digits and dashes" };
  }
  const currency = (fields.currency?.trim() ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, error: "currency must be a 3-letter code" };
  }
  const commission = parseIntField(fields.commissionRateBps, "commissionRateBps", 0, 10000);
  if (!commission.ok) return commission;
  // Rounding mode (M4): an absent field keeps the FLOOR default (older
  // forms), a provided value must be one of the three modes.
  const roundingRaw = fields.commissionRounding?.trim().toUpperCase() ?? "";
  let commissionRounding: CommissionRoundingInput = "FLOOR";
  if (roundingRaw !== "") {
    if (
      roundingRaw !== "FLOOR" &&
      roundingRaw !== "NEAREST" &&
      roundingRaw !== "CEIL"
    ) {
      return { ok: false, error: "commissionRounding must be FLOOR, NEAREST or CEIL" };
    }
    commissionRounding = roundingRaw;
  }
  const discount = parseIntField(fields.buyerDiscountBps, "buyerDiscountBps", 0, 10000);
  if (!discount.ok) return discount;
  const attribution = parseIntField(fields.attributionWindowDays, "attributionWindowDays", 0, 3650);
  if (!attribution.ok) return attribution;
  const hold = parseIntField(fields.holdDays, "holdDays", 0, 3650);
  if (!hold.ok) return hold;
  const minPayout = parseIntField(fields.minPayoutCents, "minPayoutCents", 0, 100000000);
  if (!minPayout.ok) return minPayout;
  const payoutDay = parseIntField(fields.payoutDayOfMonth, "payoutDayOfMonth", 1, 28);
  if (!payoutDay.ok) return payoutDay;
  const targetRaw = fields.defaultTargetUrl?.trim() ?? "";
  let defaultTargetUrl: string | null = null;
  if (targetRaw !== "") {
    if (!isValidTargetUrl(targetRaw)) {
      return { ok: false, error: "defaultTargetUrl must be an http(s) URL or a path starting with /" };
    }
    defaultTargetUrl = targetRaw;
  }

  return {
    ok: true,
    value: {
      name,
      slug,
      commissionRateBps: commission.value,
      commissionRounding,
      buyerDiscountBps: discount.value,
      currency,
      attributionWindowDays: attribution.value,
      holdDays: hold.value,
      minPayoutCents: minPayout.value,
      payoutDayOfMonth: payoutDay.value,
      defaultTargetUrl,
      // Checkbox semantics: absent means unchecked, any provided value
      // other than "false"/"0" means checked.
      isActive:
        fields.isActive !== undefined &&
        fields.isActive !== "false" &&
        fields.isActive !== "0",
    },
  };
}
