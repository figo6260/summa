// Generate settlement payouts for every affiliate with a payable
// balance (M5). Run on the program's payout day (e.g. the 10th):
//   npm run payouts:generate
// Settlement sweeps ALL currently AVAILABLE commissions per affiliate
// (no calendar slicing); the payout's period is the generation month.
// The lib layer is compiled to plain JS first, mirroring
// scripts/release-commissions.mjs.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const outDir = join(root, "node_modules", ".cache", "summa-lib");
mkdirSync(outDir, { recursive: true });
execFileSync(
  join(root, "node_modules", ".bin", "tsc"),
  [
    "src/lib/payouts.ts",
    "src/lib/balance.ts",
    "src/lib/audit.ts",
    "src/lib/prisma.ts",
    "--outDir",
    outDir,
    "--module",
    "commonjs",
    "--target",
    "es2022",
    "--esModuleInterop",
    "--skipLibCheck",
  ],
  { stdio: "inherit" },
);

const require = createRequire(join(outDir, "payouts.js"));
const { generatePayouts } = require(join(outDir, "payouts.js"));
const { prisma } = require(join(outDir, "prisma.js"));

try {
  const result = await generatePayouts(prisma, new Date(), {
    type: "SYSTEM",
    id: null,
  });
  console.log(
    `Generated ${result.count} payout(s): ${result.payouts
      .map((p) => `${p.id} total=${p.totalCents} ${p.currency}`)
      .join(", ") || "none"}`,
  );
} finally {
  await prisma.$disconnect();
}
