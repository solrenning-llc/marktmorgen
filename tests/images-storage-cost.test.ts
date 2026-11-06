/**
 * What every picture kept under images/<folder>/ in Vercel Blob costs to keep (MR audit item 3, unit (d), approved by
 * Claude 4 in C4-20261106-2790-C56-167). No meter counts that folder: storageUsed (lib/storage-quota.ts) adds only
 * filesHeld, which lists stores/<folder>/ (lib/file-store.ts), so the plan's storage line never covered a picture.
 *
 * The line counts a stock bounded by the code's own constants, and what one window can add on top:
 *   - a product's picture, its smaller copy and its thumbnail: MAX_PRODUCTS of them, the first two at most
 *     MAX_IMAGE_BYTES (the door signs every upload at it), the thumbnail at MAX_THUMB_BYTES (checked at attach);
 *   - a product page's pictures, its second version's included: MAX_PAGE_PICTURES a page, one page a product;
 *   - a store page's pictures: MAX_SITE_PAGES pages, MAX_PAGE_PICTURES each;
 *   - a link's picture: MAX_STORE_LINKS links, one picture each;
 *   - a buyer's review photo: one a review, at most MAX_REVIEW_PHOTO_BYTES; the reviews a store keeps are bounded by
 *     its data room, each taking at least five entries of it (lib/reviews.ts reviewBytes), and by
 *     MAX_REVIEWS_PER_PRODUCT on each of MAX_PRODUCTS;
 *   - the window's own additions: every door and every email picture is a studio request (studioAccess,
 *     countStudio; the email picture's route needs "draft"), so at most the plan's studio figure a window, each at
 *     most MAX_IMAGE_BYTES (an email picture is at most MAX_MAIL_PICTURE_BYTES, less), all kept the whole window.
 *
 * Not bounded by any of this, and said in the basis: a door's file never put on anything is never deleted
 * (lib/picture-door.ts, "Unknown is kept"), an email picture is kept as long as the store is, and nothing deletes
 * images/ at the closing day or after (lib/plan-closing.ts removeStored). What earlier windows left behind grows
 * without end, so no finite monthly figure holds for it until the code deletes it: a separate unit.
 */
import { COST_LINES, GB, STORAGE_PER_GB } from "./plan-cost-registry";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { MAX_IMAGE_BYTES, MAX_THUMB_BYTES } from "@/lib/product-image";
import { MAX_PAGE_PICTURES } from "@/lib/sales-page";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { MAX_SITE_PAGES } from "@/lib/site-page-rules";
import { MAX_STORE_LINKS } from "@/lib/store-link";
import { MAX_REVIEW_PHOTO_BYTES, MAX_REVIEWS_PER_PRODUCT } from "@/lib/review-summary";
import { MAX_MAIL_PICTURE_BYTES } from "@/lib/mail-picture-rules";
import { DATA_ROOM_BYTES, ENTRY_BYTES } from "@/lib/store-data-rules";
import { done, is, part } from "./check";

part("A line of its own for the pictures kept under images/");
const line = COST_LINES.find((each) => each.id === "images-storage");
is("the line exists", Boolean(line), true);
is("an email picture is never heavier than a door's file, so the studio figure at MAX_IMAGE_BYTES covers both", MAX_MAIL_PICTURE_BYTES <= MAX_IMAGE_BYTES, true);
is("a thumbnail is never heavier than a door's file", MAX_THUMB_BYTES <= MAX_IMAGE_BYTES, true);

part("The stock each plan can hold, from the code's own constants, and one window's additions on top");
for (const tier of ["creator", "pro", "scale"] as const) {
  const products = MAX_PRODUCTS * (2 * MAX_IMAGE_BYTES + MAX_THUMB_BYTES);
  const productPages = MAX_PRODUCTS * MAX_PAGE_PICTURES * MAX_IMAGE_BYTES;
  const sitePages = MAX_SITE_PAGES * MAX_PAGE_PICTURES * MAX_IMAGE_BYTES;
  const links = MAX_STORE_LINKS * MAX_IMAGE_BYTES;
  const reviews = Math.min(MAX_PRODUCTS * MAX_REVIEWS_PER_PRODUCT, Math.floor(DATA_ROOM_BYTES[tier] / (5 * ENTRY_BYTES))) * MAX_REVIEW_PHOTO_BYTES;
  const window = STORE_ALLOWANCES[tier].studio * MAX_IMAGE_BYTES;
  const want = ((products + productPages + sitePages + links + reviews + window) / GB) * STORAGE_PER_GB;
  is(`${tier}: every kind at its most, kept the whole month, at STORAGE_PER_GB`, Math.abs((line?.monthlyUsd(tier) ?? Number.NaN) - want) < 1e-9, true);
}

part("Its sources hold what it names, and its basis says the source, the date and what it does not bound");
const cites = (file: string, name: string) => Boolean(line?.sources.some((source) => source.file === file && source.names.includes(name)));
is("the picture sizes", cites("lib/product-image.ts", "MAX_IMAGE_BYTES") && cites("lib/product-image.ts", "MAX_THUMB_BYTES"), true);
is("the door signs every upload at MAX_IMAGE_BYTES", cites("app/api/store/image/upload/route.ts", "maximumSizeInBytes: MAX_IMAGE_BYTES"), true);
is("the counts of products, page pictures, store pages and links", cites("lib/catalog-rules.ts", "MAX_PRODUCTS") && cites("lib/sales-page.ts", "MAX_PAGE_PICTURES") && cites("lib/site-page-rules.ts", "MAX_SITE_PAGES") && cites("lib/store-link.ts", "MAX_STORE_LINKS"), true);
is("the review photo and the room that bounds the reviews", cites("lib/review-summary.ts", "MAX_REVIEW_PHOTO_BYTES") && cites("lib/review-summary.ts", "MAX_REVIEWS_PER_PRODUCT") && cites("lib/store-data-rules.ts", "DATA_ROOM_BYTES") && cites("lib/reviews.ts", "dataBytes([JSON.stringify(review)], 5)"), true);
is("the email picture and the studio figure it is taken from", cites("lib/mail-picture-rules.ts", "MAX_MAIL_PICTURE_BYTES") && cites("app/api/store/mail/picture/route.ts", "guardStoreWrite(request, \"draft\"") && cites("lib/store-allowance-rules.ts", "STORE_ALLOWANCES"), true);
is("the meter that never lists images/", cites("lib/file-store.ts", "prefix: `stores/${folder}/`"), true);
is("the door that keeps what it cannot place", cites("lib/picture-door.ts", "Unknown is kept"), true);
const basis = line?.basis ?? "";
is("its price source and the date it was checked", /vercel\.com\/docs\/vercel-blob\/usage-and-pricing/.test(basis) && /6 November 2026/.test(basis), true);
is("it says what earlier windows leave behind is not bounded and needs a code change", /without end/.test(basis) && /code change/.test(basis), true);
done();
