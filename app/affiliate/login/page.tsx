import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { authenticateAffiliate, getSingleProgram } from "@/lib/services";
import { createSession } from "@/lib/auth";
import { pageMessages } from "@/lib/page-i18n";

async function loginAction(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const program = await getSingleProgram(prisma);
  const affiliate = program
    ? await authenticateAffiliate(prisma, program.id, email, password)
    : null;
  if (!affiliate) redirect("/affiliate/login?error=invalid");
  await createSession({ sub: affiliate.id, role: "affiliate", email: affiliate.email });
  redirect("/affiliate/profile");
}

export default async function AffiliateLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; activated?: string }>;
}) {
  const m = await pageMessages();
  const { error, activated } = await searchParams;
  return (
    <main className="panel">
      <h1>{m.auth.affiliateTitle}</h1>
      <p>{m.auth.affiliateOnly}</p>
      {activated ? <p className="ok">{m.activate.done}</p> : null}
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
    </main>
  );
}
