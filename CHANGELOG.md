# Changelog

All notable changes to Summa are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-12

A visual release: the admin console and affiliate portal get a proper
design system and a modern shell. No features, data model, or accounting
behavior changed — this is a reskin only, verified by the same 219
end-to-end checks that ship in `tests/`.

### Changed

- **Design system** — the global stylesheet was rebuilt around CSS
  variables (an indigo brand color with slate neutrals) and reusable
  component classes for cards, tables, forms, buttons, and feedback
  banners. No new dependencies and no CSS framework.
- **Sidebar layout** — both portals moved from a top link row to a
  fixed left sidebar with a brand block and active-page highlighting,
  plus a sticky top bar carrying the language switcher and sign-out.
  On narrow screens the sidebar folds into a top strip with a
  horizontally scrollable nav; wide tables scroll inside their card
  instead of stretching the page.
- **Card-style auth pages** — admin sign-in, affiliate sign-in,
  first-run `/setup`, and affiliate activation are now centered cards
  with the Summa brand mark.
- **Status badges** — commission, payout, affiliate, link, and
  conversion statuses render as tinted pills (holding / available /
  paid / rejected / reversed, pending / failed, active / disabled),
  using the existing localized labels; money columns are
  right-aligned with tabular figures.
- **Demo screenshots** in the README were refreshed to the new
  interface.

## [1.0.0] - 2026-11-12

First public release of the Summa open-source core: a self-hosted affiliate
marketing platform — recruit affiliates, track referrals, compute
commissions, and pay out.

### Added

- **Programs & affiliates** — one affiliate program per install, with
  per-program settings: commission rate (basis points, with
  floor/nearest/ceil rounding), buyer discount, attribution window,
  commission hold days, minimum payout, payout day of month. Affiliates
  join by admin invitation (one-time activation links); statuses: pending
  activation / active / disabled. One-time `/setup` flow for the first
  admin, scrypt password hashing, signed session cookies, and an audit
  log of key operations.
- **Dual attribution & click tracking** — referral links (`/r/:code`)
  record the click (referrer, IP, user agent), set a visitor cookie and
  carry the visitor token in the redirect URL; last-click attribution
  within the program's window; unknown or disabled codes record no click.
  Discount codes are created by the admin (normalized, globally unique)
  and assigned to one affiliate; a discount code wins over the visitor
  token when both are present.
- **Conversion tracking API** — server-to-server
  `POST /api/v1/conversions` with API-key authentication (keys stored
  hashed, shown in full only once), per-key rate limiting, and strict
  idempotency — the same idempotency key or the same order id never
  double-counts. Unattributed calls are rejected with 422.
- **Stripe adapter** — a webhook endpoint (`POST /api/webhooks/stripe`)
  with signature verification that normalizes Stripe payment / renewal /
  refund / chargeback events into the same conversion pipeline;
  unattributed events are acknowledged with an audit note.
- **Commission engine** — every conversion creates exactly one commission
  that starts in *holding* and matures to *available* after the hold
  period (release job plus an admin action). Admin review queue: approve,
  or reject with a reason. Refunds claw commissions back proportionally
  (cumulative), chargebacks in full — including commissions already paid
  out, which become a debt netted against future earnings.
- **Payouts** — settlement generation sweeps each affiliate's available
  commissions into a payout showing gross / debt offset / net. Admins
  mark payouts paid (method + external reference required) or failed
  (commissions return to the available pool). Payout lists and
  per-payout detail export to CSV for reconciliation.
- **Two portals** — an admin console (overview, program settings,
  affiliates, clicks, conversions, commissions, payouts, API keys,
  email log, audit log) and an affiliate portal (overview, links &
  materials, commissions, payout history, profile & notification
  preferences).
- **Transactional email** — invite, commission-available,
  commission-rejected and payout-paid messages, honouring per-affiliate
  notification preferences. Two transports: `log` (recorded in the
  database, visible in the admin console — the default) and `smtp`.
- **7 languages** — the full UI and email templates ship in English,
  Traditional Chinese, Japanese, Korean, Spanish, Portuguese and French,
  with a locked terminology glossary (`docs/i18n-glossary.md`) and a
  validation script that checks key/placeholder parity across locales.
- **Deployment & demo data** — multi-stage Dockerfile and a one-command
  Docker Compose release stack (app + PostgreSQL; the schema is applied
  on boot). A demo seed builds a complete sample program — affiliates,
  links, a discount code, clicks, conversions, commissions in every
  state and a paid payout — for evaluation.
- **Tests & CI** — end-to-end suites under `tests/` cover the areas
  above (219 checks plus the i18n validation) and run in GitHub Actions
  on every push and pull request.
