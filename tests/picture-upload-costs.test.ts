/**
 * The Blob operations and reads of every picture upload, never counted before (C4-20261106-1110-C5-62 and
 * C4-20261106-1120-TODOS-63): a picture, a link's picture or a page's picture is put through its own upload request,
 * and attaching it is one more; each is a studio request (studioAccess, countStudio), so at most the plan's studio
 * figure of them a month, a hard ceiling. Each request is counted at its dearest, from the official prices read on
 * 6 November 2026 (vercel.com/docs/vercel-blob/usage-and-pricing): one put (an Advanced Operation), five Simple
 * Operations (the head that checks a name is free; a head and a read of the picture and of its smaller copy) and the
 * read of both copies' whole bytes. The read is counted whole because no official page says the Blob honors a byte
 * range with 206 or bills only the bytes sent (lib/uploaded-image.ts, firstBytes reads a stream it cancels): unknown is
 * never zero.
 *
 * Counted honestly, the refunded first year on Creator passed the owner's US$ 65 ceiling (tests/read-ceilings.test.ts,
 * tests/plan-margin.test.ts). The owner raised that ceiling to US$ 66 on 6 November 2026 (C4-20261106-2640-DONO-156)
 * for this line; no price, visible limit or commission moves.
 */
import { readFileSync } from "node:fs";
import * as registry from "./plan-cost-registry";
import { COST_LINES, BLOB_ADVANCED_OP, BLOB_SIMPLE_OP, BLOB_TRANSFER_PER_BYTE } from "./plan-cost-registry";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { MAX_IMAGE_BYTES, MAX_THUMB_BYTES } from "@/lib/product-image";
import { MAX_PAGE_PICTURES } from "@/lib/sales-page";
import { done, is, part } from "./check";

part("The official prices, with their source and date");
// Regional prices (vercel.com/docs/pricing/regional-pricing): the dearest region, gru1, while the store's region is
// unreviewed (Claude 1 on #2848, comment 6708241908).
is("an upload (put) is an Advanced Operation, US$ 7.00 a million at the dearest region", BLOB_ADVANCED_OP, 7 / 1e6);
is("a head or a read is a Simple Operation, US$ 0.56 a million at the dearest region", BLOB_SIMPLE_OP, 0.56 / 1e6);

part("A put may be sent again: every try counted (Revisor 1 on #2803)");
// @vercel/blob tries a failed put again up to VERCEL_BLOB_RETRIES times, 10 unless set (dist getRetries), and no
// official page says a put tried again, or refused, is not billed: unknown is never zero, so 1 + 10 puts a request.
const sdk = readFileSync("node_modules/@vercel/blob/dist/chunk-YYMLUMXS.js", "utf8");
const retries = Number(/process\.env\.VERCEL_BLOB_RETRIES \|\| "(\d+)"/.exec(sdk)?.[1] ?? Number.NaN);
const tries = (registry as Record<string, unknown>).BLOB_PUT_TRIES;
is("the installed SDK's own default: 10 tries again", retries, 10);
is("a put counted as 1 + every try again", tries, 1 + retries);

// The same tries cover a head (head() goes through requestApi, as a put does); a read through get() is one plain fetch
// (Codex S on #2801, 5805761543): every head counted with its tries, every read once.
const index = readFileSync("node_modules/@vercel/blob/dist/index.js", "utf8");
const body = (name: string) => index.slice(index.indexOf(`async function ${name}(`), index.indexOf("\n}", index.indexOf(`async function ${name}(`)));
is("the SDK's head goes through requestApi, so it is tried again", /requestApi\(/.test(body("head")), true);
is("the SDK's get is one plain fetch, never tried again", /await fetch\(/.test(body("get")) && !/requestApi\(/.test(body("get")), true);
const headTries = (registry as Record<string, unknown>).BLOB_HEAD_TRIES;
is("a head counted with every try, as a put is", headTries, tries);

part("Every studio picture's Blob operations, one line for the whole studio figure (MR audit gap 1, C4-20261106-2790-C56-167)");
// Rule 23: picture-uploads and picture-thumbnails each multiplied the whole studio figure; doors, attaches and page
// saves share it, so they are one line, studio-blob, each request at the dearest kind it may be.
const line = COST_LINES.find((each) => each.id === "studio-blob");
is("a line of its own, and the two lines it replaces are gone", [Boolean(line), COST_LINES.some((each) => each.id === "picture-uploads" || each.id === "picture-thumbnails")], [true, false]);
is("it says which pictures it covers: a product's, a link's and a page's", /a product's, a link's and a page's/.test(line?.feature ?? ""), true);
const tokenTries = (registry as Record<string, unknown>).BLOB_TOKEN_TRIES;
is("a door's signed token: priced nowhere, so counted as an Advanced Operation with every try, never zero", tokenTries, tries);
for (const tier of ["creator", "pro", "scale"] as const) {
  const put = typeof tries === "number" ? tries : Number.NaN, heads = typeof headTries === "number" ? headTries : Number.NaN;
  const token = typeof tokenTries === "number" ? tokenTries : Number.NaN;
  // A door: its put, its token and the head that checks the name, every try.
  const door = (put + token) * BLOB_ADVANCED_OP + heads * BLOB_SIMPLE_OP;
  // A check: a head with every try, one plain read, the bytes counted whole.
  const check = (bytes: number) => heads * BLOB_SIMPLE_OP + BLOB_SIMPLE_OP + bytes * BLOB_TRANSFER_PER_BYTE;
  const reattach = 2 * check(MAX_IMAGE_BYTES) + check(MAX_THUMB_BYTES);
  const page = (MAX_PAGE_PICTURES * (door + check(MAX_IMAGE_BYTES))) / (MAX_PAGE_PICTURES + 1);
  const perRequest = check(MAX_IMAGE_BYTES) + Math.max(door, reattach, page);
  is(`${tier}: the studio figure, each request at its dearest kind, and a day of doors from the month before checked on top`, Math.abs((line?.monthlyUsd(tier) ?? 0) - STORE_ALLOWANCES[tier].studio * perRequest) < 1e-9, true);
}
is("its source and date are said, and why the read is counted whole", /vercel\.com\/docs\/vercel-blob\/usage-and-pricing/.test(line?.basis ?? "") && /6 November 2026/.test(line?.basis ?? "") && /206/.test(line?.basis ?? ""), true);
done();
