import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { getSingleProgram } from "@/lib/services";
import { createStripeAdapter } from "@/lib/payments/stripe";
import {
  ConversionPipelineError,
  recordConversion,
} from "@/lib/conversion";
import { applyStripeReversal } from "@/lib/reversal";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/stripe — Stripe webhook intake.
 *
 * Unlike the S2S API, a webhook must not be refused for business
 * reasons (Stripe would retry forever): unattributed or blocked events
 * are acknowledged with 200 and an audit note is left instead. Only a
 * bad signature (400) or a missing webhook secret on our side (503)
 * fails the delivery.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "stripe_webhook_not_configured" },
      { status: 503 },
    );
  }
  const rawBody = await request.text();
  const headers: Record<string, string | undefined> = {
    "stripe-signature": request.headers.get("stripe-signature") ?? undefined,
  };
  const adapter = createStripeAdapter(secret);
  const verified = await adapter.verifySignature({ rawBody, headers });
  if (!verified) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }
  const events = await adapter.parseEvent({ rawBody, headers });
  const program = await getSingleProgram(prisma);

  for (const event of events) {
    if (!program) break;
    if (
      event.type === "payment_succeeded" ||
      event.type === "payment_renewed"
    ) {
      try {
        await recordConversion(prisma, {
          programId: program.id,
          externalOrderId: event.externalOrderId ?? event.externalTransactionId,
          amountCents: event.amountCents,
          currency: event.currency,
          customerRef: event.customerRef ?? null,
          idempotencyKey: `stripe:${event.externalEventId}`,
          visitorToken: event.attribution?.summa_vid ?? null,
          discountCode: event.attribution?.summa_code ?? null,
          occurredAt: event.occurredAt,
          isRenewal: event.type === "payment_renewed",
          source: "stripe",
          signals: { stripeEventId: event.externalEventId },
        });
      } catch (error) {
        if (
          error instanceof ConversionPipelineError &&
          (error.code === "unattributed" || error.code === "blocked")
        ) {
          await writeAudit(prisma, {
            programId: program.id,
            actorType: "SYSTEM",
            actorId: null,
            action:
              error.code === "unattributed"
                ? "stripe.unattributed"
                : "stripe.blocked",
            targetType: "StripeEvent",
            targetId: event.externalEventId,
            metadata: {
              type: event.type,
              externalOrderId: event.externalOrderId,
              reason: error.reason,
            },
          });
        } else {
          throw error;
        }
      }
    } else if (
      event.type === "payment_refunded" ||
      event.type === "payment_chargebacked"
    ) {
      // M4: refunds/chargebacks go through the shared clawback service.
      // For charge.refunded the normalized amount is Stripe's cumulative
      // amount_refunded; chargebacks claw back in full regardless.
      await applyStripeReversal(prisma, {
        programId: program.id,
        externalOrderId: event.externalOrderId ?? event.externalTransactionId,
        kind: event.type === "payment_refunded" ? "refund" : "chargeback",
        refundedTotalCents: event.amountCents,
        reason: `stripe:${event.externalEventId}`,
      });
    }
  }

  return NextResponse.json({ received: true });
}
