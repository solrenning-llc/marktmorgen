/**
 * The Blob operations and reads of every picture upload, never counted before (C4-20261106-1110-C5-62 and
 * C4-20261106-1120-TODOS-63): a picture, a link's picture or a page's picture is put through its own upload request,
 * and attaching it is one more; each is a studio request (studioAccess, countStudio), so at most the plan's studio
 * figure of them a month, a hard ceiling. Each request is counted at its dearest, from the official prices read on
 * 6 November 2026 (vercel.com/docs/vercel-blob/usage-and-pricing): its put and its signing request (Advanced
 * Operations) with every try the SDK may send, three heads with every try and two reads (Simple Operations: the head
 * that checks a name is free; a head and a read of the picture and of its smaller copy), each read a CDN request, and
 * both copies' whole bytes at Blob and Fast Origin Transfer. The read is counted whole because no official page says the Blob honors a byte
 * range with 206 or bills only the bytes sent (lib/uploaded-image.ts, firstBytes reads a stream it cancels): unknown is
 * never zero.
 *
 * Counted honestly, the refunded first year on Creator passed the owner's US$ 65 ceiling (tests/read-ceilings.test.ts,
 * tests/plan-margin.test.ts). The owner raised that ceiling to US$ 66 on 6 November 2026 (C4-20261106-2640-DONO-156)
 * for this line; no price, visible limit or commission moves.
 */
import { readFileSync } from "node:fs";
import * as registry from "./plan-cost-registry";
import { COST_LINES, BLOB_ADVANCED_OP, BLOB_SIMPLE_OP, BLOB_TRANSFER_PER_BYTE, ORIGIN_PER_BYTE } from "./plan-cost-registry";
import { CDN_PER_REQUEST } from "./traffic-cost";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { MAX_IMAGE_BYTES } from "@/lib/product-image";
import { MAX_PAGE_PICTURES } from "@/lib/sales-page";
import { PICTURE_DOOR_MAX } from "@/lib/picture-door";
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

part("The signing request is tried as a put is (Claude 1 on #2803, 6708192310)");
// Every upload request asks the Blob for a signed token (issueSignedToken); in the installed SDK that is
// requestApi("/signed-token", POST), the same request a put or a head goes through, so it is tried again as often.
// No official page says a signed-token request is free: unknown is never zero, so it is counted as a put, at the
// dearer Advanced Operation, with every try (BLOB_TOKEN_TRIES, below).
const route = readFileSync("app/api/store/image/upload/route.ts", "utf8");
const signBody = sdk.slice(sdk.indexOf("async function issueSignedToken("), sdk.indexOf("\n}", sdk.indexOf("async function issueSignedToken(")));
is("the upload route asks for a signed token on every request", /await issueSignedToken\(/.test(route), true);
is("the SDK's signing goes through requestApi, so it is tried again", /requestApi\(\s*"\/signed-token"/.test(signBody), true);
is("the line names the signing call among its sources", Boolean(COST_LINES.find((each) => each.id === "studio-blob")?.sources.some((source) => source.file === "app/api/store/image/upload/route.ts" && source.names.includes("issueSignedToken"))), true);

part("Every studio picture's Blob operations, one line for the whole studio figure (MR audit gap 1, C4-20261106-2790-C56-167)");
// Rule 23: picture-uploads and picture-thumbnails each multiplied the whole studio figure; doors, attaches and page
// saves share it, so they are one line, studio-blob, each request at the dearest kind it may be.
const line = COST_LINES.find((each) => each.id === "studio-blob");
is("a line of its own, and the two lines it replaces are gone", [Boolean(line), COST_LINES.some((each) => each.id === "picture-uploads" || each.id === "picture-thumbnails")], [true, false]);
is("it says which pictures it covers: a product's, a link's and a page's", /a product's, a link's and a page's/.test(line?.feature ?? ""), true);
const tokenTries = (registry as Record<string, unknown>).BLOB_TOKEN_TRIES;
is("a door's signed token: priced nowhere, so counted as an Advanced Operation with every try, never zero", tokenTries, tries);
// C1-20261107-1550-TODOS-10 (Claude 4 on #2848, 6711058709): a check's read is a private-blob fetch, so its whole bytes
// pay Blob transfer and Fast Origin Transfer and the fetch is one CDN request, as PICTURE_READ and the sibling lines
// count it; a request whose picture fails also asks the Blob once more about each file it took (dropTakenPictures, a
// head with every try). Counted that way, a studio request may read only a file it took from the door, each once: a
// name the record already shows is answered from the record (app/api/store/image, app/api/store/link-image), so the
// re-attach kind is gone, and the reads of a month are at most its doors plus the notes alive when it began, never more
// than PICTURE_DOOR_MAX a store (lib/picture-door.ts).
is("a check's read pays Fast Origin Transfer and a CDN request, from the registry's and traffic-cost's own figures", (() => {
  const source = readFileSync("tests/plan-cost-registry.ts", "utf8");
  const at = source.indexOf("export function pictureCheckBlob(");
  const body = at < 0 ? "" : source.slice(at, source.indexOf("\n}", at));
  return /ORIGIN_PER_BYTE/.test(body) && /BLOB_TRANSFER_PER_BYTE/.test(body) && /CDN_PER_REQUEST/.test(body);
})(), true);
is("the basis says so, and names the door's cap on the notes carried into a month", /Fast Origin Transfer/.test(line?.basis ?? "") && /CDN request/.test(line?.basis ?? "") && /PICTURE_DOOR_MAX/.test(line?.basis ?? ""), true);
is("the line names the cap among its sources", Boolean(line?.sources.some((source) => source.file === "lib/picture-door.ts" && source.names.includes("PICTURE_DOOR_MAX"))), true);
for (const tier of ["creator", "pro", "scale"] as const) {
  const put = typeof tries === "number" ? tries : Number.NaN, heads = typeof headTries === "number" ? headTries : Number.NaN;
  const token = typeof tokenTries === "number" ? tokenTries : Number.NaN;
  const studio = STORE_ALLOWANCES[tier].studio;
  // A door: its put, its token and the head that checks the name, every try.
  const door = (put + token) * BLOB_ADVANCED_OP + heads * BLOB_SIMPLE_OP;
  // A check, at the dearest file a check may read (MAX_IMAGE_BYTES; a thumbnail's is smaller): a head with every try,
  // one plain read whose whole bytes cross at Blob and Fast Origin Transfer, one CDN request, and the clean-up head.
  const check = heads * BLOB_SIMPLE_OP + BLOB_SIMPLE_OP + MAX_IMAGE_BYTES * (BLOB_TRANSFER_PER_BYTE + ORIGIN_PER_BYTE) + CDN_PER_REQUEST + heads * BLOB_SIMPLE_OP;
  // Every read takes a note a door wrote: 24 doors and the save that checks them are 25 requests (an attach, at most
  // three doors and itself, and a link, one door and itself, are cheaper a request).
  const page = (MAX_PAGE_PICTURES * (door + check)) / (MAX_PAGE_PICTURES + 1);
  // The notes alive when the month began, read this month: at most PICTURE_DOOR_MAX a store.
  const carried = Math.min(studio, PICTURE_DOOR_MAX) * check;
  is(`${tier}: the studio figure at its dearest request kind, and the notes carried in, each read once`, Math.abs((line?.monthlyUsd(tier) ?? 0) - (studio * Math.max(door, page) + carried)) < 1e-9, true);
}
is("its source and date are said, and why the read is counted whole", (line?.basis ?? "").includes("Prices: vercel.com/docs/vercel-blob/usage-and-pricing, read on 6 November 2026") && /6 November 2026/.test(line?.basis ?? "") && /206/.test(line?.basis ?? ""), true);
done();
