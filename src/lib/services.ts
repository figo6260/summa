import { createHash, randomBytes } from "node:crypto";
import type {
  Affiliate,
  DiscountCode,
  PayoutMethod,
  PrismaClient,
  ReferralLink,
} from "@prisma/client";
import { prisma } from "./prisma";
import { hashPassword, verifyPassword } from "./password";
import { writeAudit } from "./audit";
import { isValidTargetUrl, type ProgramInput } from "./program-form";
import { normalizeDiscountCode } from "./attribution";
import { sendInviteEmail } from "./mailer";

/**
 * M1 service layer: all program / affiliate / admin business logic lives
 * here (used by the server actions and by the M1 test suite alike), and
 * every key operation writes an audit-log entry.
 */

export const ACTIVATION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Admin setup & authentication
// ---------------------------------------------------------------------------

export async function adminExists(db: PrismaClient = prisma): Promise<boolean> {
  return (await db.admin.count()) > 0;
}

export async function setupAdmin(
  db: PrismaClient,
  input: { name: string; email: string; password: string },
) {
  if (await adminExists(db)) {
    throw new Error("setup_closed");
  }
  const admin = await db.admin.create({
    data: {
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      passwordHash: hashPassword(input.password),
    },
  });
  await writeAudit(db, {
    actorType: "ADMIN",
    actorId: admin.id,
    action: "admin.setup",
    targetType: "Admin",
    targetId: admin.id,
  });
  return admin;
}

export async function authenticateAdmin(
  db: PrismaClient,
  email: string,
  password: string,
) {
  const admin = await db.admin.findUnique({
    where: { email: email.trim().toLowerCase() },
  });
  if (!admin || !verifyPassword(password, admin.passwordHash)) return null;
  return admin;
}

// ---------------------------------------------------------------------------
// Program (single-program core: at most one Program per instance)
// ---------------------------------------------------------------------------

export async function getSingleProgram(db: PrismaClient = prisma) {
  return db.program.findFirst({ orderBy: { createdAt: "asc" } });
}

export async function createProgram(
  db: PrismaClient,
  actorId: string,
  input: ProgramInput,
) {
  const existing = await getSingleProgram(db);
  if (existing) throw new Error("program_exists");
  const program = await db.program.create({ data: input });
  await writeAudit(db, {
    programId: program.id,
    actorType: "ADMIN",
    actorId,
    action: "program.create",
    targetType: "Program",
    targetId: program.id,
    metadata: { ...input },
  });
  return program;
}

export async function updateProgram(
  db: PrismaClient,
  actorId: string,
  programId: string,
  input: ProgramInput,
) {
  const program = await db.program.update({ where: { id: programId }, data: input });
  await writeAudit(db, {
    programId: program.id,
    actorType: "ADMIN",
    actorId,
    action: "program.update",
    targetType: "Program",
    targetId: program.id,
    metadata: { ...input },
  });
  return program;
}

// ---------------------------------------------------------------------------
// Affiliates: invite, activation, status, profile, payout details
// ---------------------------------------------------------------------------

export function hashActivationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Build an activation link without embedding the raw token in a
 *  query-string literal (kept as a helper so every caller agrees). */
export function activationLinkFor(baseUrl: string, token: string): string {
  const url = new URL("/activate", baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

export interface InviteResult {
  affiliate: Affiliate;
  /** Plain activation token — only available at issuance time. */
  token: string;
  expiresAt: Date;
}

export async function inviteAffiliate(
  db: PrismaClient,
  actorId: string,
  programId: string,
  input: { name: string; email: string },
  opts?: { baseUrl?: string },
): Promise<InviteResult> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ACTIVATION_TOKEN_TTL_MS);
  const affiliate = await db.affiliate.create({
    data: {
      programId,
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      status: "PENDING_ACTIVATION",
      passwordHash: null,
      activationTokenHash: hashActivationToken(token),
      activationTokenExpiresAt: expiresAt,
    },
  });
  await writeAudit(db, {
    programId,
    actorType: "ADMIN",
    actorId,
    action: "affiliate.invite",
    targetType: "Affiliate",
    targetId: affiliate.id,
    metadata: { email: affiliate.email },
  });
  // The invite email carries the activation link — it is this
  // product's verification-class email (M5). sendMail never throws.
  const baseUrl = opts?.baseUrl ?? process.env.APP_BASE_URL;
  if (baseUrl) {
    const program = await db.program.findUnique({
      where: { id: programId },
      select: { name: true },
    });
    await sendInviteEmail(db, {
      affiliate,
      programName: program?.name ?? "",
      activationUrl: activationLinkFor(baseUrl, token),
      expiresAt,
    });
  }
  return { affiliate, token, expiresAt };
}

/** Issue a fresh activation token for a pending affiliate; the old one dies. */
export async function reissueActivationToken(
  db: PrismaClient,
  actorId: string,
  affiliateId: string,
  opts?: { baseUrl?: string },
): Promise<InviteResult> {
  const current = await db.affiliate.findUnique({ where: { id: affiliateId } });
  if (!current) throw new Error("affiliate_not_found");
  if (current.status !== "PENDING_ACTIVATION") throw new Error("affiliate_not_pending");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ACTIVATION_TOKEN_TTL_MS);
  const affiliate = await db.affiliate.update({
    where: { id: affiliateId },
    data: {
      activationTokenHash: hashActivationToken(token),
      activationTokenExpiresAt: expiresAt,
    },
  });
  await writeAudit(db, {
    programId: affiliate.programId,
    actorType: "ADMIN",
    actorId,
    action: "affiliate.activation_reissue",
    targetType: "Affiliate",
    targetId: affiliate.id,
  });
  const baseUrl = opts?.baseUrl ?? process.env.APP_BASE_URL;
  if (baseUrl) {
    const program = await db.program.findUnique({
      where: { id: affiliate.programId },
      select: { name: true },
    });
    await sendInviteEmail(db, {
      affiliate,
      programName: program?.name ?? "",
      activationUrl: activationLinkFor(baseUrl, token),
      expiresAt,
    });
  }
  return { affiliate, token, expiresAt };
}

export async function findAffiliateByActivationToken(
  db: PrismaClient,
  token: string,
): Promise<Affiliate | null> {
  if (!token) return null;
  const affiliate = await db.affiliate.findUnique({
    where: { activationTokenHash: hashActivationToken(token) },
  });
  if (!affiliate) return null;
  if (affiliate.status !== "PENDING_ACTIVATION") return null;
  if (
    !affiliate.activationTokenExpiresAt ||
    affiliate.activationTokenExpiresAt.getTime() < Date.now()
  ) {
    return null;
  }
  return affiliate;
}

/** Set the password from an activation link: pending → active, token consumed. */
export async function activateAffiliate(
  db: PrismaClient,
  token: string,
  password: string,
): Promise<Affiliate> {
  const affiliate = await findAffiliateByActivationToken(db, token);
  if (!affiliate) throw new Error("activation_token_invalid");
  const updated = await db.affiliate.update({
    where: { id: affiliate.id },
    data: {
      passwordHash: hashPassword(password),
      status: "ACTIVE",
      activatedAt: new Date(),
      activationTokenHash: null,
      activationTokenExpiresAt: null,
    },
  });
  await writeAudit(db, {
    programId: updated.programId,
    actorType: "AFFILIATE",
    actorId: updated.id,
    action: "affiliate.activate",
    targetType: "Affiliate",
    targetId: updated.id,
  });
  return updated;
}

export async function authenticateAffiliate(
  db: PrismaClient,
  programId: string,
  email: string,
  password: string,
): Promise<Affiliate | null> {
  const affiliate = await db.affiliate.findUnique({
    where: { programId_email: { programId, email: email.trim().toLowerCase() } },
  });
  if (!affiliate) return null;
  // Only ACTIVE accounts may sign in: pending accounts must activate
  // first, disabled accounts are rejected outright.
  if (affiliate.status !== "ACTIVE") return null;
  if (!verifyPassword(password, affiliate.passwordHash)) return null;
  return affiliate;
}

export async function setAffiliateStatus(
  db: PrismaClient,
  actorId: string,
  affiliateId: string,
  status: "ACTIVE" | "DISABLED",
) {
  const affiliate = await db.affiliate.update({
    where: { id: affiliateId },
    data: { status },
  });
  await writeAudit(db, {
    programId: affiliate.programId,
    actorType: "ADMIN",
    actorId,
    action: status === "ACTIVE" ? "affiliate.enable" : "affiliate.disable",
    targetType: "Affiliate",
    targetId: affiliate.id,
  });
  return affiliate;
}

export async function updateAffiliateProfile(
  db: PrismaClient,
  actor: { type: "ADMIN" | "AFFILIATE"; id: string },
  affiliateId: string,
  input: { name: string; email?: string },
) {
  const data: { name: string; email?: string } = { name: input.name.trim() };
  if (input.email !== undefined) data.email = input.email.trim().toLowerCase();
  const affiliate = await db.affiliate.update({ where: { id: affiliateId }, data });
  await writeAudit(db, {
    programId: affiliate.programId,
    actorType: actor.type,
    actorId: actor.id,
    action: "affiliate.profile_update",
    targetType: "Affiliate",
    targetId: affiliate.id,
  });
  return affiliate;
}

export async function updateAffiliatePayout(
  db: PrismaClient,
  actor: { type: "ADMIN" | "AFFILIATE"; id: string },
  affiliateId: string,
  input: { method: PayoutMethod; detailsText: string },
) {
  const affiliate = await db.affiliate.update({
    where: { id: affiliateId },
    data: {
      payoutMethod: input.method,
      payoutDetails: { account: input.detailsText.trim() },
    },
  });
  await writeAudit(db, {
    programId: affiliate.programId,
    actorType: actor.type,
    actorId: actor.id,
    action: "affiliate.payout_update",
    targetType: "Affiliate",
    targetId: affiliate.id,
    metadata: { method: input.method },
  });
  return affiliate;
}

export async function changeAffiliatePassword(
  db: PrismaClient,
  affiliateId: string,
  currentPassword: string,
  newPassword: string,
): Promise<boolean> {
  const affiliate = await db.affiliate.findUnique({ where: { id: affiliateId } });
  if (!affiliate || !verifyPassword(currentPassword, affiliate.passwordHash)) {
    return false;
  }
  await db.affiliate.update({
    where: { id: affiliateId },
    data: { passwordHash: hashPassword(newPassword) },
  });
  await writeAudit(db, {
    programId: affiliate.programId,
    actorType: "AFFILIATE",
    actorId: affiliate.id,
    action: "affiliate.password_change",
    targetType: "Affiliate",
    targetId: affiliate.id,
  });
  return true;
}

// ---------------------------------------------------------------------------
// M2: referral links (affiliate-owned) and discount codes (admin-issued)
// ---------------------------------------------------------------------------

export type Actor = { type: "ADMIN" | "AFFILIATE"; id: string };

const LINK_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o/1/l/i

/** Generate one random link code; uniqueness is enforced by the DB. */
export function generateLinkCode(): string {
  const bytes = randomBytes(10);
  let code = "";
  for (const byte of bytes) code += LINK_CODE_ALPHABET[byte % LINK_CODE_ALPHABET.length];
  return code;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "P2002"
  );
}

/** The target a link effectively sends visitors to (own, else program default). */
export function effectiveLinkTarget(
  link: Pick<ReferralLink, "targetUrl">,
  program: { defaultTargetUrl: string | null },
): string | null {
  return link.targetUrl ?? program.defaultTargetUrl;
}

export async function createReferralLink(
  db: PrismaClient,
  actor: Actor,
  affiliateId: string,
  input: { channel?: string; targetUrl?: string },
): Promise<ReferralLink> {
  if (actor.type === "AFFILIATE" && actor.id !== affiliateId) {
    throw new Error("forbidden");
  }
  const affiliate = await db.affiliate.findUnique({
    where: { id: affiliateId },
    include: { program: { select: { defaultTargetUrl: true } } },
  });
  if (!affiliate) throw new Error("affiliate_not_found");
  if (affiliate.status !== "ACTIVE") throw new Error("affiliate_not_active");
  const targetUrl = input.targetUrl?.trim() ? input.targetUrl.trim() : null;
  if (targetUrl !== null && !isValidTargetUrl(targetUrl)) {
    throw new Error("target_invalid");
  }
  // A link with nowhere to send anyone is useless: refuse to create it
  // when neither the link nor the program default provides a target.
  if (!effectiveLinkTarget({ targetUrl }, affiliate.program)) {
    throw new Error("target_required");
  }
  const channel = input.channel?.trim() ? input.channel.trim() : null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const link = await db.referralLink.create({
        data: {
          programId: affiliate.programId,
          affiliateId,
          code: generateLinkCode(),
          targetUrl,
          channel,
        },
      });
      await writeAudit(db, {
        programId: affiliate.programId,
        actorType: actor.type,
        actorId: actor.id,
        action: "link.create",
        targetType: "ReferralLink",
        targetId: link.id,
        metadata: { code: link.code, channel },
      });
      return link;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      lastError = error; // code collision: mint another code and retry
    }
  }
  throw lastError ?? new Error("code_generation_failed");
}

export async function setReferralLinkActive(
  db: PrismaClient,
  actor: Actor,
  linkId: string,
  isActive: boolean,
): Promise<ReferralLink> {
  const link = await db.referralLink.findUnique({ where: { id: linkId } });
  if (!link) throw new Error("link_not_found");
  if (actor.type === "AFFILIATE" && actor.id !== link.affiliateId) {
    throw new Error("forbidden");
  }
  const updated = await db.referralLink.update({
    where: { id: linkId },
    data: { isActive },
  });
  await writeAudit(db, {
    programId: link.programId,
    actorType: actor.type,
    actorId: actor.id,
    action: isActive ? "link.enable" : "link.disable",
    targetType: "ReferralLink",
    targetId: link.id,
    metadata: { code: link.code },
  });
  return updated;
}

const DISCOUNT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

export async function createDiscountCode(
  db: PrismaClient,
  actorId: string,
  affiliateId: string,
  input: { code: string; discountBps: number },
): Promise<DiscountCode> {
  const affiliate = await db.affiliate.findUnique({ where: { id: affiliateId } });
  if (!affiliate) throw new Error("affiliate_not_found");
  const code = normalizeDiscountCode(input.code);
  if (!DISCOUNT_CODE_PATTERN.test(code)) throw new Error("code_invalid");
  if (
    !Number.isInteger(input.discountBps) ||
    input.discountBps < 0 ||
    input.discountBps > 10000
  ) {
    throw new Error("discount_invalid");
  }
  let created: DiscountCode;
  try {
    created = await db.discountCode.create({
      data: {
        programId: affiliate.programId,
        affiliateId,
        code,
        discountBps: input.discountBps,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("code_taken");
    throw error;
  }
  await writeAudit(db, {
    programId: affiliate.programId,
    actorType: "ADMIN",
    actorId,
    action: "discount_code.create",
    targetType: "DiscountCode",
    targetId: created.id,
    metadata: { code, discountBps: input.discountBps },
  });
  return created;
}

export async function setDiscountCodeActive(
  db: PrismaClient,
  actorId: string,
  discountCodeId: string,
  isActive: boolean,
): Promise<DiscountCode> {
  const existing = await db.discountCode.findUnique({ where: { id: discountCodeId } });
  if (!existing) throw new Error("discount_code_not_found");
  const updated = await db.discountCode.update({
    where: { id: discountCodeId },
    data: { isActive },
  });
  await writeAudit(db, {
    programId: existing.programId,
    actorType: "ADMIN",
    actorId,
    action: isActive ? "discount_code.enable" : "discount_code.disable",
    targetType: "DiscountCode",
    targetId: existing.id,
    metadata: { code: existing.code },
  });
  return updated;
}

/** Read a payout-details JSON blob back into the single "account" text. */
export function payoutDetailsText(affiliate: Affiliate): string {
  const details = affiliate.payoutDetails;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const account = (details as Record<string, unknown>).account;
    if (typeof account === "string") return account;
  }
  return "";
}

/** Save an affiliate's transactional-email opt-ins (M5). */
export async function updateAffiliateNotificationPrefs(
  db: PrismaClient,
  actor: { type: "ADMIN" | "AFFILIATE"; id: string },
  affiliateId: string,
  prefs: { commission: boolean; payout: boolean },
) {
  const affiliate = await db.affiliate.update({
    where: { id: affiliateId },
    data: { notificationPrefs: prefs },
  });
  await writeAudit(db, {
    programId: affiliate.programId,
    actorType: actor.type,
    actorId: actor.id,
    action: "affiliate.notification_prefs_update",
    targetType: "Affiliate",
    targetId: affiliate.id,
    metadata: { ...prefs },
  });
  return affiliate;
}
