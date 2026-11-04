/**
 * C4-36 (B), inbox C4-41: the studio's sales reading (lib/store-readings.ts,
 * keptSales) read whole once a UTC day and brought up to date from Stripe's
 * events after it, against a stand-in Stripe and the in-memory database.
 *
 * What fails here:
 *   - a reading brought up to date whose numbers differ from a whole one's;
 *   - more whole readings in a day than HEAVY_READINGS_PER_DAY, or more brought
 *     up to date than SINCE_READINGS_PER_DAY;
 *   - events that cannot be read taken as no change, instead of the whole
 *     reading (from the day's heavy ones) or the kept numbers shown as such;
 *   - a page that shows the kept numbers reading the kept inputs.
 */
process.env.STRIPE_SECRET_KEY = "sk_test_kept_sales_since_only";
import { isDeepStrictEqual } from "node:util";
import { HEAVY_READINGS_PER_DAY, SINCE_READINGS_PER_DAY, keptSales } from "@/lib/store-readings";
import { readSales } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const T0 = Date.UTC(2031, 5, 21, 0, 30);
const store = { handle: "kiln", previousHandles: [], sid: "s1", currency: "usd", stripeAccountId: "acct_1KeptSince", paypalSeller: null, statsId: "k".repeat(32), catalog: { items: [], head: [], inline: [] } } as unknown as Store;
const sessions = new Map<string, Record<string, unknown>>();
const events: Record<string, unknown>[] = [];
let eventsDown = false;
let listed: string[] = [];
const sec = (ms: number) => Math.floor(ms / 1000);
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  listed.push(path);
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  if (path === "/events") return eventsDown ? answer({ error: { message: "down" } }, 500) : list([...events].reverse());
  if (path === "/checkout/sessions") return list([...sessions.values()].sort((a, b) => (b.created as number) - (a.created as number)));
  return list([]);
}) as typeof fetch;
const checkout = (id: string, at: number, cents: number) => ({
  id, object: "checkout.session", status: "complete", payment_status: "paid", amount_total: cents, currency: "usd", created: sec(at), payment_intent: `pi_${id}`,
  customer_details: { email: `${id}@example.com`, address: { country: "US" } }, metadata: { store: "kiln", product: "p1" },
});
let n = 0;
const sell = (at: number, cents: number) => {
  const c = checkout(`cs_${++n}`, at, cents);
  sessions.set(c.id, c);
  events.push({ id: `evt_${n}`, object: "event", type: "checkout.session.completed", created: sec(at), data: { object: c } });
};
const commandsOf = async <T>(work: () => Promise<T>) => {
  const real = redis.pipeline.bind(redis);
  let bytes = 0;
  (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (batch: (string | number)[][]) => {
    const replies = await real(batch);
    for (const r of replies) if (typeof r === "string") bytes += r.length;
    return replies;
  }) as typeof redis.pipeline;
  try {
    return { value: await work(), bytes };
  } finally {
    (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = real;
  }
};

async function main(): Promise<void> {
  redis.clear();
  for (let i = 0; i < 6; i += 1) sell(T0 - (i + 1) * 86_400_000, 4_900);
  part("The day's first reading is whole");
  listed = [];
  let at = T0;
  const first = await keptSales(store, at);
  is("read whole: the lists, not the events", [listed.includes("/checkout/sessions"), listed.includes("/events")], [true, false]);
  is("its numbers are the whole reading's", isDeepStrictEqual(first.value, await readSales(store, at)), true);

  part("Later ones are brought up to date, the same numbers");
  for (let step = 1; step <= 3; step += 1) {
    at += 15 * 60_000;
    sell(at - 60_000, 1_000 * step);
    listed = [];
    const brought = await keptSales(store, at);
    is(`step ${step}: from the events, not the lists`, [listed.includes("/events"), listed.includes("/checkout/sessions")], [true, false]);
    is(`step ${step}: the same numbers as a whole reading`, isDeepStrictEqual(brought.value, await readSales(store, at)), true);
  }
  is("the day's whole readings stay within their figure", Number(redis.run(["GET", `nl:reading:day:${store.statsId}:2031-06-21:heavy`])) <= HEAVY_READINGS_PER_DAY, true);
  is("and those brought up to date are counted", Number(redis.run(["GET", `nl:reading:day:${store.statsId}:2031-06-21:since`])), 3);

  part("A page that shows the kept numbers reads nothing else");
  const shown = await commandsOf(() => keptSales(store, at + 60_000));
  is("fresh: the kept numbers, and not the kept inputs", [shown.value.at, shown.bytes < 60_000], [at, true]);

  part("Events that cannot be read: never taken as no change");
  at += 15 * 60_000;
  sell(at - 60_000, 7_700);
  eventsDown = true;
  const failed = await keptSales(store, at);
  eventsDown = false;
  is("the day's whole reading used: the kept numbers, said as kept", [failed.stale, failed.at < at], [true, true]);

  part("The next UTC day starts whole again");
  at = Date.UTC(2031, 5, 22, 0, 10);
  listed = [];
  const next = await keptSales(store, at);
  is("read whole", [listed.includes("/checkout/sessions"), isDeepStrictEqual(next.value, await readSales(store, at))], [true, true]);
  is(`the figures: ${HEAVY_READINGS_PER_DAY} whole and ${SINCE_READINGS_PER_DAY} brought up to date a day`, HEAVY_READINGS_PER_DAY + SINCE_READINGS_PER_DAY >= 24, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
