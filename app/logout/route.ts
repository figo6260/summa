import { NextResponse } from "next/server";
import { destroySession } from "@/lib/auth";

/**
 * Sign out is POST-only on purpose: a GET endpoint that destroys the
 * session would be triggered by link prefetching and crawlers.
 */
export async function POST() {
  await destroySession();
  // Relative Location: the browser resolves it against the origin it
  // actually used (request.url's host is not reliable behind proxies).
  return new NextResponse(null, { status: 303, headers: { Location: "/" } });
}
