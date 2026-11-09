/**
 * Vercel Blob list calls of the storage measurement (MR audit item 5, Claude 5): filesHeld lists the store's
 * prefix up to 20 pages of 1000 (lib/file-store.ts); a list goes through the same retrying request as a put and is an
 * Advanced Operation (vercel.com/docs/vercel-blob/usage-and-pricing, read 6 November 2026; US$ 7.00 a million at gru1,
 * the dearest region, while the store's region is unreviewed). The paying plans reach it through one door only, a vault open (app/api/store/vault/route.ts, openReservedVault, one measure per
 * open, each open first spending one of PAID_UPLOAD_OPENS); the product-file and stream doors are closed
 * (reserveStoreUpload answers false for any backend but r2). Unknown is never zero.
 */
import { readFileSync } from "node:fs";
import { COST_LINES, BLOB_ADVANCED_OP, BLOB_SIMPLE_OP, BLOB_PUT_TRIES } from "./plan-cost-registry";
import { PAID_UPLOAD_OPENS } from "@/lib/upload-budget-policy";
import { done, is, part } from "./check";

const line = COST_LINES.find((each) => each.id === "blob-list");
const store = readFileSync("lib/file-store.ts", "utf8");
const pages = Number(/for \(let page = 0; page < (\d+); page \+= 1\)/.exec(store.slice(store.indexOf("export async function filesHeld")))?.[1] ?? Number.NaN);

part("The line exists and reads the code's own page cap");
is("filesHeld lists at most 20 pages", pages, 20);
is("a line of its own", Boolean(line), true);

part("Opens x one measure x pages x every try x an Advanced Operation");
for (const tier of ["creator", "pro", "scale"] as const) {
  const expected = PAID_UPLOAD_OPENS[tier] * 1 * pages * BLOB_PUT_TRIES * BLOB_ADVANCED_OP;
  is(`${tier}: ${PAID_UPLOAD_OPENS[tier]} opens`, Math.abs((line?.monthlyUsd(tier) ?? Number.NaN) - expected) < 1e-12, true);
}
// Rule 23 (Claude 1 on #2848, comment 6708241908): US$ 0.055 before, at the iad1 rate (US$ 5.00 a million); now at
// gru1's US$ 7.00, the dearest region, while the store's region is unreviewed: 0.055 × 7 / 5 = 0.077.
is("Creator is US$ 0.077",Math.abs((line?.monthlyUsd("creator") ?? 0) - 0.077) < 1e-12, true);

part("Sources and the callers left out are said");
const sources = (line?.sources ?? []).map((source) => source.file);
for (const file of ["lib/file-store.ts", "lib/storage-quota.ts", "lib/vault-storage.ts", "app/api/store/vault/route.ts", "lib/upload-budget-policy.ts", "lib/upload-budget.ts"]) is(`source ${file}`, sources.includes(file), true);
const basis = line?.basis ?? "";
// The basis is text, never a URL that is followed or routed: it is checked to cite each page with a plain substring, not a
// regular expression over a URL (CodeQL js/regex/missing-regexp-anchor, 2 high on fedab2fad2).
const cites = (page: string) => basis.includes(page);
is("official page and date", cites("vercel.com/docs/vercel-blob/usage-and-pricing") && basis.includes("6 November 2026"), true);
is("closed doors, ended stores and stamped copies named", /closed/.test(basis) && /ended/.test(basis) && /dropStamped/.test(basis), true);

part("The dearest official regional rate, while the Blob store's region is unreviewed (Claude 1, comment 6708241908)");
// Vercel prices Blob operations by region (vercel.com/docs/pricing/regional-pricing: Advanced US$ 4.50-7.00, Simple
// US$ 0.35-0.56 a million; gru1 is the dearest, 7.00 and 0.56). docs/plan-capacity-provider-review.md says the store's
// region is not reviewed, so the iad1 rate (US$ 5.00 / 0.40) is not a worst case: unknown is never the cheaper rate.
is("an Advanced Operation at the dearest regional rate, US$ 7.00 a million", BLOB_ADVANCED_OP >= 7 / 1e6, true);
is("a Simple Operation at the dearest regional rate, US$ 0.56 a million", BLOB_SIMPLE_OP >= 0.56 / 1e6, true);
for (const tier of ["creator", "pro", "scale"] as const) {
  is(`${tier}: the line at the dearest regional rate`, (line?.monthlyUsd(tier) ?? Number.NaN) >= PAID_UPLOAD_OPENS[tier] * 20 * BLOB_PUT_TRIES * 7 / 1e6 - 1e-12, true);
}
is("the basis names the regional page and the dearest region", cites("vercel.com/docs/pricing/regional-pricing") && basis.includes("gru1") && basis.includes("US$ 7.00"), true);
done();
