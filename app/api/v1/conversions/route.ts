import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateApiKey } from "@/lib/api-keys";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  ConversionPipelineError,
  recordConversion,
} from "@/lib/conversion";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/conversions — the server-to-server conversion intake.
 *
 * Auth: `Authorization: Bearer <key>` or `X-Api-Key: <key>`; every auth
 * failure is the same 401. Per-key fixed-window rate limit (default 300
 * requests/minute, override with SUMMA_API_RATE_LIMIT) → 429 with
 * Retry-After. Outcomes: 201 created · 200 duplicate (idempotent
 * replay) · 400 validation · 422 unattributed / blocked by a hook.
 */
function presentedKey(request: NextRequest): string | null {
  const auth = request.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return request.headers.get("x-api-key");
}

export async function POST(request: NextRequest) {
  const apiKey = await authenticateApiKey(prisma, presentedKey(request));
  if (!apiKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const limit = Number.parseInt(process.env.SUMMA_API_RATE_LIMIT ?? "300", 10);
  const rate = checkRateLimit(apiKey.id, Number.isFinite(limit) ? limit : 300);
  if (!rate.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const occurredAt =
    typeof input.occurredAt === "string" && input.occurredAt !== ""
      ? new Date(input.occurredAt)
      : null;
  if (occurredAt && Number.isNaN(occurredAt.getTime())) {
    return NextResponse.json(
      { error: "validation", reason: "occurredAt must be an ISO date" },
      { status: 400 },
    );
  }

  try {
    const result = await recordConversion(prisma, {
      programId: apiKey.programId,
      externalOrderId: String(input.externalOrderId ?? ""),
      amountCents:
        typeof input.amountCents === "number" ? input.amountCents : Number.NaN,
      currency: String(input.currency ?? ""),
      customerRef:
        typeof input.customerRef === "string" ? input.customerRef : null,
      idempotencyKey: String(input.idempotencyKey ?? ""),
      visitorToken:
        typeof input.visitorToken === "string" ? input.visitorToken : null,
      discountCode:
        typeof input.discountCode === "string" ? input.discountCode : null,
      occurredAt,
      isRenewal: input.isRenewal === true,
      source: "api",
    });
    return NextResponse.json(
      {
        id: result.conversion.id,
        duplicate: result.kind === "duplicate",
        affiliateId: result.conversion.affiliateId,
        amountCents: result.conversion.amountCents,
        currency: result.conversion.currency,
        isRenewal: result.conversion.isRenewal,
        status: result.conversion.status,
        commission: result.commission
          ? {
              id: result.commission.id,
              amountCents: result.commission.amountCents,
              status: result.commission.status,
              holdUntil: result.commission.holdUntil.toISOString(),
            }
          : null,
      },
      { status: result.kind === "created" ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof ConversionPipelineError) {
      if (error.code === "validation") {
        return NextResponse.json(
          { error: "validation", reason: error.reason },
          { status: 400 },
        );
      }
      if (error.code === "blocked") {
        return NextResponse.json(
          { error: "blocked", reason: error.reason },
          { status: 422 },
        );
      }
      return NextResponse.json({ error: "unattributed" }, { status: 422 });
    }
    throw error;
  }
}
