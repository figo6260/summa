import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { signSession, verifySession, type SessionPayload } from "./jwt";

/**
 * Session handling. The JWT lives in an httpOnly cookie and is verified
 * directly on every request — validation never round-trips through a
 * separate "me" endpoint.
 */
export const SESSION_COOKIE = "summa-session";

/**
 * The session cookie is Secure by default in production. Self-hosters who
 * serve the core over plain HTTP (local evaluation, internal networks)
 * can set SESSION_COOKIE_SECURE=false, otherwise browsers refuse to
 * store the cookie and sign-in cannot persist.
 */
function cookieSecure(): boolean {
  const explicit = process.env.SESSION_COOKIE_SECURE;
  if (explicit !== undefined) return explicit === "true";
  return process.env.NODE_ENV === "production";
}

export async function createSession(payload: {
  sub: string;
  role: "admin" | "affiliate";
  email: string;
}): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, signSession(payload), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
    secure: cookieSecure(),
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}

export async function requireAdmin(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session || session.role !== "admin") redirect("/admin/login");
  return session;
}

export async function requireAffiliate(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session || session.role !== "affiliate") redirect("/affiliate/login");
  return session;
}
