/**
 * The way-in email of a pre-order handed over survives a "given" mark whose answer was lost (Codex P on #3077,
 * proof tests/p-3077-given-ack.proof.ts on codex/p-review-3077-preorder-record): the HSET/EXPIRE applied in Redis,
 * then the transport threw. Before, control left handOverPreorder before the email, and a retry read the entry as
 * given and answered "already", so the buyer was never sent the way in. Now the email is asked for once the grant
 * stands and before the mark, and a retry that finds it given asks again under the same idempotency key, which the
 * sender keeps: exactly one email in every case, never two.
 */
import { confirmPreorder, readPreorder } from "@/lib/preorders";
import { importedKey } from "@/lib/imported-purchases";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

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

const outTo = (n: number) => emails.filter((e) => e.to === `buyer${n}@example.com` && e.subject.startsWith("It is out")).length;
const granted = async (n: number) => typeof (await pipeline([["HGET", importedKey(STATS, `buyer${n}@example.com`), product.id]]))[0] === "string";

const keys = (n: number) => [...new Set(emails.filter((e) => e.to === `buyer${n}@example.com` && e.subject.startsWith("It is out")).map((e) => e.once))];

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_only";
  for (const [mode, n] of [["healthy", 201], ["offshape", 202], ["lost-ack", 203]] as const) {
    redis.clear();
    emails.length = 0;
    const store = shop();
    // Only the hand-over's "given" HSET of this session is touched; every other command is the stand-in's own.
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const first = commands[0];
      if (first?.[0] === "HSET" && first[1] === entries && first[2] === session(n).id && JSON.parse(String(first[3])).given) {
        const actual = await pipeline(commands);
        if (mode === "lost-ack") throw new Error("synthetic answer lost after the given mark applied");
        if (mode === "offshape") return [null, 1];
        return actual;
      }
      return pipeline(commands);
    }) as typeof redis.pipeline;
    const first = await outcome(() => confirmPreorder(store, session(n), product, deps));
    redis.pipeline = pipeline;
    is(`${mode}: first run's answer`, mode === "healthy" ? first === "given" : first !== "given", true);
    is(`${mode}: access granted`, await granted(n), true);
    is(`${mode}: given written`, Boolean((await readPreorder(store, product.id, session(n).id))?.given), true);
    is(`${mode}: way-in email asked for once the grant stands`, outTo(n), 1);
    is(`${mode}: retry answers given`, await confirmPreorder(store, session(n), product, deps), "given");
    is(`${mode}: still exactly one way-in email after the retry`, outTo(n), 1);
    is(`${mode}: under the pre-order's own idempotency key`, keys(n), [`nimbus-preorder-out:${session(n).id}`]);
  }

  // An entry already given whose email never went (an earlier run stopped between the mark and the email): the
  // retry that finds it given asks for the email once, under the same key.
  {
    const n = 204;
    redis.clear();
    emails.length = 0;
    const store = shop();
    // No sender configured on the first run: nothing reaches a provider, nothing is reserved under the key.
    delete process.env.RESEND_API_KEY;
    await outcome(() => confirmPreorder(store, session(n), product, deps));
    process.env.RESEND_API_KEY = "re_test_only";
    is("given, email never sent: given written", Boolean((await readPreorder(store, product.id, session(n).id))?.given), true);
    is("given, email never sent: none before the retry", outTo(n), 0);
    is("given, email never sent: retry answers given", await confirmPreorder(store, session(n), product, deps), "given");
    is("given, email never sent: one way-in email after the retry", outTo(n), 1);
    is("given, email never sent: under the pre-order's own idempotency key", keys(n), [`nimbus-preorder-out:${session(n).id}`]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
