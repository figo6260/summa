import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal HS256 JSON Web Tokens, implemented on Node's built-in HMAC so
 * the core needs no extra dependency. Session validation verifies the
 * cookie token directly (signature + expiry) — no indirection through
 * another endpoint.
 */

export type SessionRole = "admin" | "affiliate";

export interface SessionPayload {
  sub: string;
  role: SessionRole;
  email: string;
  exp: number;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set to at least 16 characters in production");
  }
  return "summa-dev-session-secret-change-me";
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signSession(
  payload: { sub: string; role: SessionRole; email: string },
  secret: string = sessionSecret(),
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(
    JSON.stringify({ ...payload, exp: nowSeconds + SESSION_TTL_SECONDS }),
  );
  const data = `${header}.${body}`;
  return `${data}.${sign(data, secret)}`;
}

export function verifySession(
  token: string | undefined | null,
  secret: string = sessionSecret(),
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionPayload | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = sign(data, secret);
  const givenBuf = Buffer.from(parts[2]);
  const expectedBuf = Buffer.from(expected);
  if (givenBuf.length !== expectedBuf.length || !timingSafeEqual(givenBuf, expectedBuf)) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) return null;
    if (payload.role !== "admin" && payload.role !== "affiliate") return null;
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}
