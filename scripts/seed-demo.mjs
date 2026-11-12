/**
 * Seed demo data — `npm run seed:demo`.
 *
 * Creates one clearly-labelled demo program with affiliates, links,
 * clicks, conversions, commissions in every lifecycle state, one paid
 * payout and a few email-log rows, so a fresh install can be explored
 * without wiring up a real store first.
 *
 * Safety rails:
 *  - Refuses to run when the database holds any *other* program
 *    (delete your real program first, or use a scratch database).
 *  - Re-running wipes the previous demo batch and recreates it. Demo
 *    rows are recognised by the program slug `summa-demo` and the
 *    `@demo.summa.example` email domain; nothing else is touched.
 *
 * Demo sign-in (DEMO ONLY, printed by design so evaluators can log in):
 *   alice@demo.summa.example / demo-password
 * Never expose an install seeded with these credentials to the
 * internet without deleting the demo program first.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { PrismaClient } from "@prisma/client";

// Load ./.env when present (source checkout). In the Docker image the
// configuration arrives as real environment variables instead.
const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_]+)=="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const DEMO_SLUG = "summa-demo";
const DEMO_DOMAIN = "demo.summa.example";
const DEMO_PASSWORD = "demo-password";
const BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3000";

/** Same storage format as src/lib/password.ts (scrypt, built-in). */
function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return ["scrypt", "16384", "8", "1", salt.toString("base64url"), key.toString("base64url")].join("$");
}

function hashActivationToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

const dayMs = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * dayMs);
const daysAhead = (n) => new Date(Date.now() + n * dayMs);

const db = new PrismaClient();

try {
  // --- Guard: never mix demo data into an install that has real data.
  const otherPrograms = await db.program.count({ where: { slug: { not: DEMO_SLUG } } });
  if (otherPrograms > 0) {
    console.error(
      "seed:demo refused: this database already contains a non-demo program.\n" +
        "Demo data is for scratch installs only — use a fresh database.",
    );
    process.exitCode = 1;
  } else {
    // --- Wipe the previous demo batch (idempotent re-runs).
    const previous = await db.program.findUnique({ where: { slug: DEMO_SLUG } });
    if (previous) {
      await db.emailLog.deleteMany({
        where: {
          OR: [{ programId: previous.id }, { toEmail: { endsWith: "@" + DEMO_DOMAIN } }],
        },
      });
      await db.program.delete({ where: { id: previous.id } }); // cascades to all demo rows
      console.log("seed:demo — removed previous demo batch");
    }

    // --- Program.
    const program = await db.program.create({
      data: {
        name: "Summa Demo Program",
        slug: DEMO_SLUG,
        commissionRateBps: 1500, // 15%
        currency: "USD",
        attributionWindowDays: 30,
        holdDays: 30,
        minPayoutCents: 0,
        payoutDayOfMonth: 10,
        defaultTargetUrl: "https://example.com/",
      },
    });

    // --- Affiliates: one per lifecycle state.
    const alice = await db.affiliate.create({
      data: {
        programId: program.id,
        name: "Alice Demo",
        email: `alice@${DEMO_DOMAIN}`,
        passwordHash: hashPassword(DEMO_PASSWORD),
        status: "ACTIVE",
        activatedAt: daysAgo(75),
        payoutMethod: "WISE",
      },
    });
    const bobToken = randomBytes(24).toString("hex");
    const bob = await db.affiliate.create({
      data: {
        programId: program.id,
        name: "Bob Demo",
        email: `bob@${DEMO_DOMAIN}`,
        status: "PENDING_ACTIVATION",
        activationTokenHash: hashActivationToken(bobToken),
        activationTokenExpiresAt: daysAhead(7),
      },
    });
    const carol = await db.affiliate.create({
      data: {
        programId: program.id,
        name: "Carol Demo",
        email: `carol@${DEMO_DOMAIN}`,
        passwordHash: hashPassword(DEMO_PASSWORD),
        status: "DISABLED",
        activatedAt: daysAgo(60),
        payoutMethod: "PAYPAL",
      },
    });

    // --- Referral links + a discount code.
    const aliceMain = await db.referralLink.create({
      data: { programId: program.id, affiliateId: alice.id, code: "demo-alice-main", channel: "youtube" },
    });
    const aliceBlog = await db.referralLink.create({
      data: { programId: program.id, affiliateId: alice.id, code: "demo-alice-blog", channel: "blog" },
    });
    const carolMain = await db.referralLink.create({
      data: { programId: program.id, affiliateId: carol.id, code: "demo-carol-main", channel: "newsletter" },
    });
    await db.discountCode.create({
      data: { programId: program.id, affiliateId: alice.id, code: "DEMOALICE", discountBps: 1000 },
    });

    // --- Clicks (documentation-range IPs, clearly fictional).
    const clickRows = [];
    const addClicks = (link, count, spreadDays) => {
      for (let i = 0; i < count; i++) {
        clickRows.push({
          programId: program.id,
          linkId: link.id,
          visitorToken: `demo-visitor-${link.code}-${i + 1}`,
          referrer: i % 3 === 0 ? "https://www.google.com/" : "https://www.youtube.com/",
          ipAddress: `203.0.113.${10 + (i % 40)}`,
          userAgent: "Summa demo seed (fictional click)",
          createdAt: daysAgo(Math.floor((i / count) * spreadDays)),
        });
      }
    };
    addClicks(aliceMain, 30, 13);
    addClicks(aliceBlog, 12, 13);
    addClicks(carolMain, 6, 20);
    await db.click.createMany({ data: clickRows });

    // --- One paid payout for Alice (holds the PAID commission below).
    const lastMonth = new Date();
    lastMonth.setUTCDate(1);
    lastMonth.setUTCHours(0, 0, 0, 0);
    const periodEnd = new Date(lastMonth.getTime() - dayMs);
    const periodStart = new Date(periodEnd);
    periodStart.setUTCDate(1);
    const payout = await db.payout.create({
      data: {
        programId: program.id,
        affiliateId: alice.id,
        periodStart,
        periodEnd,
        grossCents: 3000,
        debtOffsetCents: 0,
        totalCents: 3000,
        currency: "USD",
        status: "PAID",
        method: "WISE",
        externalRef: "DEMO-WISE-0001",
        paidAt: daysAgo(12),
      },
    });

    // --- Conversions, each with its commission (15% of the order).
    const seedConversion = async ({
      orderId, amountCents, status, occurredDaysAgo, source, isRenewal = false,
      refundedCents = 0, commission,
    }) => {
      const conversion = await db.conversion.create({
        data: {
          programId: program.id,
          affiliateId: alice.id,
          externalOrderId: orderId,
          customerRef: `demo-customer-${orderId}`,
          amountCents,
          currency: "USD",
          isRenewal,
          refundedCents,
          status,
          idempotencyKey: `demo-seed-${orderId}`,
          source,
          occurredAt: daysAgo(occurredDaysAgo),
        },
      });
      await db.commission.create({
        data: {
          programId: program.id,
          affiliateId: alice.id,
          conversionId: conversion.id,
          amountCents: Math.floor((amountCents * program.commissionRateBps) / 10000),
          currency: "USD",
          ...commission,
        },
      });
    };

    await seedConversion({
      orderId: "DEMO-1001", amountCents: 12000, status: "CONFIRMED",
      occurredDaysAgo: 2, source: "link",
      commission: { status: "HOLDING", holdUntil: daysAhead(28) },
    });
    await seedConversion({
      orderId: "DEMO-1002", amountCents: 8000, status: "CONFIRMED",
      occurredDaysAgo: 40, source: "code",
      commission: { status: "AVAILABLE", holdUntil: daysAgo(10) },
    });
    await seedConversion({
      orderId: "DEMO-1003", amountCents: 20000, status: "CONFIRMED",
      occurredDaysAgo: 70, source: "link",
      commission: { status: "PAID", holdUntil: daysAgo(40), payoutId: payout.id },
    });
    await seedConversion({
      orderId: "DEMO-1004", amountCents: 6000, status: "REFUNDED",
      occurredDaysAgo: 20, source: "link", refundedCents: 6000,
      commission: {
        status: "REVERSED", reversedCents: 900, holdUntil: daysAhead(10),
        statusReason: "Demo: order refunded in full",
      },
    });
    await seedConversion({
      orderId: "DEMO-1005", amountCents: 15000, status: "CONFIRMED",
      occurredDaysAgo: 5, source: "api", isRenewal: true,
      commission: { status: "HOLDING", holdUntil: daysAhead(25) },
    });

    // --- Email log rows (the "log" transport's delivery record).
    const activationUrl = new URL("/activate", BASE_URL);
    activationUrl.searchParams.set("token", bobToken);
    await db.emailLog.createMany({
      data: [
        {
          programId: program.id,
          toEmail: bob.email,
          type: "invite",
          subject: "You are invited to join Summa Demo Program",
          body:
            "Demo email (seed data, never sent).\n\n" +
            `Activate your affiliate account: ${activationUrl.toString()}`,
          status: "logged",
          relatedType: "affiliate",
          relatedId: bob.id,
        },
        {
          programId: program.id,
          toEmail: alice.email,
          type: "commission_available",
          subject: "Demo: commissions became available",
          body: "Demo email (seed data, never sent).\n\n1 commission totalling 12.00 USD is now available.",
          status: "logged",
          relatedType: "affiliate",
          relatedId: alice.id,
        },
        {
          programId: program.id,
          toEmail: alice.email,
          type: "payout_paid",
          subject: "Demo: your payout of 30.00 USD is on its way",
          body: "Demo email (seed data, never sent).\n\nPaid via WISE, reference DEMO-WISE-0001.",
          status: "logged",
          relatedType: "payout",
          relatedId: payout.id,
        },
      ],
    });

    console.log("seed:demo — demo data created:");
    console.log(`  program        ${program.name} (slug: ${DEMO_SLUG}, 15% commission)`);
    console.log(`  affiliates     alice (ACTIVE), bob (PENDING_ACTIVATION), carol (DISABLED)`);
    console.log(`  links          demo-alice-main, demo-alice-blog, demo-carol-main; code DEMOALICE (10% off)`);
    console.log(`  activity       ${clickRows.length} clicks, 5 conversions, 5 commissions (HOLDING x2, AVAILABLE, PAID, REVERSED), 1 paid payout, 3 email logs`);
    console.log("");
    console.log("  DEMO sign-in (demo only — delete the demo program before any");
    console.log("  internet-facing use):");
    console.log(`    affiliate portal  ${BASE_URL}/affiliate/login`);
    console.log(`    email             alice@${DEMO_DOMAIN}`);
    console.log(`    password          ${DEMO_PASSWORD}`);
    console.log(`  Bob's activation link (valid 7 days): ${activationUrl.toString()}`);
  }
} finally {
  await db.$disconnect();
}
