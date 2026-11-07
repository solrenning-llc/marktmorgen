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
 process.env.RESEND_API_KEY="re_test_only";
 for (const [mode,n] of [["healthy",201],["offshape",202],["lost-ack",203]] as const) {
  redis.clear(); emails.length=0; const store=shop();
  redis.pipeline=(async (commands:(string|number)[][])=>{
   const first=commands[0];
   if(first?.[0]==="HSET"&&first[1]===entries&&first[2]===session(n).id&&JSON.parse(String(first[3])).given){
    const actual=await pipeline(commands);
    if(mode==="lost-ack")throw Error("synthetic ACK lost after given mark applied");
    if(mode==="offshape")return [null,1];
    return actual;
   }
   return pipeline(commands);
  }) as typeof redis.pipeline;
  const first=await outcome(()=>confirmPreorder(store,session(n),product,deps));
  redis.pipeline=pipeline;
  is(mode+": initial disposition",mode==="healthy"?first==="given":first!=="given",true);
  is(mode+": access granted",await granted(n),true);
  is(mode+": given persisted",Boolean((await readPreorder(store,product.id,session(n).id))?.given),true);
  is(mode+": way-in email attempted after grant",outTo(n),1);
  is(mode+": retry completed",await confirmPreorder(store,session(n),product,deps),"given");
  is(mode+": one way-in email after retry",outTo(n),1);
 }
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
