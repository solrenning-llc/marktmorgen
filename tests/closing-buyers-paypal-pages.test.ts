/**
 * A closing store's PayPal buyers (lib/closing-buyers.ts, tellBuyers; #4258).
 *
 * They were read in the first round with one range and one MGET of every
 * record (readPayPalSales(statsId, 0, 100_000)): one command of up to N x
 * MAX_PAID_BYTES, not bounded by the closing job's run, and a record answered
 * as missing (or past the cap) was dropped without a word: neither told nor
 * counted in `untold`, which the creator's notices and studio show.
 *
 * Now they are read in pages of at most PAYPAL_PAGE records, the cursor kept
 * in the job's `after`, each page told before the next, the pages counted in
 * the closing's page cap; a record that cannot be read is counted as not
 * told, once.
 *
 * Redis is the in-memory one (its pipeline wrapped to count MGET keys); the
 * email sender is a stand-in. Nothing real is reached.
 */
import { creditKey, startClosingCredit } from "@/lib/closing-credit";
import { EMAILS_PER_BUYER_PER_ENDING } from "@/lib/closing-buyers-rules";
import { PAYPAL_PAGE, tellBuyers, toldKey, type Told } from "@/lib/closing-buyers";
import { claimHandle, storeFolder, storeForEmail, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.resend.com") {
    type One = { to: string | string[] };
    const body = JSON.parse(String(init?.body)) as One | One[];
    const all = Array.isArray(body) ? body : [body];
    for (const m of all) sent.push([m.to].flat()[0]);
    return json(Array.isArray(body) ? { data: all.map((_, i) => ({ id: `email_${sent.length}_${i}` })) } : { id: `email_${sent.length}` });
  }
  return json({ error: { message: "not stubbed" } }, 404);
}) as typeof fetch;

/** The largest MGET seen, in keys, since the last reset. */
let biggestMget = 0;
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const c of commands) if (String(c[0]).toUpperCase() === "MGET") biggestMget = Math.max(biggestMget, c.length - 1);
  return realPipeline(commands);
}) as typeof redis.pipeline;

const E = Date.UTC(2026, 10, 1);
const DAY = E + 30 * 86_400_000;

let made = 0;
/** A closing store with no Stripe account (only its PayPal sales to tell), its credit set. */
async function closingStore(handle: string, credit: number): Promise<{ store: Store; folder: string; statsId: string }> {
  made += 1;
  const owner = `${handle}@example.com`;
  await claimHandle(owner, handle, `PayPal ${made}`, "");
  const shop = await storeForEmail(owner);
  if (!shop?.statsId) throw new Error("the test store was not made");
  const store: Store = { ...shop, stripeAccountId: null };
  const folder = await storeFolder(storeRef(store));
  await startClosingCredit(folder, credit);
  return { store, folder, statsId: shop.statsId };
}

const order = (prefix: string, i: number) => `${prefix}${String(i).padStart(10, "0")}`;
/** PayPal sales kept as lib/paypal-sales.ts keeps them (its sales list and each paid record). */
async function seedSales(statsId: string, prefix: string, n: number, missing: number[] = []): Promise<string[]> {
  const emails: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = order(prefix, i);
    const email = `${prefix.toLowerCase()}${i}@buyers.example.com`;
    emails.push(email);
    await redis.pipeline([["ZADD", `nl:ppsell:sales:${statsId}`, 1_790_000_000 + i, id]]);
    if (!missing.includes(i)) {
      const paid = { store: statsId, order: id, capture: `CAP${id}`, email, product: "p1", cents: 1000, currency: "usd", at: 1_790_000_000 + i };
      await redis.pipeline([["SET", `nl:ppsell:paid:${id}`, JSON.stringify(paid)]]);
    }
  }
  return emails;
}

const countOf = (email: string) => sent.filter((to) => to === email).length;
const creditOf = async (folder: string) => Number((await redis.pipeline([["GET", creditKey(folder)]]))[0]);

/** Runs tellBuyers from `after` until it is done (or 20 runs), adding up what each run says. */
async function toTheEnd(store: Store, maxPages = Number.POSITIVE_INFINITY): Promise<{ last: Told; runs: number; sent: number; untold: number }> {
  let after = "";
  let pages = 0;
  let total = { sent: 0, untold: 0 };
  for (let runs = 1; runs <= 20; runs += 1) {
    const told = await tellBuyers(store, E, DAY, after, Date.now() + 60_000, pages, maxPages);
    total = { sent: total.sent + told.sent, untold: total.untold + told.untold };
    if (told.done) return { last: told, runs, ...total };
    after = told.after;
    pages = told.pages;
  }
  throw new Error("never done");
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.COMPANY_POSTAL_ADDRESS = "1 Test Street, Testville, DE 19901, USA";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const realError = console.error;
  console.error = () => {};

  part("Three PayPal sales, one record missing: two told, the missing one counted as not told, once");
  {
    const { store, folder, statsId } = await closingStore("ppmissing", 100);
    const emails = await seedSales(statsId, "PPMISS", 3, [1]);
    const end = await toTheEnd(store);
    is("the two whose records read are told once each", [countOf(emails[0]), countOf(emails[1]), countOf(emails[2])], [1, 0, 1]);
    is("the sale whose record is missing is counted in untold", end.untold, 1);
    is("credit taken only for the two told", await creditOf(folder), 100 - 2 * EMAILS_PER_BUYER_PER_ENDING);
    const again = await tellBuyers(store, E, DAY, "", Date.now() + 60_000);
    is("a fresh round does not count the missing one twice", again.untold, 0);
    is("its mark is on the told list", Number((await redis.pipeline([["HLEN", toldKey(await storeFolder(storeRef(store)))]]))[0]), 3);
  }

  part("A record written for another store, or text that is not a record: counted as not told; a reply out of shape acts on nothing");
  {
    const { store, statsId } = await closingStore("ppodd", 100);
    const emails = await seedSales(statsId, "PPODD", 3);
    await redis.pipeline([["SET", `nl:ppsell:paid:${order("PPODD", 0)}`, JSON.stringify({ store: "another", order: order("PPODD", 0), email: emails[0] })]]);
    await redis.pipeline([["SET", `nl:ppsell:paid:${order("PPODD", 1)}`, "not json"]]);
    // The first MGET answers out of shape (a number): nothing told, nothing counted, the cursor stays at the page.
    let spoiled = false;
    const wrapped = redis.pipeline;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!spoiled && String(commands[0]?.[0]) === "MGET") {
        spoiled = true;
        return [7];
      }
      return wrapped(commands);
    }) as typeof redis.pipeline;
    const first = await tellBuyers(store, E, DAY, "", Date.now() + 60_000);
    redis.pipeline = wrapped;
    is("out of shape: not done, cursor at the PayPal page, nobody told or counted", [first.done, first.after, first.sent, first.untold], [false, "pp|0", 0, 0]);
    const next = await tellBuyers(store, E, DAY, first.after, Date.now() + 60_000, first.pages);
    is("read again: the good one told, the two unreadable counted", [next.done, next.sent, next.untold, countOf(emails[2])], [true, 1, 2, 1]);
    is("the other store's buyer is not written to", countOf(emails[0]), 0);
  }

  part("A store with more PayPal sales than a page: no MGET above the page, every buyer told or counted");
  {
    const n = 2 * PAYPAL_PAGE + 37;
    const { store, statsId } = await closingStore("ppmany", 10 * n);
    const emails = await seedSales(statsId, "PPMANY", n);
    biggestMget = 0;
    const end = await toTheEnd(store);
    is("no single MGET reads more than a page of records", biggestMget <= PAYPAL_PAGE, true);
    is("every buyer told exactly once", emails.every((e) => countOf(e) === 1), true);
    is("all told, none untold", [end.sent, end.untold], [n, 0]);
    is("PayPal pages counted against the closing's page cap", end.last.pages, Math.ceil(n / PAYPAL_PAGE));
  }

  part("The closing's page cap stops the PayPal pages: the round ends capped, never silently");
  {
    const n = PAYPAL_PAGE + 5;
    const { store, statsId } = await closingStore("ppcapped", 10 * n);
    const emails = await seedSales(statsId, "PPCAP", n);
    const end = await toTheEnd(store, 1);
    is("done and capped", [end.last.done, end.last.capped], [true, true]);
    is("the first page told", emails.slice(n - PAYPAL_PAGE).every((e) => countOf(e) === 1), true);
  }

  console.error = realError;
  done();
}

void main();
