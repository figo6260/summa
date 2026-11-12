import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { effectiveCommissionCents } from "@/lib/balance";
import { payoutDetailCsv } from "@/lib/csv";

/** Admin-only CSV export of one payout's commission lines (M5). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireAdmin();
  const { id } = await params;
  const payout = await prisma.payout.findUnique({ where: { id } });
  if (!payout) notFound();
  const commissions = await prisma.commission.findMany({
    where: { payoutId: id },
    orderBy: { createdAt: "asc" },
    include: {
      conversion: {
        select: { externalOrderId: true, amountCents: true, createdAt: true },
      },
    },
  });
  const csv = payoutDetailCsv(
    commissions.map((commission) => ({
      commissionId: commission.id,
      externalOrderId: commission.conversion.externalOrderId,
      conversionDate: commission.conversion.createdAt,
      orderAmountCents: commission.conversion.amountCents,
      commissionCents: effectiveCommissionCents(commission),
      currency: commission.currency,
    })),
  );
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payout-${id}.csv"`,
    },
  });
}
