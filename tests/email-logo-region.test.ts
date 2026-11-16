/**
 * A store email's logo, if it is drawn, is priced at the dearest region a reader can open it from (MR, Claude 1's
 * focal re-review of #3030 at 3986e8048, comment 6709534250, MEDIUM money; coordinator message C1-20261107-1306).
 *
 * An email is opened wherever its reader is, and the store cannot choose that region, so every fetch of a picture it
 * draws from this site is priced at the top of Vercel's regional ranges ("Regional pricing" and "Manage CDN usage",
 * vercel.com/docs/pricing/regional-pricing and vercel.com/docs/manage-cdn-usage, both last updated 14 September 2026,
 * as read in that review): CDN Requests US$2.00 to US$3.20 a million, Fast Data Transfer US$0.15 to US$0.35 a GB,
 * Fast Origin Transfer US$0.06 to US$0.43 a GB on a miss. The figures are typed here, not imported, so this check
 * cannot agree with the registry by sharing its number.
 *
 * Then a refunded first year of the Store plan, with that logo, must stay under the owner's US$65 ceiling
 * (tests/plan-margin.test.ts). The ceiling is never raised to pass: if the logo cannot fit, it is not drawn.
 */
import { render } from "@/lib/mail";
import * as emailThemeModule from "@/lib/email-theme";
import * as registry from "./plan-cost-registry";
import { COST_LINES } from "./plan-cost-registry";
import { providerFeeUsd, worstCost, GB, STORAGE_PER_GB } from "./plan-cost-model";
import { MAX_PHOTO_BYTES } from "@/lib/photo-limits";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { PRICES_WITHOUT_COMMISSION, monthlyEmails } from "@/lib/plan";
import { paidStorageBytes } from "@/lib/storage-rules";
import { CLOSING_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

/** The top of each regional range (Vercel, pages dated 14 September 2026). */
const DEAREST_CDN_REQUEST_USD = 3.2 / 1_000_000;
const DEAREST_FAST_DATA_PER_BYTE = 0.35 / 1e9;
const DEAREST_ORIGIN_PER_BYTE = 0.43 / 1e9;

const PHOTO = "0123456789abcdef0123456789abcdef";
const store = {
  handle: "bakery",
  name: "Oven Notes",
  language: "en",
  photoId: PHOTO,
  look: { theme: "bold", accent: "#5a36ee", badge: true, sold: false, font: "modern", backdrop: "plain" },
  mail: { fromName: "Oven Notes", address: "1 Main St, Springfield" },
} as unknown as Store;

const html = render(store, "New loaf", "Hello.\n\n[Read](https://example.com/guide)", "tok").html;
/** The store photo's address is the only picture of this site an email header could draw. */
const drawsPhoto = html.includes("/api/photo/");
/** One fetch the CDN did not keep, at the most the store photo may weigh, at the dearest region. */
const dearestFetch = DEAREST_CDN_REQUEST_USD + MAX_PHOTO_BYTES * (DEAREST_FAST_DATA_PER_BYTE + DEAREST_ORIGIN_PER_BYTE);
const exportedReads = (emailThemeModule as Record<string, unknown>).EMAIL_LOGO_READS;
const reads = typeof exportedReads === "number" && exportedReads >= 1 ? exportedReads : 4;
const line = COST_LINES.find((l) => l.id === "email-logo");

part(`A store email ${drawsPhoto ? "draws" : "does not draw"} the store photo as its logo`);
if (drawsPhoto) {
  const perRead = (registry as Record<string, unknown>).EMAIL_LOGO_READ;
  is("one fetch is priced at least at the dearest region's CDN request, Fast Data Transfer and Fast Origin Transfer",
    typeof perRead === "number" && perRead >= dearestFetch, true);
}

/** What the plan's email logos must be priced at, at least: nothing when no email draws one. */
const floorFor = (tier: "creator" | "pro" | "scale") =>
  drawsPhoto ? (monthlyEmails(tier) + STORE_ALLOWANCES[tier].email) * reads * dearestFetch : 0;

for (const tier of ["creator", "pro", "scale"] as const) {
  const priced = line ? line.monthlyUsd(tier) : 0;
  const floor = floorFor(tier);
  is(`${tier}: the logo line covers every email's logo at every read at the dearest region (line ${priced.toFixed(3)}, floor ${floor.toFixed(3)})`,
    priced >= floor, true);
}

part("A refunded first year stays under the owner's US$65 with the logo at the dearest region");
{
  const tier = "creator" as const;
  const kept = (paidStorageBytes(tier) / GB) * STORAGE_PER_GB * ((CLOSING_DAYS + WARN_WEEK_DAYS) / 30);
  const year = worstCost(tier) + providerFeeUsd(PRICES_WITHOUT_COMMISSION[tier].year) + kept;
  const extra = Math.max(0, floorFor(tier) - (line ? line.monthlyUsd(tier) : 0));
  is(`a refunded Store first year, repriced at the dearest region, is under US$65 (now ${year.toFixed(4)}, repriced ${(year + extra).toFixed(4)})`,
    year + extra < 65, true);
}

done();
