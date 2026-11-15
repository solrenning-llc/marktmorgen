/**
 * A paid pre-order is written down exactly (CX-123 rule 24; Claude 5's finding on #2963). The record's pipeline
 * (HSETNX, HGET, EXPIRE, the payment's SET, the store's SET) is read reply by reply: a lost or off-shape answer is
 * never "recorded", so confirmPreorder throws and the webhook is retried, instead of sending a receipt for an entry
 * that does not exist (coming soon) or answering "skip" (on sale), after which the paid pre-order is never handed
 * over. A retry records it once and hands it over once. Rule 30: the hand-over's "given" write is read the same way.
 */
import { confirmPreorder, readPreorder } from "@/lib/preorders";
import { importedKey } from "@/lib/imported-purchases";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "r".repeat(32);
const NOW = Date.parse("2026-11-07T12:00:00Z");
const pipeline = redis.pipeline.bind(redis);

const emails: { to: string; subject: string; once: string | null }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body));
    emails.push({ to: ([] as string[]).concat(body.to)[0], subject: body.subject, once: new Headers(init?.headers).get("idempotency-key") });
    return new Response(JSON.stringify({ id: "e" }));
  }
  throw new Error(`Unexpected external request: ${url.hostname}`);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidrec00001",
    handle: "recshop",
    name: "Record Shop",
    email: "owner@example.com",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    currency: "usd",
    language: "en",
    stripeAccountId: "acct_test_recordpre",
    pastBuyers: true,
  } as unknown as Store;
}

const product = { id: "recbook1", title: "The Record Book", course: null, priceCents: 2500 } as unknown as Listing;
const entries = `nl:pre:${STATS}:${product.id}`;
const soonKey = `nl:wl:${STATS}:soon`;

function session(n: number) {
  return {
    id: `cs_test_recordpre${String(n).padStart(6, "0")}`,
    created: Math.floor(NOW / 1000) - 60,
    status: "complete",
    payment_status: "paid",
    amount_total: 2500,
    currency: "usd",
    payment_intent: `pi_recordpre${String(n).padStart(6, "0")}`,
    metadata: { store: "recshop", product: product.id, preorder: "yes" },
    customer_details: { email: `buyer${n}@example.com` },
  };
}

const deps = {
  base: "https://marktmorgen.com/@recshop",
  from: "Record Shop <hello@example.com>",
  ordersLink: async () => null,
  recordStart: async () => {},
};

/** What confirmPreorder did: its answer, or "unconfirmed" when it threw UnknownReplyError. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    return String(await run());
  } catch (error) {
    return error instanceof UnknownReplyError ? "unconfirmed" : `threw: ${(error as Error).message}`;
  }
}

/** The record's pipeline (the one that starts with HSETNX on the entries) answered `mangle` of the real replies; `lost` sends nothing to Redis. */
function recordAnswers(mangle: (real: unknown[]) => unknown, lost = false): void {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "HSETNX" && commands[0][1] === entries) return mangle(lost ? [] : await pipeline(commands));
    return pipeline(commands);
  }) as typeof redis.pipeline;
}

const receiptsTo = (n: number) => emails.filter((e) => e.to === `buyer${n}@example.com` && e.subject.startsWith("Your pre-order")).length;
const outTo = (n: number) => emails.filter((e) => e.to === `buyer${n}@example.com` && e.subject.startsWith("It is out")).length;
const granted = async (n: number) => typeof (await pipeline([["HGET", importedKey(STATS, `buyer${n}@example.com`), product.id]]))[0] === "string";
const fields = async () => Number((await pipeline([["HLEN", entries]]))[0]);

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_only";
  redis.clear();
  const store = shop();

  part("Coming soon: a write whose reply is lost is never taken as recorded");
  await pipeline([["SADD", soonKey, product.id]]);
  recordAnswers(() => [], true);
  is("lost reply, nothing written: confirmPreorder throws, no receipt for an entry that does not exist", [await outcome(() => confirmPreorder(store, session(1), product, deps)), receiptsTo(1), await readPreorder(store, product.id, session(1).id)], ["unconfirmed", 0, null]);
  redis.pipeline = pipeline;
  is("the webhook's retry records it once and sends the receipt once", [await confirmPreorder(store, session(1), product, deps), receiptsTo(1), (await readPreorder(store, product.id, session(1).id))?.to], ["sent", 1, "buyer1@example.com"]);

  part("Coming soon: every reply in another shape is unknown");
  const vectors: [string, (r: unknown[]) => unknown][] = [
    ["HSETNX answered OK", (r) => ["OK", ...r.slice(1)]],
    ["HSETNX answered null", (r) => [null, ...r.slice(1)]],
    ["HSETNX answered 2", (r) => [2, ...r.slice(1)]],
    ["HGET answered a number", (r) => [r[0], 7, ...r.slice(2)]],
    ["HGET answered null", (r) => [r[0], null, ...r.slice(2)]],
    ["HGET answered text that is no pre-order", (r) => [r[0], "{", ...r.slice(2)]],
    ["EXPIRE answered null", (r) => [r[0], r[1], null, ...r.slice(3)]],
    ["the payment's SET answered null", (r) => [...r.slice(0, 3), null, r[4]]],
    ["the store's SET answered 1", (r) => [...r.slice(0, 4), 1]],
    ["one reply short", (r) => r.slice(0, -1)],
    ["one reply too many", (r) => [...r, "OK"]],
    ["not a list", () => "OK"],
  ];
  let n = 10;
  for (const [name, mangle] of vectors) {
    n += 1;
    recordAnswers(mangle);
    is(`${name}: thrown, no receipt`, [await outcome(() => confirmPreorder(store, session(n), product, deps)), receiptsTo(n)], ["unconfirmed", 0]);
    redis.pipeline = pipeline;
  }
  const before = await fields();
  is("retried with real answers: recorded once, receipted once", [await confirmPreorder(store, session(11), product, deps), await fields(), receiptsTo(11)], ["sent", before, 1]);
  is("a normal write is recorded and receipted (control)", [await confirmPreorder(store, session(99), product, deps), receiptsTo(99), await fields()], ["sent", 1, before + 1]);

  part("On sale: a lost record never ends in a skip that drops the paid order");
  await pipeline([["SREM", soonKey, product.id]]);
  recordAnswers(() => [], true);
  is("lost reply: thrown, nothing handed over, never \"skip\"", [await outcome(() => confirmPreorder(store, session(2), product, deps)), await granted(2), outTo(2)], ["unconfirmed", false, 0]);
  redis.pipeline = pipeline;
  is("the retry hands it over once", [await confirmPreorder(store, session(2), product, deps), await granted(2), outTo(2)], ["given", true, 1]);

  part("Rule 30: the hand-over's \"given\" write is read exactly too");
  /** The hand-over's given write for session n answered [null, 1]; `lands` says whether Redis really wrote it. */
  const givenAnswers = (n: number, lands: boolean) => {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const [first] = commands;
      if (first?.[0] === "HSET" && first[1] === entries && first[2] === session(n).id && typeof first[3] === "string" && JSON.parse(first[3]).given) {
        if (lands) await pipeline(commands);
        return [null, 1];
      }
      return pipeline(commands);
    }) as typeof redis.pipeline;
  };
  givenAnswers(3, true);
  is("written but answered in another shape: thrown, never \"given\"; the grant stands, so the way in is emailed; the giving mark let go", [await outcome(() => confirmPreorder(store, session(3), product, deps)), await granted(3), outTo(3), (await pipeline([["GET", `nl:pre:give:${session(3).id}`]]))[0]], ["unconfirmed", true, 1, null]);
  redis.pipeline = pipeline;
  is("the retry finds it given: no second grant, no second email", [await confirmPreorder(store, session(3), product, deps), Boolean((await readPreorder(store, product.id, session(3).id))?.given), outTo(3)], ["given", true, 1]);
  givenAnswers(4, false);
  is("not written and answered in another shape: thrown, never \"given\"", [await outcome(() => confirmPreorder(store, session(4), product, deps)), Boolean((await readPreorder(store, product.id, session(4).id))?.given)], ["unconfirmed", false]);
  redis.pipeline = pipeline;
  const once = emails.filter((e) => e.to === "buyer4@example.com" && e.subject.startsWith("It is out")).map((e) => e.once);
  is("the retry marks it given; each email of the way in carries the same idempotency key, so the buyer gets one", [await confirmPreorder(store, session(4), product, deps), Boolean((await readPreorder(store, product.id, session(4).id))?.given), new Set([...once, ...emails.filter((e) => e.to === "buyer4@example.com" && e.subject.startsWith("It is out")).map((e) => e.once)]).size], ["given", true, 1]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
