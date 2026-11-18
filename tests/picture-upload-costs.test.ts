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
import { done, is, part } from "./check";

part("The official prices, with their source and date");
is("an upload (put) is an Advanced Operation, US$ 5 a million", BLOB_ADVANCED_OP, 5 / 1e6);
is("a head or a read is a Simple Operation, US$ 0.40 a million", BLOB_SIMPLE_OP, 0.4 / 1e6);

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

part("The signing request is tried as a put is, and the reads cross from the file store (Claude 1 on #2803, 6708192310)");
// Every upload request asks the Blob for a signed token (issueSignedToken); in the installed SDK that is
// requestApi("/signed-token", POST), the same request a put or a head goes through, so it is tried again as often.
// No official page says a signed-token request is free: unknown is never zero, so it is counted as a put, at the
// dearer Advanced Operation, with every try.
const route = readFileSync("app/api/store/image/upload/route.ts", "utf8");
const signBody = sdk.slice(sdk.indexOf("async function issueSignedToken("), sdk.indexOf("\n}", sdk.indexOf("async function issueSignedToken(")));
is("the upload route asks for a signed token on every request", /await issueSignedToken\(/.test(route), true);
is("the SDK's signing goes through requestApi, so it is tried again", /requestApi\(\s*"\/signed-token"/.test(signBody), true);
const signTries = (registry as Record<string, unknown>).BLOB_SIGN_TRIES;
is("a signing request counted with every try, as a put is", signTries, tries);
is("the line names the signing call among its sources", Boolean(COST_LINES.find((each) => each.id === "picture-uploads")?.sources.some((source) => source.file === "app/api/store/image/upload/route.ts" && source.names.includes("issueSignedToken"))), true);
// firstBytes fetches a private blob; the official page prices that as Blob Data Transfer plus Fast Origin Transfer on
// a cache miss, and one CDN request for the URL. The line counts each read as a miss (a Simple Operation each), so the
// bytes cross at both rates, as PICTURE_READ prices a private picture read.
is("the basis says the reads pay Fast Origin Transfer and a CDN request", /Fast Origin Transfer/.test(COST_LINES.find((each) => each.id === "picture-uploads")?.basis ?? "") && /CDN request/.test(COST_LINES.find((each) => each.id === "picture-uploads")?.basis ?? ""), true);

part("Every studio picture upload's Blob operations, at the plan's studio ceiling");
const line = COST_LINES.find((each) => each.id === "picture-uploads");
is("a line of its own", Boolean(line), true);
is("it says which pictures it covers: a product's, a link's and a page's (a review's photo and an email's picture are reported apart)", /product's, a link's and a page's/.test(line?.feature ?? "") && !/^Pictures uploaded \(a product's/.test(line?.feature ?? ""), true);
for (const tier of ["creator", "pro", "scale"] as const) {
  // A put and a signing request, each with every try; three heads (the name, then the picture and its smaller copy);
  // two reads, of those two copies, each a CDN request whose whole bytes cross at Blob and Fast Origin Transfer.
  const put = typeof tries === "number" ? tries : Number.NaN, heads = typeof headTries === "number" ? headTries : Number.NaN;
  const sign = typeof signTries === "number" ? signTries : Number.NaN;
  const perRequest = (put + sign) * BLOB_ADVANCED_OP + (3 * heads + 2) * BLOB_SIMPLE_OP + 2 * CDN_PER_REQUEST + 2 * MAX_IMAGE_BYTES * (BLOB_TRANSFER_PER_BYTE + ORIGIN_PER_BYTE);
  is(`${tier}: the studio figure, each request at its dearest`, Math.abs((line?.monthlyUsd(tier) ?? 0) - STORE_ALLOWANCES[tier].studio * perRequest) < 1e-9, true);
}
is("its source and date are said, and why the read is counted whole", (line?.basis ?? "").includes("Prices: vercel.com/docs/vercel-blob/usage-and-pricing, read on 6 November 2026") && /6 November 2026/.test(line?.basis ?? "") && /206/.test(line?.basis ?? ""), true);
done();
