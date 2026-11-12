import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getSingleProgram } from "@/lib/services";
import { pageMessages } from "@/lib/page-i18n";
import AdminNav from "../admin-nav";

export default async function AuditPage() {
  await requireAdmin();
  const m = await pageMessages();
  const program = await getSingleProgram(prisma);
  const logs = await prisma.auditLog.findMany({
    where: program ? { programId: program.id } : {},
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  // Also surface instance-level entries (e.g. admin setup) when a program exists.
  const extra = program
    ? await prisma.auditLog.findMany({
        where: { programId: null },
        orderBy: { createdAt: "desc" },
        take: 20,
      })
    : [];
  const all = [...logs, ...extra].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return (
    <main className="panel wide">
      <AdminNav />
      <h1>{m.audit.title}</h1>
      <p>{m.audit.intro}</p>
      {all.length === 0 ? (
        <p>{m.audit.empty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{m.audit.time}</th>
              <th>{m.audit.actor}</th>
              <th>{m.audit.action}</th>
              <th>{m.audit.target}</th>
            </tr>
          </thead>
          <tbody>
            {all.map((log) => (
              <tr key={log.id}>
                <td>{log.createdAt.toISOString().replace("T", " ").slice(0, 19)}</td>
                <td>
                  {log.actorType}
                  {log.actorId ? ` · ${log.actorId.slice(0, 8)}` : ""}
                </td>
                <td>{log.action}</td>
                <td>
                  {log.targetType ?? m.common.none}
                  {log.targetId ? ` · ${log.targetId.slice(0, 8)}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
