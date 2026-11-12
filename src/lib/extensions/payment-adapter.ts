/**
 * Extension point 1 of 4 — PaymentAdapter.
 *
 * Normalizes a payment platform's webhooks into Summa's internal payment
 * events, so the commission engine never talks to a platform directly.
 *
 * Implementations:
 * - Core (open source): a Stripe adapter ships with the core as the
 *   reference implementation (v1 milestone M3).
 * - Pro (hosted only, NOT in this repo): the Paddle adapter suite. It is
 *   deployed only in the hosted Pro environment and never distributed
 *   with the open-source core.
 */

export type NormalizedPaymentEventType =
  | "payment_succeeded" // first payment / one-off purchase
  | "payment_renewed" // subscription renewal payment
  | "payment_refunded" // full or partial refund
  | "payment_chargebacked"; // dispute / chargeback

export interface NormalizedPaymentEvent {
  type: NormalizedPaymentEventType;
  /** Platform-side unique event id — used for delivery deduplication. */
  externalEventId: string;
  /** Platform-side transaction / invoice id. */
  externalTransactionId: string;
  /** Merchant order id if the platform exposes one. */
  externalOrderId?: string;
  /** Opaque customer reference (platform customer id). */
  customerRef?: string;
  /** Gross amount paid, integer cents. Refunds carry the refunded amount. */
  amountCents: number;
  currency: string;
  /**
   * Passthrough data the merchant attached at checkout (e.g. the affiliate
   * reference captured by the tracking layer), if the platform returns it.
   */
  attribution?: Record<string, string>;
  occurredAt: Date;
}

export interface PaymentWebhookRequest {
  /** Raw request body, exactly as received (needed for signature checks). */
  rawBody: string;
  /** Lower-cased header map of the webhook request. */
  headers: Record<string, string | undefined>;
}

export interface PaymentAdapter {
  /** Stable platform identifier, e.g. "stripe". */
  readonly platform: string;

  /** Verify the webhook signature against the platform's signing secret. */
  verifySignature(request: PaymentWebhookRequest): Promise<boolean>;

  /**
   * Parse one webhook delivery into zero or more normalized events.
   * Must be pure: no database access, no side effects.
   */
  parseEvent(request: PaymentWebhookRequest): Promise<NormalizedPaymentEvent[]>;
}
