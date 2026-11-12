/**
 * Extension point 3 of 4 — conversion pipeline hooks.
 *
 * The conversion pipeline (attribution → record → commission) exposes one
 * hook before a conversion is recorded and one after. With no hook
 * registered, the pipeline passes straight through.
 *
 * Implementations:
 * - Core (open source): none required — the hooks are extension seams only.
 * - Pro (hosted only, NOT in this repo): the anti-fraud package registers a
 *   `beforeConversion` hook (click-fraud signals, self-referral and
 *   duplicate-device checks, freeze-for-review queue), and reporting
 *   packages may subscribe to `afterConversion`.
 */

export interface ConversionContext {
  programId: string;
  affiliateId: string;
  externalOrderId: string;
  customerRef?: string;
  amountCents: number;
  currency: string;
  /** Attribution path: "link" | "code" | "api". */
  source: string;
  /** Signal bag integrations may read (ip, user agent, visitor token…). */
  signals: Record<string, string | undefined>;
}

export type BeforeConversionDecision =
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "review"; reason: string };

export interface ConversionPipelineHooks {
  /**
   * Runs before the conversion (and its commission) is written.
   * "block" rejects the conversion; "review" records it but freezes the
   * commission for manual review.
   */
  beforeConversion?(ctx: ConversionContext): Promise<BeforeConversionDecision>;

  /** Runs after the conversion and commission have been recorded. */
  afterConversion?(ctx: ConversionContext & { conversionId: string }): Promise<void>;
}
