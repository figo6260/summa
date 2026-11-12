import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { payoutListCsv } from "@/lib/csv";
import { getSingleProgram } from "@/lib/services";

/** Admin-only CSV export of every payout in the program (M5). */
export async function GET() {
  await requireAdmin();
  const program = await getSingleProgram(prisma);
  const payouts = program
    ? await prisma.payout.findMany({
        where: { programId: program.id },
        orderBy: { createdAt: "desc" },
        include: { affiliate: { select: { email: true } } },
      })
    : [];
  const csv = payoutListCsv(
    payouts.map((payout) => ({
      payoutId: payout.id,
      affiliateEmail: payout.affiliate.email,
      periodStart: payout.periodStart,
      periodEnd: payout.periodEnd,
      grossCents: payout.grossCents,
      debtOffsetCents: payout.debtOffsetCents,
      totalCents: payout.totalCents,
      currency: payout.currency,
      status: payout.status,
      method: payout.method ?? "",
      externalRef: payout.externalRef,
      paidAt: payout.paidAt,
    })),
  );
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="payouts.csv"',
    },
  });
}
