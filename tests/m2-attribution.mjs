/**
 * Summa test suite — referral links, click tracking, attribution,
 * discount codes. Repeatable and self-cleaning: fixtures are uniquely
 * named and are deleted again in `finally`.
 *
 * Covers:
 *  1. A live /r/:code click records exactly one Click row with referrer,
 *     IP, user agent and a fresh visitor token, and the redirect target
 *     carries summa_vid (dual channel: cookie + URL) while preserving
 *     the target's own query parameters.
 *  2. Unknown code / disabled link / disabled affiliate / inactive
 *     program all answer "not found" and record NO click.
 *  3. Attribution window: a click older than the window does not
 *     attribute; a fresh one resolves to the right affiliate; a token
 *     whose link was disabled stops resolving.
 *  4. Discount codes: stored normalized (upper-case), globally unique,
 *     reverse-look-up returns the owning affiliate, a disabled code
 *     stops resolving.
 *  5. Audit log records link/code operations.
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
    const match = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

// --- compile the TS service/attribution layer with the project's tsc -------
mkdirSync(join(process.cwd(), "node_modules", ".cache"), { recursive: true });
const outDir = mkdtempSync(join(process.cwd(), "node_modules", ".cache", "summa-m2-test-"));
execSync(
  [
    "node_modules/.bin/tsc",
    "src/lib/services.ts",
    "src/lib/attribution.ts",
    "src/lib/program-form.ts",
    "src/lib/jwt.ts",
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
const { parseProgramForm } = require(join(outDir, "program-form.js"));
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
const ORIGIN = process.env.SUMMA_TEST_ORIGIN || "http://127.0.0.1:3457";
let admin = null;
let program = null;

try {
  // 0. Program form: defaultTargetUrl parsing --------------------------------
  const baseFields = {
    name: "T", slug: "t", commissionRateBps: "1500", buyerDiscountBps: "1500",
    currency: "usd", attributionWindowDays: "30", holdDays: "30",
    minPayoutCents: "0", payoutDayOfMonth: "10", isActive: "on",
  };
  const blankTarget = parseProgramForm({ ...baseFields, defaultTargetUrl: "" });
  check("form: blank defaultTargetUrl parses to null", blankTarget.ok && blankTarget.value.defaultTargetUrl === null);
  const pathTarget = parseProgramForm({ ...baseFields, defaultTargetUrl: "/landing" });
  check("form: path defaultTargetUrl accepted", pathTarget.ok && pathTarget.value.defaultTargetUrl === "/landing");
  const badTarget = parseProgramForm({ ...baseFields, defaultTargetUrl: "javascript:alert(1)" });
  check("form: non-http(s) defaultTargetUrl rejected", badTarget.ok === false);
  const protoRelative = parseProgramForm({ ...baseFields, defaultTargetUrl: "//evil.example/x" });
  check("form: protocol-relative defaultTargetUrl rejected", protoRelative.ok === false);

  // 1. Fixtures: admin, program (with default target), two affiliates --------
  if (await services.adminExists(db)) {
    admin = await db.admin.create({
      data: {
        name: "M2 Test Admin",
        email: `m2-admin-${suffix}@example.test`,
        passwordHash: hashPassword("test-password-1"),
      },
    });
  } else {
    admin = await services.setupAdmin(db, {
      name: "M2 Test Admin",
      email: `m2-admin-${suffix}@example.test`,
      password: "test-password-1",
    });
  }
  program = await services.createProgram(db, admin.id, {
    name: "M2 Test Program",
    slug: `m2-test-${suffix}`,
    commissionRateBps: 1500,
    buyerDiscountBps: 1500,
    currency: "USD",
    attributionWindowDays: 30,
    holdDays: 30,
    minPayoutCents: 0,
    payoutDayOfMonth: 10,
    defaultTargetUrl: "https://example.com/default?d=1",
    isActive: true,
  });
  check("program: defaultTargetUrl stored", program.defaultTargetUrl === "https://example.com/default?d=1");

  const inviteA = await services.inviteAffiliate(db, admin.id, program.id, {
    name: "Aff A", email: `m2-aff-a-${suffix}@example.test`,
  });
  const affA = await services.activateAffiliate(db, inviteA.token, "aff-password-1");
  const inviteB = await services.inviteAffiliate(db, admin.id, program.id, {
    name: "Aff B", email: `m2-aff-b-${suffix}@example.test`,
  });
  const affB = await services.activateAffiliate(db, inviteB.token, "aff-password-1");

  // 2. Link creation rules -----------------------------------------------------
  let forbiddenBlocked = false;
  try {
    await services.createReferralLink(db, { type: "AFFILIATE", id: affB.id }, affA.id, { targetUrl: "https://example.com/x" });
  } catch (e) { forbiddenBlocked = e.message === "forbidden"; }
  check("link: affiliate cannot create for someone else", forbiddenBlocked);

  const linkA = await services.createReferralLink(
    db, { type: "AFFILIATE", id: affA.id }, affA.id,
    { channel: "blog", targetUrl: "https://example.com/landing?src=m2" },
  );
  check("link: created with generated code", typeof linkA.code === "string" && linkA.code.length >= 8);
  const linkDefault = await services.createReferralLink(
    db, { type: "AFFILIATE", id: affA.id }, affA.id, { channel: "", targetUrl: "" },
  );
  check("link: created without own target (falls back to program default)", linkDefault.targetUrl === null);

  await db.program.update({ where: { id: program.id }, data: { defaultTargetUrl: null } });
  let targetRequired = false;
  try {
    await services.createReferralLink(db, { type: "AFFILIATE", id: affA.id }, affA.id, { targetUrl: "" });
  } catch (e) { targetRequired = e.message === "target_required"; }
  check("link: no target anywhere -> creation refused", targetRequired);
  await db.program.update({ where: { id: program.id }, data: { defaultTargetUrl: "https://example.com/default?d=1" } });

  // 3. Click intake: the happy path ---------------------------------------------
  const clickCountFor = (linkId) => db.click.count({ where: { linkId } });
  const hit = await attribution.handleReferralClick(
    db, linkA.code,
    { referrer: "https://google.com/", ipAddress: "203.0.113.9", userAgent: "M2TestUA/1.0" },
    ORIGIN,
  );
  check("click: live link redirects", hit.kind === "redirect");
  check("click: exactly one click recorded", (await clickCountFor(linkA.id)) === 1);
  const clickRow = await db.click.findUnique({ where: { id: hit.clickId } });
  check("click: visitor token stored and returned", clickRow.visitorToken === hit.visitorToken);
  check("click: referrer stored", clickRow.referrer === "https://google.com/");
  check("click: ip stored", clickRow.ipAddress === "203.0.113.9");
  check("click: user agent stored", clickRow.userAgent === "M2TestUA/1.0");
  check("click: cookie max-age equals attribution window", hit.cookieMaxAgeSeconds === 30 * 24 * 60 * 60);
  const loc = new URL(hit.location);
  check("click: redirect keeps target host/path", loc.origin + loc.pathname === "https://example.com/landing");
  check("click: redirect preserves target params", loc.searchParams.get("src") === "m2");
  check("click: redirect appends summa_vid", loc.searchParams.get("summa_vid") === hit.visitorToken);

  // Default-target link and relative-target link redirect correctly.
  const hitDefault = await attribution.handleReferralClick(db, linkDefault.code, {}, ORIGIN);
  check("click: default target used when link has none",
    hitDefault.kind === "redirect" && hitDefault.location.startsWith("https://example.com/default"));
  const linkRelative = await services.createReferralLink(
    db, { type: "AFFILIATE", id: affA.id }, affA.id, { targetUrl: "/pricing?x=1" },
  );
  const hitRelative = await attribution.handleReferralClick(db, linkRelative.code, {}, ORIGIN);
  const relLoc = new URL(hitRelative.location);
  check("click: relative target resolved against origin",
    hitRelative.kind === "redirect" && relLoc.origin === ORIGIN && relLoc.pathname === "/pricing" && relLoc.searchParams.get("x") === "1" && !!relLoc.searchParams.get("summa_vid"));

  // 4. Click intake: the four 404 cases record nothing -------------------------
  const beforeA = await clickCountFor(linkA.id);
  const dead = await attribution.handleReferralClick(db, "nosuchcode", {}, ORIGIN);
  check("404: unknown code", dead.kind === "not_found");
  await services.setReferralLinkActive(db, { type: "AFFILIATE", id: affA.id }, linkA.id, false);
  const disabledHit = await attribution.handleReferralClick(db, linkA.code, {}, ORIGIN);
  check("404: disabled link", disabledHit.kind === "not_found");
  check("404: disabled link recorded no click", (await clickCountFor(linkA.id)) === beforeA);
  check("attribution: token of a disabled link stops resolving",
    (await attribution.resolveAttributionByToken(db, hit.visitorToken)) === null);
  await services.setReferralLinkActive(db, { type: "ADMIN", id: admin.id }, linkA.id, true);

  const linkB = await services.createReferralLink(
    db, { type: "AFFILIATE", id: affB.id }, affB.id, { targetUrl: "https://example.com/b" },
  );
  await services.setAffiliateStatus(db, admin.id, affB.id, "DISABLED");
  const beforeB = await clickCountFor(linkB.id);
  const disabledAffHit = await attribution.handleReferralClick(db, linkB.code, {}, ORIGIN);
  check("404: disabled affiliate's link", disabledAffHit.kind === "not_found");
  check("404: disabled affiliate recorded no click", (await clickCountFor(linkB.id)) === beforeB);

  await db.program.update({ where: { id: program.id }, data: { isActive: false } });
  const inactiveProgramHit = await attribution.handleReferralClick(db, linkA.code, {}, ORIGIN);
  check("404: inactive program's link", inactiveProgramHit.kind === "not_found");
  check("404: inactive program recorded no click", (await clickCountFor(linkA.id)) === beforeA);
  await db.program.update({ where: { id: program.id }, data: { isActive: true } });

  // 5. Attribution window ---------------------------------------------------------
  const fresh = await attribution.resolveAttributionByToken(db, hit.visitorToken);
  check("attribution: fresh token resolves", fresh?.affiliateId === affA.id && fresh?.linkId === linkA.id);
  check("attribution: unknown token is null", (await attribution.resolveAttributionByToken(db, "nope")) === null);
  check("attribution: empty token is null", (await attribution.resolveAttributionByToken(db, null)) === null);

  await db.program.update({ where: { id: program.id }, data: { attributionWindowDays: 1 } });
  const oldToken = `m2-old-${suffix}`;
  await db.click.create({
    data: {
      programId: program.id,
      linkId: linkA.id,
      visitorToken: oldToken,
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    },
  });
  check("attribution: click from day 2 with a 1-day window does not attribute",
    (await attribution.resolveAttributionByToken(db, oldToken)) === null);
  const freshInWindow = await attribution.resolveAttributionByToken(db, hit.visitorToken);
  check("attribution: today's click still attributes inside the 1-day window",
    freshInWindow?.affiliateId === affA.id);
  await db.program.update({ where: { id: program.id }, data: { attributionWindowDays: 30 } });

  // 6. Discount codes ----------------------------------------------------------------
  const created = await services.createDiscountCode(db, admin.id, affA.id, {
    code: " m2-partner-15 ", discountBps: 1500,
  });
  check("code: stored normalized to upper-case", created.code === "M2-PARTNER-15");
  let takenBlocked = false;
  try {
    await services.createDiscountCode(db, admin.id, affB.id, { code: "m2-partner-15", discountBps: 500 });
  } catch (e) { takenBlocked = e.message === "code_taken"; }
  check("code: globally unique across affiliates", takenBlocked);
  let invalidBlocked = false;
  try {
    await services.createDiscountCode(db, admin.id, affA.id, { code: "bad code!", discountBps: 500 });
  } catch (e) { invalidBlocked = e.message === "code_invalid"; }
  check("code: invalid characters rejected", invalidBlocked);

  const resolved = await attribution.resolveDiscountCode(db, "m2-partner-15");
  check("code: lower-case input resolves", resolved?.affiliateId === affA.id && resolved?.discountCodeId === created.id);
  check("code: discount bps returned", resolved?.discountBps === 1500);
  check("code: padded input resolves", (await attribution.resolveDiscountCode(db, "  M2-PARTNER-15 "))?.affiliateId === affA.id);
  check("code: unknown code is null", (await attribution.resolveDiscountCode(db, "UNKNOWN-1")) === null);

  const codeB = await services.createDiscountCode(db, admin.id, affB.id, {
    code: `M2-BEE-${suffix.slice(-4)}`, discountBps: 500,
  });
  check("code: disabled affiliate's code does not resolve",
    (await attribution.resolveDiscountCode(db, codeB.code)) === null);

  await services.setDiscountCodeActive(db, admin.id, created.id, false);
  check("code: disabled code stops resolving",
    (await attribution.resolveDiscountCode(db, "M2-PARTNER-15")) === null);
  await services.setDiscountCodeActive(db, admin.id, created.id, true);
  check("code: re-enabled code resolves again",
    (await attribution.resolveDiscountCode(db, "M2-PARTNER-15"))?.affiliateId === affA.id);

  // 7. Audit ----------------------------------------------------------------------------
  const logs = await db.auditLog.findMany({ where: { programId: program.id } });
  const actions = new Set(logs.map((l) => l.action));
  for (const expected of ["link.create", "link.disable", "link.enable", "discount_code.create", "discount_code.disable", "discount_code.enable"]) {
    check(`audit: ${expected} recorded`, actions.has(expected));
  }

  console.log(`\nAttribution suite: ${passed} checks passed`);
} finally {
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
