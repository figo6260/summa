import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  NormalizedPaymentEvent,
  PaymentAdapter,
  PaymentWebhookRequest,
} from "../extensions/payment-adapter";

/**
 * Stripe adapter (M3) — the core's reference PaymentAdapter.
 *
 * Implemented from Stripe's documented webhook format, without the
 * official SDK: signature verification is HMAC-SHA256 over
 * `${timestamp}.${rawBody}` keyed with the webhook signing secret,
 * compared in constant time, with a 300-second timestamp tolerance.
 *
 * Event mapping (Stripe event → normalized event):
 *
 *   invoice.paid / invoice.payment_succeeded
 *       billing_reason = subscription_cycle → payment_renewed
 *       otherwise                           → payment_succeeded
 *       amount = amount_paid, order id = invoice id
 *   checkout.session.completed              → payment_succeeded
 *       amount = amount_total, order id = session id
 *   charge.refunded                         → payment_refunded
 *       amount = amount_refunded, order id = charge.invoice ?? charge id
 *   refund.created                          → payment_refunded
 *       amount = amount, order id = refund.charge (best effort: a refund
 *       object carries no invoice reference)
 *   charge.dispute.created                  → payment_chargebacked
 *       amount = amount, order id = charge.invoice ?? charge id
 *
 * Attribution passthrough: the merchant attaches `summa_code` (discount
 * code) and/or `summa_vid` (visitor token) as metadata at checkout time;
 * whichever object carries them (session / invoice / charge metadata)
 * they are read from there. Currency is upper-cased.
 */

export const STRIPE_TOLERANCE_SECONDS = 300;

export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!signatureHeader || !secret) return false;
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t") timestamp = value;
    if (key === "v1" && value) signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowSeconds - ts) > STRIPE_TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  return signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, "utf8");
    return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
  });
}

interface StripeObject {
  [key: string]: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asAmount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function attributionFrom(obj: StripeObject): Record<string, string> | undefined {
  const metadata = obj.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const meta = metadata as Record<string, unknown>;
  const out: Record<string, string> = {};
  const code = asString(meta.summa_code);
  const vid = asString(meta.summa_vid);
  if (code) out.summa_code = code;
  if (vid) out.summa_vid = vid;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeStripeEvent(
  event: StripeObject,
): NormalizedPaymentEvent | null {
  const type = asString(event.type);
  const data = event.data as { object?: StripeObject } | undefined;
  const obj = data?.object;
  if (!type || !obj) return null;
  const eventId = asString(event.id) ?? "";
  const occurredAt =
    typeof event.created === "number"
      ? new Date(event.created * 1000)
      : new Date();
  const currency = (asString(obj.currency) ?? "USD").toUpperCase();
  const base = { externalEventId: eventId, currency, occurredAt };

  switch (type) {
    case "invoice.paid":
    case "invoice.payment_succeeded": {
      const renewed = obj.billing_reason === "subscription_cycle";
      return {
        ...base,
        type: renewed ? "payment_renewed" : "payment_succeeded",
        externalTransactionId: asString(obj.id) ?? "",
        externalOrderId: asString(obj.id),
        customerRef: asString(obj.customer),
        amountCents: asAmount(obj.amount_paid),
        attribution: attributionFrom(obj),
      };
    }
    case "checkout.session.completed": {
      return {
        ...base,
        type: "payment_succeeded",
        externalTransactionId: asString(obj.id) ?? "",
        externalOrderId: asString(obj.id),
        customerRef:
          asString(obj.customer) ??
          asString(obj.customer_email) ??
          asString((obj.customer_details as StripeObject | undefined)?.email),
        amountCents: asAmount(obj.amount_total),
        attribution: attributionFrom(obj),
      };
    }
    case "charge.refunded": {
      return {
        ...base,
        type: "payment_refunded",
        externalTransactionId: asString(obj.id) ?? "",
        externalOrderId: asString(obj.invoice) ?? asString(obj.id),
        customerRef: asString(obj.customer),
        amountCents: asAmount(obj.amount_refunded ?? obj.amount),
        attribution: attributionFrom(obj),
      };
    }
    case "refund.created": {
      return {
        ...base,
        type: "payment_refunded",
        externalTransactionId: asString(obj.id) ?? "",
        externalOrderId: asString(obj.charge) ?? asString(obj.id),
        customerRef: undefined,
        amountCents: asAmount(obj.amount),
        attribution: attributionFrom(obj),
      };
    }
    case "charge.dispute.created": {
      return {
        ...base,
        type: "payment_chargebacked",
        externalTransactionId: asString(obj.charge) ?? asString(obj.id) ?? "",
        externalOrderId:
          asString(obj.invoice) ?? asString(obj.charge) ?? asString(obj.id),
        customerRef: undefined,
        amountCents: asAmount(obj.amount),
        attribution: attributionFrom(obj),
      };
    }
    default:
      return null;
  }
}

export function createStripeAdapter(webhookSecret: string): PaymentAdapter {
  return {
    platform: "stripe",
    async verifySignature(request: PaymentWebhookRequest): Promise<boolean> {
      return verifyStripeSignature(
        request.rawBody,
        request.headers["stripe-signature"],
        webhookSecret,
      );
    },
    async parseEvent(
      request: PaymentWebhookRequest,
    ): Promise<NormalizedPaymentEvent[]> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(request.rawBody);
      } catch {
        return [];
      }
      if (!parsed || typeof parsed !== "object") return [];
      const normalized = normalizeStripeEvent(parsed as StripeObject);
      return normalized ? [normalized] : [];
    },
  };
}
