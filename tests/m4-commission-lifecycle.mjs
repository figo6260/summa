/**
 * Summa test suite — commission lifecycle: release, review, rounding,
 * refunds and clawback debt. Repeatable and self-cleaning: fixtures
 * are uniquely named and are deleted again in `finally`.
 *
 * Covers:
 *  1. Anchor lifecycle: 2465 x 1500bps (FLOOR) -> 369 HOLDING,
 *     holdUntil +30d -> CLI release -> AVAILABLE -> full refund ->
 *     REVERSED with reversedCents 369.
 *  2. Review queue: pending_review never auto-releases; approve clears
 *     the stamp and release then works; reject is terminal with the
 *     reason stored on the commission.
 *  3. Configurable rounding: 1050 x 15% -> FLOOR 157 / NEAREST 158 /
 *     CEIL 158, both in the unit function and through the pipeline;
 *     the program form parses the mode (absent -> FLOOR).
 *  4. isRenewal: S2S flag lands in the DB; Stripe renewal events set
 *     it, first payments do not.
 *  5. Partial refunds (cumulative): 10000/1500 -> refund 3000 ->
 *     reversed 450, effective 1050, still HOLDING/CONFIRMED -> refund
 *     to 10000 -> reversed 1500, REVERSED/REFUNDED. Replays don't move.
 *  6. Paid-out clawback debt: PAID commission fully refunded ->
 *     balance -1500; a new matured commission nets against the debt.
 *  7. AVAILABLE commission fully refunded -> REVERSED, gross drops.
 *  Plus: Stripe partial refund via webhook (proportional), the admin
 *  register-refund wrapper (increment merged into cumulative + audit).
 *
 * Needs a production build (builds one if .next is missing) and starts
 * a throwaway server on SUMMA_TEST_PORT (default 3462). Requires
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
const WEBHOOK_SECRET = "whsec_m4_test_secret";
const PORT = Number(process.env.SUMMA_TEST_PORT || 3462);
const BASE = `http://127.0.0.1:${PORT}`;

// --- compile the TS library layer with the project's tsc -------------------
mkdirSync(join(process.cwd(), "node_modules", ".cache"), { recursive: true });
const outDir = mkdtempSync(join(process.cwd(), "node_modules", ".cache", "summa-m4-test-"));
execSync(
  [
    "node_modules/.bin/tsc",
    "src/lib/services.ts",
    "src/lib/conversion.ts",
    "src/lib/commissions.ts",
    "src/lib/balance.ts",
    "src/lib/reversal.ts",
    "src/lib/program-form.ts",
    "src/lib/payments/stripe.ts",
    "src/lib/api-keys.ts",
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
const commissionsLib = require(join(outDir, "commissions.js"));
const balanceLib = require(join(outDir, "balance.js"));
const reversalLib = require(join(outDir, "reversal.js"));
const programForm = require(join(outDir, "program-form.js"));
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
const extraPrograms = [];

async function makeAffiliate(programId, name, email) {
  const invite = await services.inviteAffiliate(db, admin.id, programId, { name, email });
  return services.activateAffiliate(db, invite.token, "partner-password-1");
}

async function commissionOf(externalOrderId) {
  const conv = await db.conversion.findFirst({
    where: { externalOrderId },
    include: { commission: true },
  });
  return conv;
}

async function postJson(path, { key, body }) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function stripePost(event) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
  return fetch(`${BASE}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` },
    body,
  }).then(async (res) => ({ status: res.status }));
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
        name: "M4 Test Admin",
        email: `m4-admin-${suffix}@example.test`,
        passwordHash: hashPassword("test-password-1"),
      },
    });
  } else {
    admin = await services.setupAdmin(db, {
      name: "M4 Test Admin",
      email: `m4-admin-${suffix}@example.test`,
      password: "test-password-1",
    });
  }
  program = await services.createProgram(db, admin.id, {
    name: "M4 Test Program",
    slug: `m4-test-${suffix}`,
    commissionRateBps: 1500,
    commissionRounding: "FLOOR",
    buyerDiscountBps: 1500,
    currency: "USD",
    attributionWindowDays: 30,
    holdDays: 30,
    minPayoutCents: 0,
    payoutDayOfMonth: 10,
    defaultTargetUrl: "https://example.com/land",
    isActive: true,
  });

  const affiliateA = await makeAffiliate(program.id, "Partner A", `m4-a-${suffix}@example.test`);
  const affiliateC = await makeAffiliate(program.id, "Partner C", `m4-c-${suffix}@example.test`);
  const affiliateD = await makeAffiliate(program.id, "Partner D", `m4-d-${suffix}@example.test`);
  check("fixtures: three active affiliates", [affiliateA, affiliateC, affiliateD].every((a) => a.status === "ACTIVE"));

  const link = await services.createReferralLink(
    db,
    { type: "AFFILIATE", id: affiliateA.id },
    affiliateA.id,
    { channel: "m4-test" },
  );
  const clickResult = await attribution.handleReferralClick(
    db,
    link.code,
    { referrer: "https://blog.example/post", ipAddress: "203.0.113.9", userAgent: "M4Test/1.0" },
    BASE,
  );
  check("fixtures: click recorded with visitor token", clickResult.kind === "redirect" && !!clickResult.visitorToken);
  const tokenA = clickResult.visitorToken;

  const codeC = await services.createDiscountCode(db, admin.id, affiliateC.id, { code: "M4CODEC", discountBps: 1500 });
  const codeD = await services.createDiscountCode(db, admin.id, affiliateD.id, { code: "M4CODED", discountBps: 1500 });
  check("fixtures: discount codes for C and D", codeC.code === "M4CODEC" && codeD.code === "M4CODED");

  const record = (extra) =>
    conversionLib.recordConversion(db, { programId: program.id, currency: "USD", source: "api", ...extra });

  // --- 1. anchor lifecycle ------------------------------------------------------
  const anchor = await record({
    externalOrderId: "ord-m4-anchor",
    amountCents: 2465,
    idempotencyKey: "idem-m4-anchor",
    visitorToken: tokenA,
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  check(
    "anchor: 2465 x 1500bps FLOOR -> 369 HOLDING, holdUntil +30d",
    anchor.commission.amountCents === 369 &&
      anchor.commission.status === "HOLDING" &&
      anchor.commission.holdUntil.toISOString() === "2026-01-31T00:00:00.000Z",
  );
  await db.commission.update({
    where: { id: anchor.commission.id },
    data: { holdUntil: new Date(Date.now() - 60_000) },
  });
  const cliOut = execSync("node scripts/release-commissions.mjs", { encoding: "utf8" });
  check("release: CLI runs and reports the matured commission", /released [1-9]/.test(cliOut));
  let row = await commissionOf("ord-m4-anchor");
  check("release: anchor commission now AVAILABLE", row.commission.status === "AVAILABLE");
  const releaseAudit = await db.auditLog.findFirst({
    where: { action: "commission.release", targetId: anchor.commission.id, actorType: "SYSTEM" },
  });
  check("release: SYSTEM audit entry written", !!releaseAudit);

  const anchorRefund = await reversalLib.applyRefund(db, {
    conversionId: anchor.conversion.id,
    refundedTotalCents: 2465,
    kind: "refund",
    reason: "test full refund",
  });
  check(
    "refund: full refund -> REVERSED, reversedCents 369, conversion REFUNDED",
    anchorRefund.commission.status === "REVERSED" &&
      anchorRefund.commission.reversedCents === 369 &&
      anchorRefund.conversion.status === "REFUNDED" &&
      anchorRefund.conversion.refundedCents === 2465,
  );
  const balA1 = await balanceLib.getAffiliateBalance(db, affiliateA.id);
  check(
    "balance: A shows reversed total 369 and zero available",
    balA1.reversedCentsTotal === 369 && balA1.availableGrossCents === 0 && balA1.availableBalanceCents === 0,
  );

  // --- 2. review queue ------------------------------------------------------------
  hooksRegistry.registerConversionHooks({
    beforeConversion: async () => ({ action: "review", reason: "first_order" }),
  });
  const reviewed = await record({
    externalOrderId: "ord-m4-review",
    amountCents: 2000,
    idempotencyKey: "idem-m4-review",
    visitorToken: tokenA,
  });
  const rejectedFixture = await record({
    externalOrderId: "ord-m4-reject",
    amountCents: 2000,
    idempotencyKey: "idem-m4-reject",
    visitorToken: tokenA,
  });
  hooksRegistry.clearConversionHooks();
  check(
    "review: both commissions stamped pending_review",
    reviewed.commission.statusReason === "pending_review" &&
      rejectedFixture.commission.statusReason === "pending_review",
  );
  await db.commission.updateMany({
    where: { id: { in: [reviewed.commission.id, rejectedFixture.commission.id] } },
    data: { holdUntil: new Date(Date.now() - 60_000) },
  });
  await commissionsLib.releaseMaturedCommissions(db, new Date());
  row = await commissionOf("ord-m4-review");
  check("review: pending_review does NOT auto-release", row.commission.status === "HOLDING");

  await commissionsLib.approveCommissionReview(db, admin.id, reviewed.commission.id);
  row = await commissionOf("ord-m4-review");
  check("review: approve clears the stamp", row.commission.statusReason === null && row.commission.status === "HOLDING");
  await commissionsLib.releaseMaturedCommissions(db, new Date());
  row = await commissionOf("ord-m4-review");
  check("review: approved commission releases once matured", row.commission.status === "AVAILABLE");

  await commissionsLib.rejectCommission(db, admin.id, rejectedFixture.commission.id, "suspicious traffic");
  row = await commissionOf("ord-m4-reject");
  check(
    "review: reject -> REJECTED with the reason stored",
    row.commission.status === "REJECTED" && row.commission.statusReason === "suspicious traffic",
  );
  await commissionsLib.releaseMaturedCommissions(db, new Date());
  row = await commissionOf("ord-m4-reject");
  check("review: rejected commission never releases", row.commission.status === "REJECTED");
  const rejectAudit = await db.auditLog.findFirst({
    where: { action: "commission.review_reject", targetId: rejectedFixture.commission.id },
  });
  check("review: reject audit carries the reason", rejectAudit?.metadata?.reason === "suspicious traffic");
  let reasonError = null;
  try {
    await commissionsLib.rejectCommission(db, admin.id, reviewed.commission.id, "  ");
  } catch (error) {
    reasonError = error;
  }
  check("review: reject without a reason is refused", reasonError?.message === "reason_required");

  // --- 3. rounding ------------------------------------------------------------------
  check(
    "rounding unit: 1050x15% FLOOR 157 / NEAREST 158 / CEIL 158",
    conversionLib.computeCommissionCents(1050, 1500, "FLOOR") === 157 &&
      conversionLib.computeCommissionCents(1050, 1500, "NEAREST") === 158 &&
      conversionLib.computeCommissionCents(1050, 1500, "CEIL") === 158 &&
      conversionLib.computeCommissionCents(2465, 1500) === 369,
  );
  const baseFields = {
    name: "P",
    slug: "p-x",
    commissionRateBps: "1500",
    buyerDiscountBps: "0",
    currency: "USD",
    attributionWindowDays: "30",
    holdDays: "30",
    minPayoutCents: "0",
    payoutDayOfMonth: "10",
    isActive: "true",
  };
  check(
    "rounding form: NEAREST parsed, absent -> FLOOR, bogus -> error",
    programForm.parseProgramForm({ ...baseFields, commissionRounding: "NEAREST" }).value?.commissionRounding === "NEAREST" &&
      programForm.parseProgramForm({ ...baseFields }).value?.commissionRounding === "FLOOR" &&
      programForm.parseProgramForm({ ...baseFields, commissionRounding: "BOGUS" }).ok === false,
  );
  for (const [mode, expected] of [["NEAREST", 158], ["CEIL", 158], ["FLOOR", 157]]) {
    const p = await db.program.create({
      data: {
        name: `Rounding ${mode}`,
        slug: `m4-round-${mode.toLowerCase()}-${suffix}`,
        commissionRateBps: 1500,
        commissionRounding: mode,
        currency: "USD",
      },
    });
    extraPrograms.push(p);
    const aff = await db.affiliate.create({
      data: {
        programId: p.id,
        name: `Round ${mode}`,
        email: `m4-round-${mode.toLowerCase()}-${suffix}@example.test`,
        passwordHash: hashPassword("partner-password-1"),
        status: "ACTIVE",
      },
    });
    await services.createDiscountCode(db, admin.id, aff.id, { code: `M4R${mode}`, discountBps: 1500 });
    const res = await conversionLib.recordConversion(db, {
      programId: p.id,
      externalOrderId: `ord-m4-round-${mode.toLowerCase()}`,
      amountCents: 1050,
      currency: "USD",
      idempotencyKey: `idem-m4-round-${mode.toLowerCase()}`,
      discountCode: `M4R${mode}`,
      source: "api",
    });
    check(`rounding pipeline: ${mode} -> ${expected}`, res.commission.amountCents === expected);
  }

  // --- 5. partial refunds (cumulative) ----------------------------------------------
  const partial = await record({
    externalOrderId: "ord-m4-partial",
    amountCents: 10000,
    idempotencyKey: "idem-m4-partial",
    visitorToken: tokenA,
  });
  check("partial: commission 1500 HOLDING", partial.commission.amountCents === 1500 && partial.commission.status === "HOLDING");
  const step1 = await reversalLib.applyRefund(db, {
    conversionId: partial.conversion.id,
    refundedTotalCents: 3000,
    kind: "refund",
    reason: "partial 1",
  });
  check(
    "partial: refund 3000 -> reversed 450, effective 1050, still HOLDING/CONFIRMED",
    step1.commission.reversedCents === 450 &&
      step1.commission.amountCents - step1.commission.reversedCents === 1050 &&
      step1.commission.status === "HOLDING" &&
      step1.conversion.status === "CONFIRMED" &&
      step1.conversion.refundedCents === 3000 &&
      step1.clawedBack === true,
  );
  const step1Replay = await reversalLib.applyRefund(db, {
    conversionId: partial.conversion.id,
    refundedTotalCents: 3000,
    kind: "refund",
    reason: "partial 1 replay",
  });
  check(
    "partial: same cumulative total replayed moves nothing",
    step1Replay.commission.reversedCents === 450 && step1Replay.clawedBack === false,
  );
  const step2 = await reversalLib.applyRefund(db, {
    conversionId: partial.conversion.id,
    refundedTotalCents: 10000,
    kind: "refund",
    reason: "partial 2 completes it",
  });
  check(
    "partial: refund to full -> reversed 1500, REVERSED, conversion REFUNDED",
    step2.commission.reversedCents === 1500 &&
      step2.commission.status === "REVERSED" &&
      step2.conversion.status === "REFUNDED",
  );

  // --- admin register-refund wrapper ---------------------------------------------------
  const adminRefundConv = await record({
    externalOrderId: "ord-m4-adminrefund",
    amountCents: 8000,
    idempotencyKey: "idem-m4-adminrefund",
    visitorToken: tokenA,
  });
  const adminRefund = await reversalLib.registerRefundByAdmin(db, admin.id, adminRefundConv.conversion.id, {
    amountCents: 2000,
    reason: "buyer asked",
  });
  check(
    "admin refund: increment 2000 merges to cumulative -> reversed 300",
    adminRefund.conversion.refundedCents === 2000 && adminRefund.commission.reversedCents === 300,
  );
  const refundAudit = await db.auditLog.findFirst({
    where: { action: "conversion.refund", targetId: adminRefundConv.conversion.id, actorType: "ADMIN" },
  });
  check("admin refund: conversion.refund audit written", refundAudit?.metadata?.reason === "buyer asked");

  // --- 7. AVAILABLE reversal ------------------------------------------------------------
  const dConv = await conversionLib.recordConversion(db, {
    programId: program.id,
    externalOrderId: "ord-m4-avail",
    amountCents: 5000,
    currency: "USD",
    idempotencyKey: "idem-m4-avail",
    discountCode: "M4CODED",
    source: "api",
  });
  await db.commission.update({
    where: { id: dConv.commission.id },
    data: { holdUntil: new Date(Date.now() - 60_000) },
  });
  await commissionsLib.releaseMaturedCommissions(db, new Date());
  const balD1 = await balanceLib.getAffiliateBalance(db, affiliateD.id);
  check("available: D balance shows gross 750", balD1.availableGrossCents === 750 && balD1.availableBalanceCents === 750);
  await reversalLib.applyRefund(db, {
    conversionId: dConv.conversion.id,
    refundedTotalCents: 5000,
    kind: "refund",
    reason: "full refund after release",
  });
  const balD2 = await balanceLib.getAffiliateBalance(db, affiliateD.id);
  row = await commissionOf("ord-m4-avail");
  check(
    "available: full refund -> REVERSED and gross drops to 0",
    row.commission.status === "REVERSED" && balD2.availableGrossCents === 0 && balD2.availableBalanceCents === 0,
  );

  // --- 6. paid-out clawback -> negative balance, then netting ------------------------------
  const cConv = await conversionLib.recordConversion(db, {
    programId: program.id,
    externalOrderId: "ord-m4-paid",
    amountCents: 10000,
    currency: "USD",
    idempotencyKey: "idem-m4-paid",
    discountCode: "M4CODEC",
    source: "api",
  });
  const payout = await db.payout.create({
    data: {
      programId: program.id,
      affiliateId: affiliateC.id,
      periodStart: new Date("2026-01-01T00:00:00.000Z"),
      periodEnd: new Date("2026-01-31T00:00:00.000Z"),
      totalCents: 1500,
      currency: "USD",
      status: "PAID",
      method: "WISE",
      externalRef: "wise-m4-test",
      paidAt: new Date(),
    },
  });
  await db.commission.update({
    where: { id: cConv.commission.id },
    data: { status: "PAID", payoutId: payout.id },
  });
  const balC1 = await balanceLib.getAffiliateBalance(db, affiliateC.id);
  check("paid: C paidNet 1500, balance 0", balC1.paidNetCents === 1500 && balC1.availableBalanceCents === 0);
  await reversalLib.applyRefund(db, {
    conversionId: cConv.conversion.id,
    refundedTotalCents: 10000,
    kind: "refund",
    reason: "late refund after payout",
  });
  const balC2 = await balanceLib.getAffiliateBalance(db, affiliateC.id);
  check(
    "paid: full refund after payout -> debt 1500, balance -1500, payable 0",
    balC2.grossDebtCents === 1500 && balC2.availableBalanceCents === -1500 && balC2.payableCents === 0 && balC2.paidNetCents === 0,
  );
  const cConv2 = await conversionLib.recordConversion(db, {
    programId: program.id,
    externalOrderId: "ord-m4-paid-2",
    amountCents: 20000,
    currency: "USD",
    idempotencyKey: "idem-m4-paid-2",
    discountCode: "M4CODEC",
    source: "api",
  });
  await db.commission.update({
    where: { id: cConv2.commission.id },
    data: { holdUntil: new Date(Date.now() - 60_000) },
  });
  await commissionsLib.releaseMaturedCommissions(db, new Date());
  const balC3 = await balanceLib.getAffiliateBalance(db, affiliateC.id);
  check(
    "paid: new matured 3000 nets against the debt -> balance 1500",
    balC3.availableGrossCents === 3000 && balC3.grossDebtCents === 1500 && balC3.availableBalanceCents === 1500 && balC3.payableCents === 1500,
  );

  // --- 4. isRenewal over HTTP (S2S + Stripe) -------------------------------------------------
  if (!existsSync(join(process.cwd(), ".next", "BUILD_ID"))) {
    execSync("npm run build", { stdio: "inherit" });
  }
  server = spawn("node_modules/.bin/next", ["start", "-p", String(PORT)], {
    env: {
      ...process.env,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      SESSION_COOKIE_SECURE: "false",
    },
    stdio: "ignore",
  });
  await waitForServer();
  check("server: production build responding", true);

  const key = (await apiKeys.createApiKey(db, admin.id, program.id, "m4-key")).plain;
  const renRes = await postJson("/api/v1/conversions", {
    key,
    body: {
      externalOrderId: "ord-m4-s2s-renewal",
      amountCents: 2465,
      currency: "USD",
      idempotencyKey: "idem-m4-s2s-renewal",
      visitorToken: tokenA,
      isRenewal: true,
    },
  });
  const renRow = await commissionOf("ord-m4-s2s-renewal");
  check(
    "isRenewal: S2S true lands as true",
    renRes.status === 201 && renRes.json.isRenewal === true && renRow.isRenewal === true,
  );
  const firstRes = await postJson("/api/v1/conversions", {
    key,
    body: {
      externalOrderId: "ord-m4-s2s-first",
      amountCents: 2465,
      currency: "USD",
      idempotencyKey: "idem-m4-s2s-first",
      visitorToken: tokenA,
    },
  });
  const firstRow = await commissionOf("ord-m4-s2s-first");
  check(
    "isRenewal: S2S omitted lands as false",
    firstRes.status === 201 && firstRow.isRenewal === false,
  );

  const stripeRenewal = await stripePost({
    id: "evt_m4_ren",
    type: "invoice.paid",
    created: 1767225600,
    data: {
      object: {
        id: "in_m4_ren",
        amount_paid: 2465,
        currency: "usd",
        customer: "cus_m4",
        billing_reason: "subscription_cycle",
        metadata: { summa_vid: tokenA },
      },
    },
  });
  const stripeRenRow = await commissionOf("in_m4_ren");
  check(
    "isRenewal: Stripe subscription_cycle -> true",
    stripeRenewal.status === 200 && stripeRenRow?.isRenewal === true,
  );
  const stripeFirst = await stripePost({
    id: "evt_m4_first",
    type: "invoice.paid",
    created: 1767225700,
    data: {
      object: {
        id: "in_m4_first",
        amount_paid: 2465,
        currency: "usd",
        customer: "cus_m4",
        billing_reason: "subscription_creation",
        metadata: { summa_vid: tokenA },
      },
    },
  });
  const stripeFirstRow = await commissionOf("in_m4_first");
  check(
    "isRenewal: Stripe subscription_creation -> false",
    stripeFirst.status === 200 && stripeFirstRow?.isRenewal === false,
  );

  const stripePartial = await stripePost({
    id: "evt_m4_pref",
    type: "charge.refunded",
    created: 1767225800,
    data: {
      object: {
        id: "ch_m4_first",
        invoice: "in_m4_first",
        amount: 2465,
        amount_refunded: 1000,
        currency: "usd",
        customer: "cus_m4",
      },
    },
  });
  const stripePartialRow = await commissionOf("in_m4_first");
  check(
    "stripe partial refund: cumulative 1000 -> reversed 149, still HOLDING/CONFIRMED",
    stripePartial.status === 200 &&
      stripePartialRow.refundedCents === 1000 &&
      stripePartialRow.status === "CONFIRMED" &&
      stripePartialRow.commission.reversedCents === 149 &&
      stripePartialRow.commission.status === "HOLDING",
  );

  console.log(`\nCommission lifecycle suite: ${passed} passed`);
} finally {
  if (server) server.kill("SIGTERM");
  for (const p of extraPrograms) {
    await db.auditLog.deleteMany({ where: { programId: p.id } });
    await db.program.delete({ where: { id: p.id } }).catch(() => {});
  }
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
