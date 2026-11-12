/**
 * Status badge (v1.1 design system): renders an existing, already
 * localized status label inside a tinted pill. The tone is derived from
 * the raw status code only — the visible text is always the label the
 * caller passes in, so no copy changes anywhere.
 */
const TONES: Record<string, string> = {
  // commissions
  HOLDING: "amber",
  AVAILABLE: "green",
  PAID: "indigo",
  REJECTED: "red",
  REVERSED: "slate",
  // payouts
  PENDING: "amber",
  FAILED: "red",
  // affiliates
  ACTIVE: "green",
  DISABLED: "slate",
  PENDING_ACTIVATION: "amber",
  // conversions
  CONFIRMED: "green",
  REFUNDED: "amber",
  CHARGEBACKED: "red",
};

export default function StatusBadge({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  const tone = TONES[status] ?? "slate";
  return <span className={`badge badge-${tone}`}>{label}</span>;
}
