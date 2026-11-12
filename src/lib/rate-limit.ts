/**
 * Fixed-window, per-key rate limiting for the S2S conversion API (M3).
 *
 * Deliberately process-local: the open-source core runs as a single
 * instance, so an in-memory counter is honest and sufficient. A
 * multi-instance deployment needs a shared counter — that is an
 * operational (hosted Pro) concern, not core behaviour.
 */

const WINDOW_MS = 60 * 1000;

interface WindowState {
  windowStart: number;
  count: number;
}

const windows = new Map<string, WindowState>();

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the current window closes (for Retry-After). */
  retryAfterSeconds: number;
}

export function checkRateLimit(keyId: string, limit: number): RateLimitResult {
  const now = Date.now();
  const state = windows.get(keyId);
  if (!state || now - state.windowStart >= WINDOW_MS) {
    windows.set(keyId, { windowStart: now, count: 1 });
    return { ok: true, retryAfterSeconds: 0 };
  }
  state.count += 1;
  if (state.count > limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((state.windowStart + WINDOW_MS - now) / 1000),
      ),
    };
  }
  return { ok: true, retryAfterSeconds: 0 };
}

/** Test helper: forget all counters. */
export function resetRateLimits(): void {
  windows.clear();
}
