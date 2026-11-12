import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getSingleProgram } from "@/lib/services";
import { createApiKey, revokeApiKey } from "@/lib/api-keys";
import { pageMessages } from "@/lib/page-i18n";
import AdminNav from "../admin-nav";

async function createKeyAction(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const program = await getSingleProgram(prisma);
  if (!program) redirect("/admin/program");
  const name = String(formData.get("name") ?? "").trim();
  if (name === "") redirect("/admin/api-keys?error=form");
  const created = await createApiKey(prisma, session.sub, program.id, name);
  redirect(`/admin/api-keys?newkey=${encodeURIComponent(created.plain)}`);
}

async function revokeKeyAction(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (id) await revokeApiKey(prisma, session.sub, id);
  redirect("/admin/api-keys");
}

function fmt(d: Date | null): string {
  return d ? d.toISOString().replace("T", " ").slice(0, 19) : "—";
}

export default async function ApiKeysPage({
  searchParams,
}: {
  searchParams: Promise<{ newkey?: string; error?: string }>;
}) {
  await requireAdmin();
  const m = await pageMessages();
  const { newkey, error } = await searchParams;
  const program = await getSingleProgram(prisma);
  const keys = program
    ? await prisma.apiKey.findMany({
        where: { programId: program.id },
        orderBy: { createdAt: "desc" },
      })
    : [];
  return (
    <main className="panel wide">
      <AdminNav />
      <h1>{m.apiKeys.title}</h1>
      <p>{m.apiKeys.intro}</p>
      {newkey ? (
        <>
          <h2>{m.apiKeys.createdTitle}</h2>
          <p>{m.apiKeys.createdHint}</p>
          <p>
            <code className="activation-link">{newkey}</code>
          </p>
        </>
      ) : null}
      {error ? <p className="error">{m.apiKeys.formError}</p> : null}
      <form action={createKeyAction} className="form">
        <label>
          {m.apiKeys.nameLabel}
          <input name="name" required maxLength={80} />
        </label>
        <button type="submit">{m.apiKeys.create}</button>
      </form>
      <h2>{m.apiKeys.listTitle}</h2>
      {keys.length === 0 ? (
        <p>{m.apiKeys.empty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{m.common.name}</th>
              <th>{m.apiKeys.prefix}</th>
              <th>{m.common.createdAt}</th>
              <th>{m.apiKeys.lastUsed}</th>
              <th>{m.common.status}</th>
              <th>{m.common.actions}</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td>{key.name}</td>
                <td>
                  <code>{key.prefix}…</code>
                </td>
                <td>{fmt(key.createdAt)}</td>
                <td>{key.lastUsedAt ? fmt(key.lastUsedAt) : m.apiKeys.neverUsed}</td>
                <td>
                  {key.revokedAt ? m.apiKeys.statusRevoked : m.apiKeys.statusActive}
                </td>
                <td>
                  {!key.revokedAt ? (
                    <form action={revokeKeyAction}>
                      <input type="hidden" name="id" value={key.id} />
                      <button type="submit" className="linklike">
                        {m.apiKeys.revoke}
                      </button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
