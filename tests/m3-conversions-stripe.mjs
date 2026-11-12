/**
 * Summa test suite — conversion API, idempotency, Stripe adapter.
 * Repeatable and self-cleaning: fixtures are uniquely named and are
 * deleted again in `finally`.
 *
 * Covers:
 *  1. Idempotency: the same conversion posted 3x (incl. concurrently)
 *     lands exactly 1 conversion + 1 commission; the same order id with
 *     a fresh idempotency key is also blocked.
 *  2. Anchor arithmetic: 2465 cents at 1500 bps -> commission 369,
 *     HOLDING, holdUntil = occurredAt + 30 days.
 *  3. Attribution priority: discount code beats visitor token, token
 *     alone attributes, neither -> 422 unattributed and no row.
 *  4. API keys: missing/wrong/revoked -> 401; per-key rate limit -> 429
 *     (the test server runs with SUMMA_API_RATE_LIMIT=5).
 *  5. Pipeline hooks (library level): block prevents the write, review
 *     records with commission statusReason "pending_review"; manual
 *     adjustment recomputes the commission and refuses once the
 *     commission is no longer HOLDING.
 *  6. Stripe (events signed with the real HMAC rule against a test
 *     secret): payment -> conversion+commission, renewal -> second
 *     conversion, refund -> REFUNDED + commission REVERSED, dispute ->
 *     CHARGEBACKED, bad signature -> 400, redelivery is a no-op,
 *     unattributed events are acked (200) with an audit note.
 *
 * Needs a production build (builds one if .next is missing) and starts
 * a throwaway server on SUMMA_TEST_PORT (default 3461). Requires
 * DATABASE_URL; run via `npm run test:e2e` — see the README.
 */
import { execSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// --- environment -----------------------------------------------------------
// Configuration comes from the process environment. When a repo-root
// `.env` file exists it fills in anything not already set.
const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_]+)=="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}
const WEBHOOK_SECRET = "whsec_m3_test_secret";
const PORT = Number(process.env.SUMMA_TEST_PORT || 3461);
const BASE = `http://127.0.0.1:${PORT}`;

// --- compile the TS library layer with the project's tsc -------------------
mkdirSync(join(process.cwd(), "node_modules", ".cache"), { recursive: true });
const outDir = mkdtempSync(join(process.cwd(), "node_modules", ".cache", "summa-m3-test-"));
execSync(
  [
    "node_modules/.bin/tsc",
    "src/lib/services.ts",
    "src/lib/attribution.ts",
    "src/lib/conversion.ts",
    "src/lib/api-keys.ts",
    "src/lib/payments/stripe.ts",
    "--outDir", outDir,
    "--module commonjs",
    "--target es2022",
    "--moduleResolution node",
    "--esModuleInterop",
    "--strict",
    "--skipLibCheck",
  ].join(" "),
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const services = require(join(outDir, "services.js"));
const attribution = require(join(outDir, "attribution.js"));
const conversionLib = require(join(outDir, "conversion.js"));
const apiKeys = require(join(outDir, "api-keys.js"));
const hooksRegistry = require(join(outDir, "pipeline-hooks.js"));
const { hashPassword } = require(join(outDir, "password.js"));
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

// --- tiny assertion helpers --------------------------------------------------
let passed = 0;
function check(label, condition) {
  if (!condition) throw new Error(`FAILED: ${label}`);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

const suffix = `${Date.now()}`;
let admin = null;
let program = null;
let server = null;

async function postJson(path, { key, body, headers = {} }) {
  const finalHeaders = { "content-type": "application/json", ...headers };
  if (key) finalHeaders.authorization = `Bearer ${key}`;
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: finalHeaders,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
}

function stripePost(event, { secret = WEBHOOK_SECRET, sign = true } = {}) {
  const body = JSON.stringify(event);
  const headers = { "content-type": "application/json" };
  if (sign) {
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    headers["stripe-signature"] = `t=${t},v1=${v1}`;
  }
  return fetch(`${BASE}/api/webhooks/stripe`, { method: "POST", headers, body }).then(
    async (res) => ({ status: res.status, json: await res.json().catch(() => null) }),
  );
}

async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.status > 0) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("test server did not start");
}

try {
  check("clean slate: no pre-existing program", (await db.program.count()) === 0);

  // --- fixtures ---------------------------------------------------------------
  if (await services.adminExists(db)) {
    admin = await db.admin.create({
      data: {
        name: "M3 Test Admin",
        email: `m3-admin-${suffix}@example.test`,
        passwordHash: hashPassword("test-password-1"),
      },
    });
  } else {
    admin = await services.setupAdmin(db, {
      name: "M3 Test Admin",
      email: `m3-admin-${suffix}@example.test`,
      password: "test-password-1",
    });
  }
  program = await services.createProgram(db, admin.id, {
    name: "M3 Test Program",
    slug: `m3-test-${suffix}`,
    commissionRateBps: 1500,
    buyerDiscountBps: 1500,
    currency: "USD",
    attributionWindowDays: 30,
    holdDays: 30,
    minPayoutCents: 0,
    payoutDayOfMonth: 10,
    defaultTargetUrl: "https://example.com/land",
    isActive: true,
  });

  const inviteA = await services.inviteAffiliate(db, admin.id, program.id, {
    name: "Partner A",
    email: `m3-a-${suffix}@example.test`,
  });
  const affiliateA = await services.activateAffiliate(db, inviteA.token, "partner-password-1");
  const inviteB = await services.inviteAffiliate(db, admin.id, program.id, {
    name: "Partner B",
    email: `m3-b-${suffix}@example.test`,
  });
  const affiliateB = await services.activateAffiliate(db, inviteB.token, "partner-password-1");
  check("fixtures: two active affiliates", affiliateA.status === "ACTIVE" && affiliateB.status === "ACTIVE");

  const link = await services.createReferralLink(
    db,
    { type: "AFFILIATE", id: affiliateA.id },
    affiliateA.id,
    { channel: "m3-test" },
  );
  const clickResult = await attribution.handleReferralClick(
    db,
    link.code,
    { referrer: "https://blog.example/post", ipAddress: "203.0.113.7", userAgent: "M3Test/1.0" },
    BASE,
  );
  check("fixtures: click recorded with visitor token", clickResult.kind === "redirect" && !!clickResult.visitorToken);
  const tokenA = clickResult.visitorToken;

  const codeB = await services.createDiscountCode(db, admin.id, affiliateB.id, {
    code: "M3CODE15",
    discountBps: 1500,
  });
  check("fixtures: discount code for affiliate B", codeB.code === "M3CODE15");

  // --- pipeline-level: hooks + manual adjustment --------------------------------
  hooksRegistry.registerConversionHooks({
    beforeConversion: async () => ({ action: "block", reason: "fraud_suspected" }),
  });
  let blockedError = null;
  try {
    await conversionLib.recordConversion(db, {
      programId: program.id,
      externalOrderId: "ord-blocked",
      amountCents: 1000,
      currency: "USD",
      idempotencyKey: "idem-blocked",
      visitorToken: tokenA,
      source: "api",
    });
  } catch (error) {
    blockedError = error;
  }
  check("hook: block decision surfaces as blocked error", blockedError?.code === "blocked");
  check(
    "hook: blocked conversion wrote nothing",
    (await db.conversion.count({ where: { externalOrderId: "ord-blocked" } })) === 0,
  );
  hooksRegistry.clearConversionHooks();

  hooksRegistry.registerConversionHooks({
    beforeConversion: async () => ({ action: "review", reason: "first_order" }),
  });
  const reviewed = await conversionLib.recordConversion(db, {
    programId: program.id,
    externalOrderId: "ord-review",
    amountCents: 2000,
    currency: "USD",
    idempotencyKey: "idem-review",
    visitorToken: tokenA,
    source: "api",
  });
  hooksRegistry.clearConversionHooks();
  check("hook: review still records the conversion", reviewed.kind === "created");
  check(
    "hook: review stamps commission pending_review",
    reviewed.commission.statusReason === "pending_review" && reviewed.commission.amountCents === 300,
  );

  const adjusted = await conversionLib.adjustConversion(db, admin.id, reviewed.conversion.id, {
    amountCents: 3000,
    reason: "amount correction",
  });
  const adjustedCommission = await db.commission.findUnique({
    where: { conversionId: reviewed.conversion.id },
  });
  check(
    "adjust: amount + recomputed commission (3000 x 15% = 450)",
    adjusted.amountCents === 3000 && adjustedCommission.amountCents === 450,
  );
  const adjustAudit = await db.auditLog.findFirst({
    where: { action: "conversion.adjust", targetId: reviewed.conversion.id },
  });
  check("adjust: audit entry carries the reason", adjustAudit?.metadata?.reason === "amount correction");
  await db.commission.update({
    where: { id: adjustedCommission.id },
    data: { status: "AVAILABLE" },
  });
  let adjustError = null;
  try {
    await conversionLib.adjustConversion(db, admin.id, reviewed.conversion.id, {
      amountCents: 4000,
      reason: "too late",
    });
  } catch (error) {
    adjustError = error;
  }
  check("adjust: refused once commission is not HOLDING", adjustError?.message === "commission_not_holding");

  // --- start the production server ---------------------------------------------
  if (!existsSync(join(process.cwd(), ".next", "BUILD_ID"))) {
    execSync("npm run build", { stdio: "inherit" });
  }
  server = spawn("node_modules/.bin/next", ["start", "-p", String(PORT)], {
    env: {
      ...process.env,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      SUMMA_API_RATE_LIMIT: "5",
      SESSION_COOKIE_SECURE: "false",
    },
    stdio: "ignore",
  });
  await waitForServer();
  check("server: production build responding", true);

  const newKey = async (name) =>
    (await apiKeys.createApiKey(db, admin.id, program.id, name)).plain;

  // --- auth failures --------------------------------------------------------------
  const noKey = await postJson("/api/v1/conversions", { body: {} });
  check("auth: missing key -> 401", noKey.status === 401);
  const wrongKey = await postJson("/api/v1/conversions", {
    key: "summa_wrongwrongwrongwrong",
    body: {},
  });
  check("auth: wrong key -> 401", wrongKey.status === 401);
  const revoked = await apiKeys.createApiKey(db, admin.id, program.id, "revoked");
  await apiKeys.revokeApiKey(db, admin.id, revoked.apiKey.id);
  const revokedRes = await postJson("/api/v1/conversions", { key: revoked.plain, body: {} });
  check("auth: revoked key -> 401", revokedRes.status === 401);

  // --- idempotency (one key, exactly 5 requests) -----------------------------------
  const keyDup = await newKey("dup");
  const dupBody = {
    externalOrderId: "ord-dup",
    amountCents: 2465,
    currency: "USD",
    customerRef: "cust-1",
    idempotencyKey: "idem-dup",
    visitorToken: tokenA,
  };
  const first = await postJson("/api/v1/conversions", { key: keyDup, body: dupBody });
  check("idem: first post -> 201", first.status === 201 && first.json.duplicate === false);
  check(
    "idem: first commission is the 369 anchor",
    first.json.commission.amountCents === 369 && first.json.commission.status === "HOLDING",
  );
  const second = await postJson("/api/v1/conversions", { key: keyDup, body: dupBody });
  check("idem: sequential replay -> 200 duplicate", second.status === 200 && second.json.duplicate === true);
  const concurrent = await Promise.all([
    postJson("/api/v1/conversions", {
      key: keyDup,
      body: { ...dupBody, externalOrderId: "ord-conc", idempotencyKey: "idem-conc" },
    }),
    postJson("/api/v1/conversions", {
      key: keyDup,
      body: { ...dupBody, externalOrderId: "ord-conc", idempotencyKey: "idem-conc" },
    }),
    postJson("/api/v1/conversions", {
      key: keyDup,
      body: { ...dupBody, externalOrderId: "ord-conc", idempotencyKey: "idem-conc" },
    }),
  ]);
  const concStatuses = concurrent.map((r) => r.status).sort();
  check(
    "idem: concurrent x3 -> one 201 + two 200",
    JSON.stringify(concStatuses) === JSON.stringify([200, 200, 201]),
  );
  check(
    "idem: ord-conc stored exactly once with one commission",
    (await db.conversion.count({ where: { externalOrderId: "ord-conc" } })) === 1 &&
      (await db.commission.count({
        where: { conversion: { externalOrderId: "ord-conc" } },
      })) === 1,
  );
  const keyDup2 = await newKey("dup2");
  const orderDup = await postJson("/api/v1/conversions", {
    key: keyDup2,
    body: { ...dupBody, idempotencyKey: "idem-other" },
  });
  check(
    "idem: same order id, fresh key -> 200 duplicate, still one row",
    orderDup.status === 200 &&
      orderDup.json.duplicate === true &&
      (await db.conversion.count({ where: { externalOrderId: "ord-dup" } })) === 1,
  );

  // --- anchor arithmetic with explicit occurredAt ----------------------------------
  const keyAnchor = await newKey("anchor");
  const anchor = await postJson("/api/v1/conversions", {
    key: keyAnchor,
    body: {
      externalOrderId: "ord-anchor",
      amountCents: 2465,
      currency: "usd",
      idempotencyKey: "idem-anchor",
      visitorToken: tokenA,
      occurredAt: "2026-01-01T00:00:00.000Z",
    },
  });
  check("anchor: 201 created", anchor.status === 201);
  check(
    "anchor: commission 369, HOLDING, holdUntil = occurredAt + 30d",
    anchor.json.commission.amountCents === 369 &&
      anchor.json.commission.status === "HOLDING" &&
      anchor.json.commission.holdUntil === "2026-01-31T00:00:00.000Z",
  );

  // --- attribution priority -----------------------------------------------------------
  const keyAttr = await newKey("attr");
  const codeWins = await postJson("/api/v1/conversions", {
    key: keyAttr,
    body: {
      externalOrderId: "ord-code-wins",
      amountCents: 1000,
      currency: "USD",
      idempotencyKey: "idem-code-wins",
      visitorToken: tokenA,
      discountCode: "m3code15",
    },
  });
  check(
    "attribution: discount code beats visitor token",
    codeWins.status === 201 && codeWins.json.affiliateId === affiliateB.id,
  );
  const tokenOnly = await postJson("/api/v1/conversions", {
    key: keyAttr,
    body: {
      externalOrderId: "ord-token-only",
      amountCents: 1000,
      currency: "USD",
      idempotencyKey: "idem-token-only",
      visitorToken: tokenA,
    },
  });
  check(
    "attribution: token alone attributes to its affiliate",
    tokenOnly.status === 201 && tokenOnly.json.affiliateId === affiliateA.id,
  );
  const neither = await postJson("/api/v1/conversions", {
    key: keyAttr,
    body: {
      externalOrderId: "ord-nobody",
      amountCents: 1000,
      currency: "USD",
      idempotencyKey: "idem-nobody",
    },
  });
  check(
    "attribution: neither -> 422 unattributed, no row",
    neither.status === 422 &&
      neither.json.error === "unattributed" &&
      (await db.conversion.count({ where: { externalOrderId: "ord-nobody" } })) === 0,
  );
  const badAmount = await postJson("/api/v1/conversions", {
    key: keyAttr,
    body: { externalOrderId: "ord-bad", amountCents: -5, currency: "USD", idempotencyKey: "idem-bad", visitorToken: tokenA },
  });
  check("validation: negative amount -> 400", badAmount.status === 400);
  const noOrder = await postJson("/api/v1/conversions", {
    key: keyAttr,
    body: { amountCents: 100, currency: "USD", idempotencyKey: "idem-noorder", visitorToken: tokenA },
  });
  check("validation: missing order id -> 400", noOrder.status === 400);

  // --- rate limit (fresh key, limit is 5/min on this server) ---------------------------
  const keyRate = await newKey("rate");
  const rateStatuses = [];
  let retryAfter = null;
  for (let i = 0; i < 6; i += 1) {
    const res = await postJson("/api/v1/conversions", {
      key: keyRate,
      body: { externalOrderId: `ord-rate-${i}`, amountCents: 100, currency: "USD", idempotencyKey: `idem-rate-${i}` },
    });
    rateStatuses.push(res.status);
    if (res.status === 429) retryAfter = res.headers.get("retry-after");
  }
  check(
    "rate limit: first 5 pass the limiter (422), 6th -> 429 with Retry-After",
    JSON.stringify(rateStatuses) === JSON.stringify([422, 422, 422, 422, 422, 429]) &&
      Number(retryAfter) >= 1,
  );

  // --- Stripe webhooks ------------------------------------------------------------------
  const badSig = await stripePost(
    { id: "evt_bad", type: "invoice.paid", data: { object: {} } },
    { secret: "whsec_wrong_secret" },
  );
  check("stripe: bad signature -> 400", badSig.status === 400);

  const paidEvent = {
    id: "evt_m3_1",
    type: "invoice.paid",
    created: 1767225600,
    data: {
      object: {
        id: "in_m3_1",
        amount_paid: 2465,
        currency: "usd",
        customer: "cus_m3_1",
        billing_reason: "subscription_creation",
        metadata: { summa_code: "M3CODE15" },
      },
    },
  };
  const paidRes = await stripePost(paidEvent);
  const stripeConv = await db.conversion.findUnique({
    where: { programId_externalOrderId: { programId: program.id, externalOrderId: "in_m3_1" } },
    include: { commission: true },
  });
  check(
    "stripe: invoice.paid -> conversion + 369 commission via code",
    paidRes.status === 200 &&
      stripeConv?.affiliateId === affiliateB.id &&
      stripeConv.commission.amountCents === 369 &&
      stripeConv.source === "stripe",
  );

  const renewalEvent = {
    id: "evt_m3_2",
    type: "invoice.paid",
    created: 1767225700,
    data: {
      object: {
        id: "in_m3_2",
        amount_paid: 2465,
        currency: "usd",
        customer: "cus_m3_1",
        billing_reason: "subscription_cycle",
        metadata: { summa_vid: tokenA },
      },
    },
  };
  const renewalRes = await stripePost(renewalEvent);
  const renewalConv = await db.conversion.findUnique({
    where: { programId_externalOrderId: { programId: program.id, externalOrderId: "in_m3_2" } },
  });
  check(
    "stripe: renewal -> second conversion via token",
    renewalRes.status === 200 && renewalConv?.affiliateId === affiliateA.id,
  );

  const refundEvent = {
    id: "evt_m3_3",
    type: "charge.refunded",
    created: 1767225800,
    data: {
      object: {
        id: "ch_m3_1",
        invoice: "in_m3_1",
        amount: 2465,
        amount_refunded: 2465,
        currency: "usd",
        customer: "cus_m3_1",
      },
    },
  };
  const refundRes = await stripePost(refundEvent);
  const refundedConv = await db.conversion.findUnique({
    where: { programId_externalOrderId: { programId: program.id, externalOrderId: "in_m3_1" } },
    include: { commission: true },
  });
  check(
    "stripe: refund -> conversion REFUNDED + commission REVERSED",
    refundRes.status === 200 &&
      refundedConv?.status === "REFUNDED" &&
      refundedConv.commission.status === "REVERSED",
  );

  const redeliver = await stripePost(paidEvent);
  check(
    "stripe: redelivered payment event is a no-op",
    redeliver.status === 200 &&
      (await db.conversion.count({ where: { externalOrderId: "in_m3_1" } })) === 1 &&
      refundedConv?.status === "REFUNDED",
  );

  const disputeEvent = {
    id: "evt_m3_4",
    type: "charge.dispute.created",
    created: 1767225900,
    data: {
      object: { id: "dp_m3_1", charge: "ch_m3_2", invoice: "in_m3_2", amount: 2465, currency: "usd" },
    },
  };
  const disputeRes = await stripePost(disputeEvent);
  const disputedConv = await db.conversion.findUnique({
    where: { programId_externalOrderId: { programId: program.id, externalOrderId: "in_m3_2" } },
    include: { commission: true },
  });
  check(
    "stripe: dispute -> conversion CHARGEBACKED + commission REVERSED",
    disputeRes.status === 200 &&
      disputedConv?.status === "CHARGEBACKED" &&
      disputedConv.commission.status === "REVERSED",
  );

  const orphanEvent = {
    id: "evt_m3_5",
    type: "invoice.paid",
    created: 1767226000,
    data: {
      object: {
        id: "in_m3_orphan",
        amount_paid: 999,
        currency: "usd",
        customer: "cus_nobody",
        billing_reason: "subscription_creation",
        metadata: {},
      },
    },
  };
  const orphanRes = await stripePost(orphanEvent);
  const orphanAudit = await db.auditLog.findFirst({
    where: { action: "stripe.unattributed", targetId: "evt_m3_5" },
  });
  check(
    "stripe: unattributed event acked 200, no conversion, audit note left",
    orphanRes.status === 200 &&
      (await db.conversion.count({ where: { externalOrderId: "in_m3_orphan" } })) === 0 &&
      !!orphanAudit,
  );

  console.log(`\nConversions & Stripe suite: ${passed} passed`);
} finally {
  if (server) server.kill("SIGTERM");
  if (program) {
    await db.auditLog.deleteMany({ where: { programId: program.id } });
    await db.program.delete({ where: { id: program.id } }).catch(() => {});
  }
  if (admin) {
    await db.auditLog.deleteMany({ where: { actorId: admin.id } });
    await db.admin.delete({ where: { id: admin.id } }).catch(() => {});
  }
  await db.$disconnect();
  rmSync(outDir, { recursive: true, force: true });
}
