/**
 * Summa test suite — payout settlement, CSV exports, transactional
 * email. Repeatable and self-cleaning: fixtures are uniquely named
 * and are deleted again in `finally`.
 *
 * Covers:
 *  1. One settlement cycle end to end: AVAILABLE 3000, no debt ->
 *     payout gross = total = 3000, commissions reserved -> re-running
 *     generation does not duplicate -> mark paid (method + ref) ->
 *     commissions PAID, payable back to 0, paidNet up, payout_paid
 *     email logged.
 *  2. Debt offset: 1500 of clawback debt + 3000 available -> payout
 *     gross 3000 / debtOffset 1500 / total 1500 -> mark paid settles
 *     the debt source (debtSettledCents full, grossDebt back to 0);
 *     a payout marked FAILED hands its commissions back to the
 *     payable pool (debt untouched) and they can be settled again.
 *  3. Thresholds: minPayoutCents 5000 blocks a 3000 payable;
 *     payable <= 0 (debt >= gross) never generates.
 *  4. CSV: detail + list exports are produced by the same builders
 *     the routes use; parsing them back reproduces the DB figures,
 *     and fields with commas/quotes are escaped correctly.
 *  5. Mail: invite logs an EmailLog with the activation link;
 *     release sends ONE aggregated commission_available per affiliate
 *     (and none after the affiliate opts out); rejection sends
 *     commission_rejected with the reason; payout emails honour the
 *     payout preference.
 *
 * Library-level suite (no HTTP server needed). Requires DATABASE_URL
 * pointing at a PostgreSQL database it may create fixtures in; run via
 * `npm run test:e2e` — see "Running the tests" in the README.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// --- environment -----------------------------------------------------------
// Configuration comes from the process environment. When a repo-root
// `.env` file exists it fills in anything not already set.
const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_]+)=\"?([^\"]*)\"?$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

// --- compile the TS library layer with the project's tsc -------------------
mkdirSync(join(process.cwd(), "node_modules", ".cache"), { recursive: true });
const outDir = mkdtempSync(join(process.cwd(), "node_modules", ".cache", "summa-m5-test-"));
execSync(
  [
    "node_modules/.bin/tsc",
    "src/lib/services.ts",
    "src/lib/commissions.ts",
    "src/lib/balance.ts",
    "src/lib/payouts.ts",
    "src/lib/mailer.ts",
    "src/lib/csv.ts",
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
const commissionsLib = require(join(outDir, "commissions.js"));
const balanceLib = require(join(outDir, "balance.js"));
const payoutsLib = require(join(outDir, "payouts.js"));
const csvLib = require(join(outDir, "csv.js"));
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
let orderSeq = 0;

async function makeAffiliate(programId, name, email) {
  const invite = await services.inviteAffiliate(db, admin.id, programId, { name, email });
  return services.activateAffiliate(db, invite.token, "partner-password-1");
}

/** Insert a conversion + commission pair directly (fixture shortcut). */
async function makeCommission(affiliate, opts = {}) {
  orderSeq += 1;
  const orderId = opts.orderId ?? `M5-ORD-${suffix}-${orderSeq}`;
  const conversion = await db.conversion.create({
    data: {
      programId: program.id,
      affiliateId: affiliate.id,
      externalOrderId: orderId,
      idempotencyKey: `m5-idem-${suffix}-${orderSeq}`,
      customerRef: `cust-${orderSeq}`,
      amountCents: opts.orderAmountCents ?? 20000,
      currency: "USD",
      status: "CONFIRMED",
      source: "API",
      occurredAt: new Date(),
    },
  });
  return db.commission.create({
    data: {
      programId: program.id,
      affiliateId: affiliate.id,
      conversionId: conversion.id,
      amountCents: opts.amountCents ?? 1000,
      reversedCents: opts.reversedCents ?? 0,
      debtSettledCents: opts.debtSettledCents ?? 0,
      currency: "USD",
      status: opts.status ?? "AVAILABLE",
      holdUntil: opts.holdUntil ?? new Date(Date.now() - 86400000),
      payoutId: opts.payoutId ?? null,
    },
  });
}

async function balanceOf(affiliate) {
  return balanceLib.getAffiliateBalance(db, affiliate.id);
}

async function emailsTo(email, type) {
  return db.emailLog.findMany({
    where: { toEmail: email, ...(type ? { type } : {}) },
    orderBy: { createdAt: "asc" },
  });
}

/** Minimal CSV parser (quotes + doubled quotes) for export verification. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
    else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

try {
  check("clean slate: no pre-existing program", (await db.program.count()) === 0);

  // --- fixtures ---------------------------------------------------------------
  if (await services.adminExists(db)) {
    admin = await db.admin.create({
      data: {
        name: "M5 Test Admin",
        email: `m5-admin-${suffix}@example.test`,
        passwordHash: hashPassword("test-password-1"),
      },
    });
  } else {
    admin = await services.setupAdmin(db, {
      name: "M5 Test Admin",
      email: `m5-admin-${suffix}@example.test`,
      password: "test-password-1",
    });
  }
  program = await services.createProgram(db, admin.id, {
    name: "M5 Test Program",
    slug: `m5-test-${suffix}`,
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

  const affiliateA = await makeAffiliate(program.id, "Partner A", `m5-a-${suffix}@example.test`);
  const affiliateB = await makeAffiliate(program.id, "Partner B", `m5-b-${suffix}@example.test`);
  const affiliateC = await makeAffiliate(program.id, "Partner C", `m5-c-${suffix}@example.test`);
  check("fixtures: three active affiliates", [affiliateA, affiliateB, affiliateC].every((a) => a.status === "ACTIVE"));

  // === 1. one settlement cycle, no debt ======================================
  await makeCommission(affiliateA, { amountCents: 1000 });
  const aSecond = await makeCommission(affiliateA, { amountCents: 2000, orderId: `M5-A,"Q"-${suffix}` });
  check("A starts payable 3000", (await balanceOf(affiliateA)).payableCents === 3000);

  const gen1 = await payoutsLib.generatePayouts(db, new Date(), { type: "ADMIN", id: admin.id });
  const aPayouts = await db.payout.findMany({ where: { affiliateId: affiliateA.id } });
  check("generation created exactly one payout for A", aPayouts.length === 1 && gen1.count >= 1);
  const aPayout = aPayouts[0];
  check("A payout gross = 3000", aPayout.grossCents === 3000);
  check("A payout debtOffset = 0, total = 3000", aPayout.debtOffsetCents === 0 && aPayout.totalCents === 3000);
  check("A payout is PENDING with the generation month as period", aPayout.status === "PENDING" && aPayout.periodStart.getUTCDate() === 1 && aPayout.periodStart.getUTCHours() === 0);
  const aReserved = await db.commission.findMany({ where: { payoutId: aPayout.id } });
  check("A commissions reserved (payoutId set, still AVAILABLE)", aReserved.length === 2 && aReserved.every((c) => c.status === "AVAILABLE"));
  check("reserved commissions still count as payable", (await balanceOf(affiliateA)).payableCents === 3000);
  check("audit payout.generate written", (await db.auditLog.count({ where: { action: "payout.generate", targetId: aPayout.id } })) === 1);

  await payoutsLib.generatePayouts(db, new Date(), { type: "ADMIN", id: admin.id });
  check("re-running generation does not duplicate A's payout", (await db.payout.count({ where: { affiliateId: affiliateA.id } })) === 1);

  let refError = null;
  try {
    await payoutsLib.markPayoutPaid(db, admin.id, aPayout.id, { method: "WISE", externalRef: "  " });
  } catch (err) { refError = err; }
  check("mark paid without a reference is rejected", refError?.message === "external_ref_required");

  const aPaid = await payoutsLib.markPayoutPaid(db, admin.id, aPayout.id, { method: "WISE", externalRef: "WISE-123" });
  check("A payout is PAID with method/ref/paidAt", aPaid.status === "PAID" && aPaid.method === "WISE" && aPaid.externalRef === "WISE-123" && !!aPaid.paidAt);
  const aAfter = await balanceOf(affiliateA);
  check("A payable back to 0 and paidNet = 3000", aAfter.payableCents === 0 && aAfter.paidNetCents === 3000);
  check("A commissions flipped to PAID", (await db.commission.count({ where: { payoutId: aPayout.id, status: "PAID" } })) === 2);
  const aMails = await emailsTo(affiliateA.email, "payout_paid");
  check("payout_paid email logged for A with the reference", aMails.length === 1 && aMails[0].body.includes("WISE-123") && aMails[0].status === "logged");
  check("audit payout.mark_paid written", (await db.auditLog.count({ where: { action: "payout.mark_paid", targetId: aPayout.id } })) === 1);

  // === 2. debt offset + failed payout returns commissions ====================
  // B was paid 1500 earlier, then the order was fully refunded: debt 1500.
  const bOldPayout = await db.payout.create({
    data: {
      programId: program.id, affiliateId: affiliateB.id,
      periodStart: new Date(Date.now() - 40 * 86400000), periodEnd: new Date(Date.now() - 40 * 86400000),
      grossCents: 1500, debtOffsetCents: 0, totalCents: 1500, currency: "USD",
      status: "PAID", method: "WISE", externalRef: "WISE-OLD", paidAt: new Date(Date.now() - 40 * 86400000),
    },
  });
  const bDebtSource = await makeCommission(affiliateB, { amountCents: 1500, status: "REVERSED", reversedCents: 1500, payoutId: bOldPayout.id });
  check("B carries 1500 of unsettled debt", (await balanceOf(affiliateB)).grossDebtCents === 1500);
  await makeCommission(affiliateB, { amountCents: 3000 });
  const bBalance = await balanceOf(affiliateB);
  check("B payable nets the debt (3000 - 1500 = 1500)", bBalance.payableCents === 1500 && bBalance.availableBalanceCents === 1500);
  // B opts out of payout emails before the payout is marked paid.
  await services.updateAffiliateNotificationPrefs(db, { type: "AFFILIATE", id: affiliateB.id }, affiliateB.id, { commission: true, payout: false });

  await payoutsLib.generatePayouts(db, new Date(), { type: "SYSTEM", id: null });
  const bPayout = await db.payout.findFirst({ where: { affiliateId: affiliateB.id, status: "PENDING" } });
  check("B payout gross/debtOffset/total = 3000/1500/1500", !!bPayout && bPayout.grossCents === 3000 && bPayout.debtOffsetCents === 1500 && bPayout.totalCents === 1500);
  await payoutsLib.markPayoutPaid(db, admin.id, bPayout.id, { method: "BANK_TRANSFER", externalRef: "BANK-9" });
  const bDebtAfter = await db.commission.findUnique({ where: { id: bDebtSource.id } });
  check("marking paid settles the debt source in full", bDebtAfter.debtSettledCents === 1500);
  check("B grossDebt back to 0 after settlement", (await balanceOf(affiliateB)).grossDebtCents === 0);
  check("B got no payout_paid email (preference off)", (await emailsTo(affiliateB.email, "payout_paid")).length === 0);

  // C: a payout that fails hands everything back.
  await makeCommission(affiliateC, { amountCents: 2000 });
  await payoutsLib.generatePayouts(db, new Date(), { type: "SYSTEM", id: null });
  const cPayout = await db.payout.findFirst({ where: { affiliateId: affiliateC.id, status: "PENDING" } });
  check("C payout generated for 2000", !!cPayout && cPayout.totalCents === 2000);
  let reasonError = null;
  try {
    await payoutsLib.markPayoutFailed(db, admin.id, cPayout.id, " ");
  } catch (err) { reasonError = err; }
  check("mark failed without a reason is rejected", reasonError?.message === "reason_required");
  const cFailed = await payoutsLib.markPayoutFailed(db, admin.id, cPayout.id, "bank account closed");
  check("C payout is FAILED", cFailed.status === "FAILED");
  const cCommissions = await db.commission.findMany({ where: { affiliateId: affiliateC.id } });
  check("C commissions returned to the pool (AVAILABLE, no payout)", cCommissions.every((c) => c.status === "AVAILABLE" && c.payoutId === null));
  check("C payable restored to 2000", (await balanceOf(affiliateC)).payableCents === 2000);
  await payoutsLib.generatePayouts(db, new Date(), { type: "SYSTEM", id: null });
  check("C commissions are swept into a fresh payout", (await db.payout.count({ where: { affiliateId: affiliateC.id, status: "PENDING" } })) === 1);

  // === 3. thresholds ===========================================================
  const affiliateD = await makeAffiliate(program.id, "Partner D", `m5-d-${suffix}@example.test`);
  await makeCommission(affiliateD, { amountCents: 3000 });
  await db.program.update({ where: { id: program.id }, data: { minPayoutCents: 5000 } });
  await payoutsLib.generatePayouts(db, new Date(), { type: "SYSTEM", id: null });
  check("min payout 5000 blocks a payable of 3000", (await db.payout.count({ where: { affiliateId: affiliateD.id } })) === 0);
  await db.program.update({ where: { id: program.id }, data: { minPayoutCents: 0 } });

  const affiliateE = await makeAffiliate(program.id, "Partner E", `m5-e-${suffix}@example.test`);
  const eOldPayout = await db.payout.create({
    data: {
      programId: program.id, affiliateId: affiliateE.id,
      periodStart: new Date(Date.now() - 40 * 86400000), periodEnd: new Date(Date.now() - 40 * 86400000),
      grossCents: 3000, debtOffsetCents: 0, totalCents: 3000, currency: "USD",
      status: "PAID", method: "WISE", externalRef: "WISE-E", paidAt: new Date(Date.now() - 40 * 86400000),
    },
  });
  await makeCommission(affiliateE, { amountCents: 3000, status: "REVERSED", reversedCents: 3000, payoutId: eOldPayout.id });
  await makeCommission(affiliateE, { amountCents: 3000 });
  check("E payable is 0 (debt eats the whole gross)", (await balanceOf(affiliateE)).payableCents === 0);
  await payoutsLib.generatePayouts(db, new Date(), { type: "SYSTEM", id: null });
  check("payable <= 0 generates nothing", (await db.payout.count({ where: { affiliateId: affiliateE.id, status: "PENDING" } })) === 0);

  // === 4. CSV exports (same builders the routes use) ===========================
  const aLines = await db.commission.findMany({
    where: { payoutId: aPayout.id },
    include: { conversion: { select: { externalOrderId: true, amountCents: true, createdAt: true } } },
    orderBy: { createdAt: "asc" },
  });
  const detailCsv = csvLib.payoutDetailCsv(aLines.map((c) => ({
    commissionId: c.id,
    externalOrderId: c.conversion?.externalOrderId ?? null,
    conversionDate: c.conversion?.createdAt ?? null,
    orderAmountCents: c.conversion?.amountCents ?? null,
    commissionCents: balanceLib.effectiveCommissionCents(c),
    currency: c.currency,
  })));
  const detailRows = parseCsv(detailCsv);
  check("detail CSV has header + 2 rows", detailRows.length === 3 && detailRows[0][0] === "commission_id");
  const detailSum = detailRows.slice(1).reduce((sum, r) => sum + Number(r[4]), 0);
  check("detail CSV commission column sums to the payout gross (3000)", detailSum === 3000 && detailSum === aPayout.grossCents);
  check("detail CSV escapes commas and quotes in order ids", detailCsv.includes(`"M5-A,""Q""-${suffix}"`) && detailRows.some((r) => r[1] === `M5-A,"Q"-${suffix}`));

  const allPayouts = await db.payout.findMany({
    where: { programId: program.id },
    include: { affiliate: { select: { email: true } } },
    orderBy: { createdAt: "desc" },
  });
  const listCsv = csvLib.payoutListCsv(allPayouts.map((p) => ({
    payoutId: p.id, affiliateEmail: p.affiliate.email,
    periodStart: p.periodStart, periodEnd: p.periodEnd,
    grossCents: p.grossCents, debtOffsetCents: p.debtOffsetCents, totalCents: p.totalCents,
    currency: p.currency, status: p.status, method: p.method, externalRef: p.externalRef, paidAt: p.paidAt,
  })));
  const listRows = parseCsv(listCsv);
  check("list CSV has one row per payout", listRows.length === allPayouts.length + 1);
  const aRow = listRows.find((r) => r[0] === aPayout.id);
  const bRow = listRows.find((r) => r[4] === "3000" && r[5] === "1500");
  check("list CSV figures match the DB (A gross 3000/total 3000)", !!aRow && aRow[4] === "3000" && aRow[6] === "3000");
  check("list CSV figures match the DB (B debt offset 1500, net 1500)", !!bRow && bRow[6] === "1500");
  const listGrossSum = listRows.slice(1).reduce((sum, r) => sum + Number(r[4]), 0);
  check("list CSV gross column sums to the DB total", listGrossSum === allPayouts.reduce((sum, p) => sum + p.grossCents, 0));

  // === 5. mail =================================================================
  const inviteM = await services.inviteAffiliate(
    db, admin.id, program.id,
    { name: "Partner M", email: `m5-m-${suffix}@example.test` },
    { baseUrl: "http://test.local" },
  );
  const inviteMails = await emailsTo(inviteM.affiliate.email, "invite");
  check("invite email logged on invite", inviteMails.length === 1);
  check("invite email carries the activation link", inviteMails[0].body.includes("http://test.local/activate?") && inviteMails[0].body.includes(inviteM.token));

  const affiliateF = await makeAffiliate(program.id, "Partner F", `m5-f-${suffix}@example.test`);
  await makeCommission(affiliateF, { amountCents: 500, status: "HOLDING", holdUntil: new Date(Date.now() - 3600000) });
  await makeCommission(affiliateF, { amountCents: 700, status: "HOLDING", holdUntil: new Date(Date.now() - 3600000) });
  const released = await commissionsLib.releaseMaturedCommissions(db, new Date());
  check("release flipped F's two commissions", released.count >= 2);
  const fMails = await emailsTo(affiliateF.email, "commission_available");
  check("release sent ONE aggregated availability email", fMails.length === 1);
  check("aggregated email carries count and total (2 / 1200)", fMails[0].body.includes("2") && fMails[0].body.includes("1200"));
  await services.updateAffiliateNotificationPrefs(db, { type: "AFFILIATE", id: affiliateF.id }, affiliateF.id, { commission: false, payout: true });
  await makeCommission(affiliateF, { amountCents: 300, status: "HOLDING", holdUntil: new Date(Date.now() - 3600000) });
  await commissionsLib.releaseMaturedCommissions(db, new Date());
  check("opted-out affiliate gets no further availability email", (await emailsTo(affiliateF.email, "commission_available")).length === 1);

  const affiliateG = await makeAffiliate(program.id, "Partner G", `m5-g-${suffix}@example.test`);
  const gCommission = await makeCommission(affiliateG, { amountCents: 900, status: "HOLDING", holdUntil: new Date(Date.now() + 86400000) });
  await commissionsLib.rejectCommission(db, admin.id, gCommission.id, "suspected self-referral");
  const gMails = await emailsTo(affiliateG.email, "commission_rejected");
  check("rejection email logged with the reason", gMails.length === 1 && gMails[0].body.includes("suspected self-referral"));

  console.log(`\nPayouts & mail suite: ${passed} checks passed`);
} finally {
  if (program) {
    await db.emailLog.deleteMany({ where: { programId: program.id } });
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
