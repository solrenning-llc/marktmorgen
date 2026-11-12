/**
 * A closing store's PayPal buyers are never left out of its notice because
 * their reading failed (lib/closing-buyers.ts, tellBuyers; Claude 1 cloud's
 * L1 on #3443).
 *
 * #3443 made readPayPalSales answer `{ sales: [], partial: true }` when the
 * range or the MGET of the records comes back out of shape (rule 24), where it
 * used to keep the rows it could parse. tellBuyers ignored `partial`: on that
 * fault it told the Stripe members and imported buyers, marked the first step
 * done (`after: "start"`), and every PayPal buyer of the store was never told
 * it closes.
 *
 * Now a PayPal reading that failed whole is not done: nothing is marked, and
 * the closing job asks again. The control: a healthy reading tells each PayPal
 * buyer once and moves on. A reading cut at its limit (more sales than one
 * reading takes, so some were read) still tells the ones it read, as before.
 *
 * The email sender is a stand-in (fetch below); Redis is the in-memory one,
 * with one reply replaced where the test says so. Nothing real is reached.
 */
import { startClosingCredit } from "@/lib/closing-credit";
import { tellBuyers, type Told } from "@/lib/closing-buyers";
import { claimHandle, ensureStatsId, storeFolder, storeForEmail, storeRef, type Store } from "@/lib/store";
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

const E = Date.UTC(2026, 10, 1);
const DAY = E + 30 * 86_400_000;

let made = 0;
/** The PayPal order id of a test store's `i`th sale. */
const orderOf = (handle: string, i: number) => `ORDER${handle.toUpperCase()}${i}XXXXXX`.slice(0, 20);
/** A closing store with no Stripe account (so only the first step runs) and two PayPal sales kept. */
async function closingStore(handle: string): Promise<{ store: Store; buyers: string[] }> {
  made += 1;
  const owner = `${handle}@example.com`;
  await claimHandle(owner, handle, `PayPal ${made}`, "");
  const keyed = await ensureStatsId(owner);
  const shop = keyed ?? (await storeForEmail(owner));
  if (!shop?.statsId) throw new Error("the test store was not made");
  const store: Store = { ...shop, stripeAccountId: null };
  await startClosingCredit(await storeFolder(storeRef(store)), 100);
  const buyers = [`one.${handle}@example.com`, `two.${handle}@example.com`];
  for (const [i, email] of buyers.entries()) {
    const order = orderOf(handle, i);
    await redis.pipeline([
      ["ZADD", `nl:ppsell:sales:${store.statsId}`, String(1000 + i), order],
      ["SET", `nl:ppsell:paid:${order}`, JSON.stringify({ store: store.statsId, order, capture: `CAP${order}`, email, product: "p1", cents: 1900, currency: "usd", at: 1000 + i })],
    ]);
  }
  return { store, buyers };
}

const run = async (store: Store, day = DAY, after = ""): Promise<Told | "rejected"> => {
  try {
    return await tellBuyers(store, E, day, after, Date.now() + 60_000);
  } catch {
    return "rejected";
  }
};
const count = (email: string) => sent.filter((to) => to === email).length;

/** Runs `body` with every MGET of PayPal sale records answered with one slot too few. */
async function withShortMget<T>(body: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    return commands.map((c, i) => (c[0] === "MGET" && String(c[1] ?? "").startsWith("nl:ppsell:paid:") && Array.isArray(replies[i]) ? (replies[i] as unknown[]).slice(1) : replies[i]));
  }) as typeof redis.pipeline;
  try {
    return await body();
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.COMPANY_POSTAL_ADDRESS = "1 Test Street, Testville, DE 19901, USA";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

  part("Control: a healthy PayPal reading tells each PayPal buyer once and moves on");
  const healthy = await closingStore("ppok");
  const told = await run(healthy.store);
  is("the first step is done", told === "rejected" ? told : told.after, "start");
  is("each PayPal buyer told once", healthy.buyers.map(count), [1, 1]);

  part("The PayPal records answered out of shape: not done, nobody left out for good");
  const faulty = await closingStore("ppbad");
  const first = await withShortMget(() => run(faulty.store));
  is("the first step is not marked done, and the store's notice is not done", first === "rejected" || (first.after !== "start" && !first.done), true);
  const again = await run(faulty.store);
  is("asked again with Redis healthy: done", again === "rejected" ? again : again.after, "start");
  is("each PayPal buyer told, exactly once", faulty.buyers.map(count), [1, 1]);

  part("One PayPal record out of shape while the full notice can still be given: the readable buyer is told, the step waits (Codex X5 on #4236)");
  // Days relative to the clock, so the window does not move under the test: the closing a month off.
  const soon = Date.now() + 30 * 86_400_000;
  const mixed = await closingStore("ppmix");
  const order = [orderOf("ppmix", 1)];
  const kept = (await redis.pipeline([["GET", `nl:ppsell:paid:${order[0]}`]]))[0] as string;
  await redis.pipeline([["SET", `nl:ppsell:paid:${order[0]}`, "{not json"]]);
  const firstMixed = await run(mixed.store, soon);
  is("the first step is not marked done", firstMixed === "rejected" ? firstMixed : [firstMixed.after, firstMixed.done], ["", false]);
  is("the readable buyer is told now, the other not yet", mixed.buyers.map(count), [1, 0]);
  await redis.pipeline([["SET", `nl:ppsell:paid:${order[0]}`, kept]]);
  const restored = await run(mixed.store, soon);
  is("asked again with the record back: done", restored === "rejected" ? restored : restored.after, "start");
  is("both PayPal buyers told, each exactly once", mixed.buyers.map(count), [1, 1]);

  part("Still out of shape once the full notice can no longer wait: the readable buyer is told, the rest counted untold, and the closing goes on");
  const late = await closingStore("pplate");
  const lateOrder = [orderOf("pplate", 1)];
  await redis.pipeline([["SET", `nl:ppsell:paid:${lateOrder[0]}`, "{not json"]]);
  const near = Date.now() + 3 * 86_400_000;
  const lateRun = await run(late.store, near);
  is("the first step is done, one untold counted", lateRun === "rejected" ? lateRun : [lateRun.after, lateRun.untold], ["start", 1]);
  is("the readable buyer told once", late.buyers.map(count), [1, 0]);
  const lateAgain = await run(late.store, near, "");
  is("counted once however often it is asked", lateAgain === "rejected" ? lateAgain : lateAgain.untold, 0);

  done();
}

main();
