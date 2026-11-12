/**
 * Summa test suite — admins, program settings, affiliate activation.
 * Repeatable and self-cleaning: fixtures are uniquely named and are
 * deleted again in `finally`.
 *
 * Covers:
 *  1. Zero-value regression: program fields saved as 0 read back as 0.
 *  2. Activation flow: pending -> set password -> active -> can sign in;
 *     disabled accounts cannot sign in; activation tokens are one-time.
 *  3. Audit log: every key operation above leaves a record.
 *  4. Building blocks: scrypt password hashing, HS256 session JWTs,
 *     one-time setup flow for the first admin.
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

// --- compile the TS service layer with the project's own TypeScript -------
// Compile inside node_modules/.cache so the emitted CommonJS can resolve
// the project's own dependencies (@prisma/client) by walking up.
mkdirSync(join(process.cwd(), "node_modules", ".cache"), { recursive: true });
const outDir = mkdtempSync(join(process.cwd(), "node_modules", ".cache", "summa-m1-test-"));
execSync(
  [
    "node_modules/.bin/tsc",
    "src/lib/services.ts",
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
const { parseProgramForm } = require(join(outDir, "program-form.js"));
const jwt = require(join(outDir, "jwt.js"));
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

try {
  // 1. Zero-value parsing (pure) -------------------------------------------
  const parsed = parseProgramForm({
    name: "T",
    slug: "t",
    commissionRateBps: "0",
    buyerDiscountBps: "0",
    currency: "usd",
    attributionWindowDays: "365",
    holdDays: "30",
    minPayoutCents: "0",
    payoutDayOfMonth: "10",
    isActive: "on",
  });
  check("parse: form parses", parsed.ok === true);
  check("parse: commissionRateBps 0 preserved", parsed.value.commissionRateBps === 0);
  check("parse: buyerDiscountBps 0 preserved", parsed.value.buyerDiscountBps === 0);
  check("parse: minPayoutCents 0 preserved", parsed.value.minPayoutCents === 0);
  check("parse: currency upper-cased", parsed.value.currency === "USD");

  // 2. JWT + password primitives -------------------------------------------
  const token = jwt.signSession({ sub: "x1", role: "admin", email: "a@b.c" }, "test-secret-test-secret");
  const payload = jwt.verifySession(token, "test-secret-test-secret");
  check("jwt: roundtrip keeps role", payload?.role === "admin" && payload?.sub === "x1");
  check("jwt: wrong secret rejected", jwt.verifySession(token, "other-secret-other-secret") === null);
  check("jwt: tampered token rejected", jwt.verifySession(token + "x", "test-secret-test-secret") === null);

  // 3. Admin setup is one-time ----------------------------------------------
  // Works on a pristine database (setup creates the first admin) and on a
  // database that already has one (setup is closed; fixture admin is then
  // inserted directly so the remaining checks have an actor).
  const { hashPassword } = require(join(outDir, "password.js"));
  if (await services.adminExists(db)) {
    admin = await db.admin.create({
      data: {
        name: "M1 Test Admin",
        email: `m1-admin-${suffix}@example.test`,
        passwordHash: hashPassword("test-password-1"),
      },
    });
    check("setup: already closed on a database with an admin", !!admin.id);
  } else {
    admin = await services.setupAdmin(db, {
      name: "M1 Test Admin",
      email: `m1-admin-${suffix}@example.test`,
      password: "test-password-1",
    });
    check("setup: first admin created", !!admin.id);
    const setupLog0 = await db.auditLog.findFirst({
      where: { action: "admin.setup", actorId: admin.id },
    });
    check("audit: admin.setup recorded", !!setupLog0);
  }
  let setupClosed = false;
  try {
    await services.setupAdmin(db, {
      name: "Second",
      email: `m1-admin2-${suffix}@example.test`,
      password: "test-password-2",
    });
  } catch (e) {
    setupClosed = e.message === "setup_closed";
  }
  check("setup: second setup rejected", setupClosed);
  check(
    "auth: admin authenticates",
    (await services.authenticateAdmin(db, admin.email, "test-password-1"))?.id === admin.id,
  );
  check(
    "auth: admin wrong password rejected",
    (await services.authenticateAdmin(db, admin.email, "nope-nope")) === null,
  );

  // 4. Program with zero values round-trips through the database -------------
  program = await services.createProgram(db, admin.id, {
    name: "M1 Test Program",
    slug: `m1-test-${suffix}`,
    commissionRateBps: 1500,
    buyerDiscountBps: 0,
    currency: "USD",
    attributionWindowDays: 365,
    holdDays: 30,
    minPayoutCents: 0,
    payoutDayOfMonth: 10,
    isActive: true,
  });
  let reread = await db.program.findUnique({ where: { id: program.id } });
  check("program: buyerDiscountBps 0 in db", reread.buyerDiscountBps === 0);
  check("program: minPayoutCents 0 in db", reread.minPayoutCents === 0);

  await services.updateProgram(db, admin.id, program.id, {
    name: "M1 Test Program",
    slug: `m1-test-${suffix}`,
    commissionRateBps: 0,
    buyerDiscountBps: 1500,
    currency: "USD",
    attributionWindowDays: 365,
    holdDays: 0,
    minPayoutCents: 500,
    payoutDayOfMonth: 10,
    isActive: true,
  });
  reread = await db.program.findUnique({ where: { id: program.id } });
  check("program: updated commissionRateBps 0 in db", reread.commissionRateBps === 0);
  check("program: updated holdDays 0 in db", reread.holdDays === 0);
  check("program: updated minPayoutCents 500 in db", reread.minPayoutCents === 500);
  check("program: updated buyerDiscountBps 1500 in db", reread.buyerDiscountBps === 1500);

  let secondProgramBlocked = false;
  try {
    await services.createProgram(db, admin.id, {
      name: "Second", slug: `m1-test2-${suffix}`, commissionRateBps: 1,
      buyerDiscountBps: 0, currency: "USD", attributionWindowDays: 1,
      holdDays: 1, minPayoutCents: 0, payoutDayOfMonth: 1, isActive: true,
    });
  } catch (e) {
    secondProgramBlocked = e.message === "program_exists";
  }
  check("program: single-program rule enforced", secondProgramBlocked);

  // 5. Affiliate activation flow ---------------------------------------------
  const inviteA = await services.inviteAffiliate(db, admin.id, program.id, {
    name: "Aff A",
    email: `m1-aff-a-${suffix}@example.test`,
  });
  check("invite: status pending", inviteA.affiliate.status === "PENDING_ACTIVATION");
  check("invite: no password yet", inviteA.affiliate.passwordHash === null);
  check(
    "invite: pending affiliate cannot sign in",
    (await services.authenticateAffiliate(db, program.id, inviteA.affiliate.email, "whatever-1")) === null,
  );
  const found = await services.findAffiliateByActivationToken(db, inviteA.token);
  check("activate: token resolves to affiliate", found?.id === inviteA.affiliate.id);

  const activated = await services.activateAffiliate(db, inviteA.token, "aff-password-1");
  check("activate: status becomes ACTIVE", activated.status === "ACTIVE");
  check("activate: activatedAt set", !!activated.activatedAt);
  let tokenReuseBlocked = false;
  try {
    await services.activateAffiliate(db, inviteA.token, "aff-password-2");
  } catch (e) {
    tokenReuseBlocked = e.message === "activation_token_invalid";
  }
  check("activate: token is one-time", tokenReuseBlocked);
  check(
    "auth: activated affiliate can sign in",
    (await services.authenticateAffiliate(db, program.id, activated.email, "aff-password-1"))?.id === activated.id,
  );

  // Reissue: new token works, old token dies.
  const inviteB = await services.inviteAffiliate(db, admin.id, program.id, {
    name: "Aff B",
    email: `m1-aff-b-${suffix}@example.test`,
  });
  const reissued = await services.reissueActivationToken(db, admin.id, inviteB.affiliate.id);
  check(
    "reissue: old token invalidated",
    (await services.findAffiliateByActivationToken(db, inviteB.token)) === null,
  );
  check(
    "reissue: new token resolves",
    (await services.findAffiliateByActivationToken(db, reissued.token))?.id === inviteB.affiliate.id,
  );
  const activatedB = await services.activateAffiliate(db, reissued.token, "aff-password-b");
  check("reissue: activation with new token works", activatedB.status === "ACTIVE");

  // Disable -> sign-in rejected; enable -> sign-in works again.
  await services.setAffiliateStatus(db, admin.id, activatedB.id, "DISABLED");
  check(
    "status: disabled affiliate cannot sign in",
    (await services.authenticateAffiliate(db, program.id, activatedB.email, "aff-password-b")) === null,
  );
  await services.setAffiliateStatus(db, admin.id, activatedB.id, "ACTIVE");
  check(
    "status: re-enabled affiliate can sign in",
    (await services.authenticateAffiliate(db, program.id, activatedB.email, "aff-password-b"))?.id === activatedB.id,
  );

  // Profile / payout updates --------------------------------------------------
  await services.updateAffiliatePayout(
    db,
    { type: "AFFILIATE", id: activated.id },
    activated.id,
    { method: "WISE", detailsText: "aff-a wise account" },
  );
  const afterPayout = await db.affiliate.findUnique({ where: { id: activated.id } });
  check("payout: method saved", afterPayout.payoutMethod === "WISE");
  check(
    "payout: details saved",
    services.payoutDetailsText(afterPayout) === "aff-a wise account",
  );
  check(
    "password: change with correct current password",
    (await services.changeAffiliatePassword(db, activated.id, "aff-password-1", "aff-password-9")) === true,
  );
  check(
    "password: old password no longer signs in",
    (await services.authenticateAffiliate(db, program.id, activated.email, "aff-password-1")) === null,
  );

  // 6. Audit log ---------------------------------------------------------------
  const logs = await db.auditLog.findMany({
    where: { programId: program.id },
    orderBy: { createdAt: "asc" },
  });
  const actions = new Set(logs.map((l) => l.action));
  for (const expected of [
    "program.create",
    "program.update",
    "affiliate.invite",
    "affiliate.activate",
    "affiliate.activation_reissue",
    "affiliate.disable",
    "affiliate.enable",
    "affiliate.payout_update",
    "affiliate.password_change",
  ]) {
    check(`audit: ${expected} recorded`, actions.has(expected));
  }
  check(
    "audit: entries carry actor ids",
    logs.every((l) => typeof l.actorId === "string" && l.actorId.length > 0),
  );
  console.log(`\nAdmin & affiliates suite: ${passed} checks passed`);
} finally {
  // Cleanup: remove everything this run created.
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
