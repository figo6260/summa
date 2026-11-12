import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { activateAffiliate, findAffiliateByActivationToken } from "@/lib/services";
import { pageMessages } from "@/lib/page-i18n";

async function activateAction(formData: FormData) {
  "use server";
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  if (password.length < 8) {
    redirect(`/activate?token=${encodeURIComponent(token)}&error=short`);
  }
  try {
    await activateAffiliate(prisma, token, password);
  } catch {
    redirect("/activate?error=invalid");
  }
  redirect("/affiliate/login?activated=1");
}

export default async function ActivatePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const m = await pageMessages();
  const { token, error } = await searchParams;
  const affiliate = token
    ? await findAffiliateByActivationToken(prisma, token)
    : null;
  return (
    <main className="panel">
      <h1>{m.activate.title}</h1>
      {error === "invalid" || (!affiliate && error !== "short") ? (
        <p className="error">{m.activate.invalid}</p>
      ) : null}
      {affiliate ? (
        <>
          <p>{m.activate.intro}</p>
          <p>
            {affiliate.name} · {affiliate.email}
          </p>
          {error === "short" ? <p className="error">{m.activate.passwordHint}</p> : null}
          <form action={activateAction} className="form">
            <input type="hidden" name="token" value={token} />
            <label>
              {m.activate.newPassword}
              <input name="password" type="password" required minLength={8} autoComplete="new-password" />
              <small>{m.activate.passwordHint}</small>
            </label>
            <button type="submit">{m.activate.submit}</button>
          </form>
        </>
      ) : null}
    </main>
  );
}
