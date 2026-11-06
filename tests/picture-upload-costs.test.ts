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

part("Every studio picture upload's Blob operations, at the plan's studio ceiling");
const line = COST_LINES.find((each) => each.id === "picture-uploads");
is("a line of its own", Boolean(line), true);
is("it says which pictures it covers: a product's, a link's and a page's (a review's photo and an email's picture are reported apart)", /product's, a link's and a page's/.test(line?.feature ?? "") && !/^Pictures uploaded \(a product's/.test(line?.feature ?? ""), true);
for (const tier of ["creator", "pro", "scale"] as const) {
  const perRequest = (typeof tries === "number" ? tries : Number.NaN) * BLOB_ADVANCED_OP + 5 * BLOB_SIMPLE_OP + 2 * MAX_IMAGE_BYTES * BLOB_TRANSFER_PER_BYTE;
  is(`${tier}: the studio figure, each request at its dearest`, Math.abs((line?.monthlyUsd(tier) ?? 0) - STORE_ALLOWANCES[tier].studio * perRequest) < 1e-9, true);
}
is("its source and date are said, and why the read is counted whole", /vercel\.com\/docs\/vercel-blob\/usage-and-pricing/.test(line?.basis ?? "") && /6 November 2026/.test(line?.basis ?? "") && /206/.test(line?.basis ?? ""), true);
done();
