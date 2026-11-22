/**
 * 507 [SG3], unit 1: a figure of its own for a store's pictures (MM-SA-08),
 * as a PROPOSAL with its worst-case cost. Nothing is built: no limit, price,
 * flag or gate changes.
 *
 * Checked against the code, no figure typed in the record:
 *   - the most a store can add in a month: each studio request a picture of
 *     at most MAX_IMAGE_BYTES, and each buyer action a review photo of at most
 *     MAX_REVIEW_PHOTO_BYTES (STORE_ALLOWANCES);
 *   - the proposed figure is that month's most, so no plan loses room it uses
 *     in a month (the owner's "no plan loses space");
 *   - kept full every day, at the dearest store a file may be in
 *     (STORAGE_PER_GB), it is the month's ceiling;
 *   - each plan's net with it, by TX's reading, keeps MR's positive cent;
 *   - docs/pictures-figure-proposal.md is exactly what the renderer writes.
 */
import { readFileSync, existsSync } from "node:fs";
import { MAX_IMAGE_BYTES } from "@/lib/product-image";
import { MAX_REVIEW_PHOTO_BYTES } from "@/lib/review-summary";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { POSITIVE_NET_CENTS } from "@/lib/receiving-costs";
import { TIERS } from "@/lib/plan";
import { GB, STORAGE_PER_GB } from "./plan-cost-registry";
import { pictureRows, renderPicturesFigure } from "./pictures-figure-table";
import { done, is, part } from "./check";

const rows = pictureRows();

part("The most a store can add in a month");
for (const tier of TIERS) {
  const row = rows.find((r) => r.tier === tier && r.cycle === "month")!;
  is(`${tier}: studio pictures and review photos at their largest`, row.figureBytes, STORE_ALLOWANCES[tier].studio * MAX_IMAGE_BYTES + STORE_ALLOWANCES[tier].buyer * MAX_REVIEW_PHOTO_BYTES);
  is(`${tier}: kept full, a month at the dearest store`, row.monthUsd, (row.figureBytes / GB) * STORAGE_PER_GB);
}

part("Every plan keeps MR's positive net with it");
is("six units, monthly and yearly", rows.length, TIERS.length * 2);
for (const row of rows) is(`${row.id}: net with the pictures' figure full`, row.netWithCents >= POSITIVE_NET_CENTS, true);
is("the yearly unit pays twelve months of it", rows.filter((r) => r.cycle === "year").every((r) => Math.abs(r.periodUsd - 12 * r.monthUsd) < 1e-9), true);

part("The record");
const doc = renderPicturesFigure();
is("a PROPOSAL, said first", doc.split("\n").slice(0, 4).join("\n").includes("PROPOSAL"), true);
is("it names the sweep of pictures attached to nothing as a later unit, never deleting one in use", [/attached to nothing/.test(doc), /never/.test(doc)], [true, true]);
is("it has an Acessibilidade section", doc.includes("## Acessibilidade"), true);
is("docs/pictures-figure-proposal.md is current (node scripts/pictures-figure.mjs)", existsSync("docs/pictures-figure-proposal.md") ? readFileSync("docs/pictures-figure-proposal.md", "utf8") : "", doc);

done();
