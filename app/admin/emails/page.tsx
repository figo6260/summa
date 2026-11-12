import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getSingleProgram } from "@/lib/services";
import { pageMessages } from "@/lib/page-i18n";
import type { Messages } from "@/lib/i18n";
import AdminNav from "../admin-nav";

function typeLabel(m: Messages, type: string): string {
  if (type === "invite") return m.emails.typeInvite;
  if (type === "commission_available") return m.emails.typeCommissionAvailable;
  if (type === "commission_rejected") return m.emails.typeCommissionRejected;
  if (type === "payout_paid") return m.emails.typePayoutPaid;
  return type;
}

function statusLabel(m: Messages, status: string): string {
  if (status === "sent") return m.emails.statusSent;
  if (status === "failed") return m.emails.statusFailed;
  return m.emails.statusLogged;
}

export default async function AdminEmailsPage() {
  await requireAdmin();
  const m = await pageMessages();
  const program = await getSingleProgram(prisma);
  const logs = program
    ? await prisma.emailLog.findMany({
        where: { programId: program.id },
        orderBy: { createdAt: "desc" },
        take: 200,
      })
    : [];

  return (
    <main className="panel wide">
      <AdminNav />
      <h1>{m.emails.title}</h1>
      <p>{m.emails.intro}</p>
      {logs.length === 0 ? (
        <p>{m.emails.empty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{m.emails.type}</th>
              <th>{m.emails.to}</th>
              <th>{m.emails.subject}</th>
              <th>{m.emails.status}</th>
              <th>{m.emails.createdAt}</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td>{typeLabel(m, log.type)}</td>
                <td>{log.toEmail}</td>
                <td>{log.subject}</td>
                <td>{statusLabel(m, log.status)}</td>
                <td>{log.createdAt.toISOString().slice(0, 16)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
