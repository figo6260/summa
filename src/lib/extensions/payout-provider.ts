/**
 * Extension point 2 of 4 — PayoutProvider.
 *
 * Executes (or records) the actual money movement behind a Payout batch.
 *
 * Implementations:
 * - Core (open source): the manual provider — an admin marks the payout as
 *   paid with a method + external reference, and the provider just records
 *   it (v1 milestone M5).
 * - Pro (hosted only, NOT in this repo): automated providers that move
 *   money via Wise / PayPal / Stripe Connect, with status callbacks and
 *   retry handling.
 */

export interface PayoutExecutionRequest {
  payoutId: string;
  affiliateId: string;
  /** Total to send, integer cents. */
  amountCents: number;
  currency: string;
  /** Affiliate-supplied payout details (account identifiers), opaque JSON. */
  payoutDetails: Record<string, unknown> | null;
}

export interface PayoutExecutionResult {
  status: "paid" | "pending" | "failed";
  /** Transfer reference from the payment channel, when available. */
  externalRef?: string;
  /** Human-readable failure reason when status is "failed". */
  failureReason?: string;
}

export interface PayoutProvider {
  /** Stable provider identifier, e.g. "manual". */
  readonly provider: string;

  /** Execute one payout batch. Implementations must be idempotent per payoutId. */
  execute(request: PayoutExecutionRequest): Promise<PayoutExecutionResult>;
}
