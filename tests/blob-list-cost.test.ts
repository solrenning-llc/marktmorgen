/**
 * Vercel Blob list calls of the storage measurement (MR audit item 5, Claude 5): filesHeld lists the store's
 * prefix up to 20 pages of 1000 (lib/file-store.ts); a list goes through the same retrying request as a put and is an
 * Advanced Operation ($5 a million, vercel.com/docs/vercel-blob/usage-and-pricing, read 6 November 2026). The paying
 * plans reach it through one door only, a vault open (app/api/store/vault/route.ts, openReservedVault, one measure per
 * open, each open first spending one of PAID_UPLOAD_OPENS); the product-file and stream doors are closed
 * (reserveStoreUpload answers false for any backend but r2). Unknown is never zero.
 */
import { readFileSync } from "node:fs";
import { COST_LINES, BLOB_ADVANCED_OP, BLOB_PUT_TRIES } from "./plan-cost-registry";
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
is("Creator is US$ 0.055", Math.abs((line?.monthlyUsd("creator") ?? 0) - 0.055) < 1e-12, true);

part("Sources and the callers left out are said");
const sources = (line?.sources ?? []).map((source) => source.file);
for (const file of ["lib/file-store.ts", "lib/storage-quota.ts", "lib/vault-storage.ts", "app/api/store/vault/route.ts", "lib/upload-budget-policy.ts", "lib/upload-budget.ts"]) is(`source ${file}`, sources.includes(file), true);
const basis = line?.basis ?? "";
is("official page and date", /vercel\.com\/docs\/vercel-blob\/usage-and-pricing/.test(basis) && /6 November 2026/.test(basis), true);
is("closed doors, ended stores and stamped copies named", /closed/.test(basis) && /ended/.test(basis) && /dropStamped/.test(basis), true);
done();
