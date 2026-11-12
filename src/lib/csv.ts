/**
 * CSV export helpers (M5) — the admin reconciliation downloads.
 *
 * Fields are quoted when they contain a comma, quote, or newline;
 * embedded quotes are doubled (RFC 4180). The builders are pure
 * functions so the test suite can feed them real database rows, parse
 * the output back, and re-add the money columns.
 */

export function csvEscape(value: string | number): string {
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(rows: (string | number)[][]): string {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n";
}

export interface PayoutDetailCsvRow {
  commissionId: string;
  externalOrderId: string;
  conversionDate: Date;
  orderAmountCents: number;
  commissionCents: number;
  currency: string;
}

/** One row per commission settled inside a payout. */
export function payoutDetailCsv(rows: PayoutDetailCsvRow[]): string {
  return toCsv([
    [
      "commission_id",
      "external_order_id",
      "conversion_date",
      "order_amount_cents",
      "commission_cents",
      "currency",
    ],
    ...rows.map((row) => [
      row.commissionId,
      row.externalOrderId,
      row.conversionDate.toISOString(),
      row.orderAmountCents,
      row.commissionCents,
      row.currency,
    ]),
  ]);
}

export interface PayoutListCsvRow {
  payoutId: string;
  affiliateEmail: string;
  periodStart: Date;
  periodEnd: Date;
  grossCents: number;
  debtOffsetCents: number;
  totalCents: number;
  currency: string;
  status: string;
  method: string;
  externalRef: string | null;
  paidAt: Date | null;
}

/** One row per payout in a settlement list export. */
export function payoutListCsv(rows: PayoutListCsvRow[]): string {
  return toCsv([
    [
      "payout_id",
      "affiliate_email",
      "period_start",
      "period_end",
      "gross_cents",
      "debt_offset_cents",
      "total_cents",
      "currency",
      "status",
      "method",
      "external_ref",
      "paid_at",
    ],
    ...rows.map((row) => [
      row.payoutId,
      row.affiliateEmail,
      row.periodStart.toISOString(),
      row.periodEnd.toISOString(),
      row.grossCents,
      row.debtOffsetCents,
      row.totalCents,
      row.currency,
      row.status,
      row.method,
      row.externalRef ?? "",
      row.paidAt ? row.paidAt.toISOString() : "",
    ]),
  ]);
}
