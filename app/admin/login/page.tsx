import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { authenticateAdmin } from "@/lib/services";
import { createSession } from "@/lib/auth";
import { pageMessages } from "@/lib/page-i18n";

async function loginAction(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const admin = await authenticateAdmin(prisma, email, password);
  if (!admin) redirect("/admin/login?error=invalid");
  await createSession({ sub: admin.id, role: "admin", email: admin.email });
  redirect("/admin/program");
}

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const m = await pageMessages();
  const { error } = await searchParams;
  return (
    <main className="authwrap">
      <div className="authcard">
        <div className="authbrand">
          <span className="logo-mark" aria-hidden="true">
            S
          </span>
          <span className="authbrand-name">{m.home.brand}</span>
        </div>
      <h1>{m.auth.adminTitle}</h1>
      <p>{m.auth.adminOnly}</p>
      {error ? <p className="error">{m.auth.invalid}</p> : null}
      <form action={loginAction} className="form">
        <label>
          {m.common.email}
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          {m.common.password}
          <input name="password" type="password" required autoComplete="current-password" />
        </label>
        <button type="submit">{m.auth.submit}</button>
      </form>
      </div>
    </main>
  );
}
