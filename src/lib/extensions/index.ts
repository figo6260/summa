/**
 * Summa extension points.
 *
 * The open-source core defines four stable seams (see docs/replication-plan.md
 * §3.2, as amended by the 2026-11-12 decision record in §6):
 *
 * 1. PaymentAdapter    — payment platform webhooks → normalized events
 * 2. PayoutProvider    — executing / recording payout batches
 * 3. Conversion hooks  — pre/post checks around conversion recording
 * 4. Brand config      — single surface for all brand-facing values
 *
 * Paid capabilities (Paddle adapter, anti-fraud, automated payouts,
 * white-label, multi-program) implement these seams but live outside this
 * repository: they run only in the hosted Pro edition.
 */
export * from "./payment-adapter";
export * from "./payout-provider";
export * from "./conversion-hooks";
export * from "./brand";
