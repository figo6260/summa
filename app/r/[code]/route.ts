import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { handleReferralClick, VISITOR_COOKIE } from "@/lib/attribution";

export const dynamic = "force-dynamic";

/**
 * GET /r/:code — the referral redirect endpoint.
 *
 * Kept as thin as possible: all rules live in handleReferralClick (one
 * indexed lookup + one click insert). Unknown/disabled code, disabled
 * affiliate or inactive program → 404 and NO click is recorded.
 * A live click 302s to the target with the visitor token appended, and
 * also sets the summa_vid cookie (dual channel — see attribution.ts).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const forwardedFor = request.headers.get("x-forwarded-for");
  const ipAddress =
    forwardedFor?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    null;
  const result = await handleReferralClick(
    prisma,
    code,
    {
      referrer: request.headers.get("referer"),
      ipAddress,
      userAgent: request.headers.get("user-agent"),
    },
    request.nextUrl.origin,
  );
  if (result.kind === "not_found") {
    return new NextResponse("Not found", { status: 404 });
  }
  const response = NextResponse.redirect(result.location, 302);
  response.cookies.set(VISITOR_COOKIE, result.visitorToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: result.cookieMaxAgeSeconds,
  });
  return response;
}
