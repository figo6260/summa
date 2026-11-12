import type { EmailLog, PrismaClient } from "@prisma/client";
import nodemailer from "nodemailer";
import { writeAudit } from "./audit";
import {
  commissionAvailableEmail,
  commissionRejectedEmail,
  inviteEmail,
  payoutPaidEmail,
} from "./emails";

/**
 * Transactional mail base (M5).
 *
 * Every send is recorded in EmailLog first-class: the log row is the
 * deliverable in `log` transport mode (the default — self-hosters read
 * /admin/emails, tests assert on rows) and the receipt in `smtp` mode.
 * sendMail NEVER throws: a mail failure must not roll back the business
 * operation that triggered it, so failures land as status="failed"
 * rows plus an `email.failed` audit entry.
 *
 * Transports (env MAIL_TRANSPORT):
 *  - "log"  (default): record only, status "logged".
 *  - "smtp": nodemailer with SMTP_HOST / SMTP_PORT / SMTP_USER /
 *    SMTP_PASS / MAIL_FROM; status "sent" or "failed".
 */

export type EmailType =
  | "invite"
  | "commission_available"
  | "commission_rejected"
  | "payout_paid";

export interface NotificationPrefs {
  commission: boolean;
  payout: boolean;
}

/**
 * Parse an affiliate's notificationPrefs JSON ({"commission":bool,
 * "payout":bool}); missing prefs mean everything is on.
 */
export function notificationPrefsOf(affiliate: {
  notificationPrefs: unknown;
}): NotificationPrefs {
  const raw = affiliate.notificationPrefs;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      commission: obj.commission !== false,
      payout: obj.payout !== false,
    };
  }
  return { commission: true, payout: true };
}

export interface SendMailInput {
  programId?: string | null;
  toEmail: string;
  type: EmailType;
  subject: string;
  body: string;
  relatedType?: string;
  relatedId?: string;
}

export async function sendMail(
  db: PrismaClient,
  input: SendMailInput,
): Promise<EmailLog | null> {
  let status: "logged" | "sent" | "failed" = "logged";
  let error: string | null = null;

  if ((process.env.MAIL_TRANSPORT ?? "log") === "smtp") {
    try {
      const port = Number(process.env.SMTP_PORT ?? 587);
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: port === 465,
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
      });
      await transporter.sendMail({
        from: process.env.MAIL_FROM ?? "no-reply@summa.local",
        to: input.toEmail,
        subject: input.subject,
        text: input.body,
      });
      status = "sent";
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
    }
  }

  try {
    const row = await db.emailLog.create({
      data: {
        programId: input.programId ?? null,
        toEmail: input.toEmail,
        type: input.type,
        subject: input.subject,
        body: input.body,
        status,
        relatedType: input.relatedType ?? null,
        relatedId: input.relatedId ?? null,
      },
    });
    if (status === "failed") {
      try {
        await writeAudit(db, {
          programId: input.programId ?? null,
          actorType: "SYSTEM",
          actorId: null,
          action: "email.failed",
          targetType: "EmailLog",
          targetId: row.id,
          metadata: { toEmail: input.toEmail, type: input.type, error },
        });
      } catch {
        // Auditing the failure must not take the caller down either.
      }
    }
    return row;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// High-level senders (templates + preference gates live here, once)
// ---------------------------------------------------------------------------

interface AffiliateMailTarget {
  id: string;
  programId: string;
  email: string;
  name: string;
  notificationPrefs: unknown;
}

/** Invite / activation-link email. Always sent (it carries the only credential). */
export async function sendInviteEmail(
  db: PrismaClient,
  args: {
    affiliate: AffiliateMailTarget;
    programName: string;
    activationUrl: string;
    expiresAt: Date;
  },
): Promise<EmailLog | null> {
  const rendered = inviteEmail("en", {
    programName: args.programName,
    affiliateName: args.affiliate.name,
    activationUrl: args.activationUrl,
    expiresAt: args.expiresAt.toISOString().slice(0, 10),
  });
  return sendMail(db, {
    programId: args.affiliate.programId,
    toEmail: args.affiliate.email,
    type: "invite",
    subject: rendered.subject,
    body: rendered.body,
    relatedType: "Affiliate",
    relatedId: args.affiliate.id,
  });
}

/**
 * Aggregated availability notice for one release run and one affiliate.
 * Returns null without logging anything when the affiliate opted out.
 */
export async function sendCommissionAvailableEmail(
  db: PrismaClient,
  args: {
    affiliate: AffiliateMailTarget;
    programName: string;
    count: number;
    amountCents: number;
    currency: string;
  },
): Promise<EmailLog | null> {
  if (!notificationPrefsOf(args.affiliate).commission) return null;
  const rendered = commissionAvailableEmail("en", {
    programName: args.programName,
    affiliateName: args.affiliate.name,
    count: args.count,
    amountCents: args.amountCents,
    currency: args.currency,
  });
  return sendMail(db, {
    programId: args.affiliate.programId,
    toEmail: args.affiliate.email,
    type: "commission_available",
    subject: rendered.subject,
    body: rendered.body,
    relatedType: "Affiliate",
    relatedId: args.affiliate.id,
  });
}

/** Rejection notice (includes the admin's reason). Preference-gated. */
export async function sendCommissionRejectedEmail(
  db: PrismaClient,
  args: {
    affiliate: AffiliateMailTarget;
    programName: string;
    commissionId: string;
    orderId: string;
    amountCents: number;
    currency: string;
    reason: string;
  },
): Promise<EmailLog | null> {
  if (!notificationPrefsOf(args.affiliate).commission) return null;
  const rendered = commissionRejectedEmail("en", {
    programName: args.programName,
    affiliateName: args.affiliate.name,
    orderId: args.orderId,
    amountCents: args.amountCents,
    currency: args.currency,
    reason: args.reason,
  });
  return sendMail(db, {
    programId: args.affiliate.programId,
    toEmail: args.affiliate.email,
    type: "commission_rejected",
    subject: rendered.subject,
    body: rendered.body,
    relatedType: "Commission",
    relatedId: args.commissionId,
  });
}

/** "Your payout was paid" notice with the net amount and transfer ref. */
export async function sendPayoutPaidEmail(
  db: PrismaClient,
  args: {
    affiliate: AffiliateMailTarget;
    programName: string;
    payoutId: string;
    totalCents: number;
    currency: string;
    method: string;
    externalRef: string;
  },
): Promise<EmailLog | null> {
  if (!notificationPrefsOf(args.affiliate).payout) return null;
  const rendered = payoutPaidEmail("en", {
    programName: args.programName,
    affiliateName: args.affiliate.name,
    totalCents: args.totalCents,
    currency: args.currency,
    method: args.method,
    externalRef: args.externalRef,
  });
  return sendMail(db, {
    programId: args.affiliate.programId,
    toEmail: args.affiliate.email,
    type: "payout_paid",
    subject: rendered.subject,
    body: rendered.body,
    relatedType: "Payout",
    relatedId: args.payoutId,
  });
}
