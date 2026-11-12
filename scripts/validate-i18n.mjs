#!/usr/bin/env node
/** Summa i18n validation: same keys, placeholders, empties, English residue,
 *  script sanity, glossary term consistency. Run from repo root:
 *    node scripts/validate-i18n.mjs [messagesDir] [glossaryPath]
 *  Exits non-zero if any hard check fails. */
import { readFileSync } from "node:fs";

const dir = process.argv[2] || "public/messages";
const glossaryPath = process.argv[3] || "docs/i18n-glossary.md";
const LOCALES = ["zh-TW", "ja", "ko", "es", "pt", "fr"];

function flat(o, p = "", acc = {}) {
  for (const k of Object.keys(o)) {
    const key = p ? `${p}.${k}` : k;
    if (o[k] && typeof o[k] === "object") flat(o[k], key, acc);
    else acc[key] = o[k];
  }
  return acc;
}
const load = (l) => flat(JSON.parse(readFileSync(`${dir}/${l}.json`, "utf8")));
const en = load("en");
const enKeys = Object.keys(en);
const ph = (s) => (String(s).match(/\{[^}]+\}/g) || []).sort();

// ---- glossary parse (tables in sections 一 and 二 share the layout) ----
const gtext = readFileSync(glossaryPath, "utf8");
const LOCALE_COL = { "zh-TW": 2, ja: 3, ko: 4, es: 5, pt: 6, fr: 7 };
const terms = []; // {en, byLocale: {locale: rendering}}
for (const line of gtext.split("\n")) {
  if (!line.startsWith("|") || line.includes("---") || line.includes("术语")) continue;
  const cells = line.split("|").slice(1, -1).map((c) => c.trim());
  if (cells.length < 8) continue;
  const byLocale = {};
  for (const [loc, idx] of Object.entries(LOCALE_COL)) byLocale[loc] = cells[idx];
  terms.push({ en: cells[0], byLocale });
}

const PROPER = new Set(["Summa", "PayPal", "Wise", "Stripe", "Paddle", "Pro", "API", "CSV", "URL", "IP", "Slug", "USD", "EUR"]);
// Identical-to-English strings that ARE the correct word in the target language
// (same orthography). Adjudicated by hand during M5b; full sentences never qualify.
const COGNATE_ALLOW = {
  es: new Set(["affiliateCommissions.groupTotal", "audit.actor", "payoutMethods.MANUAL"]), // Total / Actor / Manual
  pt: new Set(["affiliateCommissions.groupTotal", "clicks.link", "common.status", "payoutMethods.MANUAL", "payouts.status", "emails.status"]), // Total / Link / Status / Manual
  fr: new Set(["adminNav.commissions", "adminNav.conversions", "affiliateCommissions.commission", "affiliateCommissions.date", "affiliateCommissions.groupTotal", "audit.action", "commissions.title", "common.actions", "common.page", "conversions.commission", "conversions.source", "conversions.title", "links.code", "adminDashboard.conversions", "affiliateDashboard.conversions", "emails.type"]),
};
function residueAutoOk(enVal, loc, key) {
  if (COGNATE_ALLOW[loc]?.has(key)) return true;
  const stripped = String(enVal).replace(/\{[^}]+\}/g, " ").trim();
  if (!/[A-Za-z]/.test(stripped)) return true; // symbols/numbers/placeholders only
  const tokens = stripped.replace(/[^\p{L}\s-]/gu, " ").split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => PROPER.has(t));
}

let fail = 0;
const report = {};
for (const loc of LOCALES) {
  const d = load(loc);
  const keys = Object.keys(d);
  const missing = enKeys.filter((k) => !(k in d));
  const extra = keys.filter((k) => !(k in en));
  const phBad = enKeys.filter((k) => k in d && JSON.stringify(ph(d[k])) !== JSON.stringify(ph(en[k])));
  const empty = keys.filter((k) => typeof d[k] !== "string" || d[k].trim() === "");
  const identical = enKeys.filter((k) => d[k] === en[k]);
  const residueBad = identical.filter((k) => !residueAutoOk(en[k], loc, k));
  const residueOk = identical.filter((k) => residueAutoOk(en[k], loc, k));
  // script sanity (ja accepts kana OR kanji — kanji-only labels are normal Japanese)
  const scriptRe =
    loc === "zh-TW" ? /[\u4e00-\u9fff]/ : loc === "ja" ? /[\u3040-\u30ff\u4e00-\u9fff]/ : loc === "ko" ? /[\uac00-\ud7a3]/ : null;
  let noScript = [];
  if (scriptRe) noScript = enKeys.filter((k) => !scriptRe.test(d[k]) && !residueAutoOk(en[k], loc, k));
  report[loc] = { total: keys.length, missing: missing.length, extra: extra.length, phBad, empty: empty.length, identicalCount: identical.length, residueBad, residueOkCount: residueOk.length, noScript };
  if (missing.length || extra.length || phBad.length || empty.length || residueBad.length || noScript.length) fail = 1;
  console.log(
    `[${loc}] keys=${keys.length} missing=${missing.length} extra=${extra.length} placeholderBad=${phBad.length} empty=${empty.length} identical=${identical.length} (whitelisted=${residueOk.length}, BAD=${residueBad.length}) noExpectedScript=${noScript.length}`
  );
  if (phBad.length) console.log(`  placeholder bad: ${phBad.join(", ")}`);
  if (residueBad.length) console.log(`  RESIDUE BAD: ${residueBad.map((k) => `${k}=${JSON.stringify(d[k])}`).join(" | ")}`);
  if (noScript.length) console.log(`  NO-SCRIPT: ${noScript.join(", ")}`);
}

// ---- glossary consistency spot-check (advisory) ----
// Matching is case/diacritic-insensitive and accepts plural suffixes, because
// e.g. Spanish "códigos de descuento" is a correct use of the locked term.
const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
console.log("\n[glossary consistency] (en keys containing term -> target contains locked rendering; advisory)");
for (const loc of LOCALES) {
  const d = load(loc);
  const weak = [];
  for (const t of terms) {
    const parts = t.en.split(" / ");
    const targets = t.byLocale[loc].split(" / ");
    parts.forEach((part, i) => {
      const target = (targets[i] || targets[0] || "").trim();
      if (!target) return;
      const termRe = new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const hitKeys = enKeys.filter((k) => termRe.test(en[k]));
      if (!hitKeys.length) return;
      const nt = norm(target);
      const variants = [nt, nt + "s", nt + "es"];
      const okCount = hitKeys.filter((k) => variants.some((v) => norm(d[k]).includes(v))).length;
      if (okCount < Math.ceil(hitKeys.length / 2)) weak.push(`${part}: ${okCount}/${hitKeys.length} -> "${target}"`);
    });
  }
  console.log(`[${loc}] weak terms: ${weak.length ? weak.join(" ; ") : "none"}`);
}
console.log(fail ? "\nRESULT: FAIL" : "\nRESULT: PASS");
process.exit(fail);
