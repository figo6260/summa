import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { adminExists, setupAdmin } from "@/lib/services";
import { createSession } from "@/lib/auth";
import { pageMessages } from "@/lib/page-i18n";

// Never prerender: whether setup is open depends on live database state
// (a build-time prerender once froze the "admin already exists" redirect
// into the static cache even after the database was emptied again).
export const dynamic = "force-dynamic";

async function setupAction(formData: FormData) {
  "use server";
  const name = String(formData.get("name") ?? "");
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  if (name.trim() === "" || email.trim() === "" || password.length < 8) {
    redirect("/setup?error=invalid");
  }
  if (await adminExists(prisma)) redirect("/");
  const admin = await setupAdmin(prisma, { name, email, password });
  await createSession({ sub: admin.id, role: "admin", email: admin.email });
  redirect("/admin/program");
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await adminExists(prisma)) redirect("/");
  const m = await pageMessages();
  const { error } = await searchParams;
  return (
    <main className="panel">
      <h1>{m.setup.title}</h1>
      <p>{m.setup.intro}</p>
      {error ? <p className="error">{m.activate.passwordHint}</p> : null}
      <form action={setupAction} className="form">
        <label>
          {m.common.name}
          <input name="name" required autoComplete="name" />
        </label>
        <label>
          {m.common.email}
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          {m.common.password}
          <input name="password" type="password" required minLength={8} autoComplete="new-password" />
          <small>{m.setup.passwordHint}</small>
        </label>
        <button type="submit">{m.setup.submit}</button>
      </form>
    </main>
  );
}
