/**
 * Release matured commissions (M4) — the cron/systemd entry point.
 *
 *   npm run commissions:release
 *
 * Flips every HOLDING commission whose holdUntil has passed (and which
 * is not pending review) to AVAILABLE, writing one SYSTEM audit entry
 * per commission. Deliberately a standalone script, not a web-process
 * timer: hosting environments schedule it however they like.
 *
 * Exit code 0 on success (including "nothing to release").
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// Load ./.env when present (source checkout). In the Docker image the
// configuration arrives as real environment variables and there is no
// .env file — that is fine, process.env already carries it.
const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_]+)=="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

mkdirSync(join(process.cwd(), "node_modules", ".cache"), { recursive: true });
const outDir = mkdtempSync(join(process.cwd(), "node_modules", ".cache", "summa-release-"));
try {
  execSync(
    [
      "node_modules/.bin/tsc",
      "src/lib/commissions.ts",
      "--outDir", outDir,
      "--module commonjs",
      "--target es2022",
      "--moduleResolution node",
      "--esModuleInterop",
      "--strict",
      "--skipLibCheck",
    ].join(" "),
    { stdio: "inherit" },
  );
  const require = createRequire(import.meta.url);
  const { releaseMaturedCommissions } = require(join(outDir, "commissions.js"));
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  try {
    const result = await releaseMaturedCommissions(db, new Date(), {
      trigger: "schedule",
    });
    console.log(`commissions:release — released ${result.count} commission(s)`);
  } finally {
    await db.$disconnect();
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
