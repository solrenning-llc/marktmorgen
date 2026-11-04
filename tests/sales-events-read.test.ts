/**
 * C4-36 (B), inbox C4-41 (a), (b), (c), (e): reading what changed since a kept
 * reading (lib/sales-events-read.ts), against a stand-in Stripe and the
 * in-memory database; nothing real.
 *
 * What fails here:
 *   - events read from fewer pages than Stripe has, or a list cut short taken
 *     as whole (it must answer null, so the caller reads the whole);
 *   - an error, a page that does not read or an event without its object
 *     taken as no change;
 *   - a kept reading older than a day brought up to date;
 *   - types asked other than the ones read, more than Stripe's 20, or a window
 *     that starts after the kept reading.
 */
process.env.STRIPE_SECRET_KEY = "sk_test_sales_events_read_only";
import { EVENTS_MAX_AGE_MS, EVENTS_OVERLAP_SECONDS, EVENTS_PAGES, readSalesEventsSince } from "@/lib/sales-events-read";
import { SALES_EVENT_TYPE_LIST } from "@/lib/sales-events";
import { done, is, part } from "./check";

const NOW = Date.UTC(2031, 5, 21, 12);
let pages: { data: unknown[]; has_more: boolean }[] = [];
let asked: URL[] = [];
let down = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  asked.push(url);
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (down) return answer({ error: { message: "down" } }, 500);
  if (url.pathname.replace(/^\/v1/, "") !== "/events") return answer({ object: "list", data: [], has_more: false });
  const at = url.searchParams.get("starting_after");
  const index = at ? Number(at.replace(/^evt_p(\d+)_.*$/, "$1")) + 1 : 0;
  return answer({ object: "list", ...(pages[index] ?? { data: [], has_more: false }) });
}) as typeof fetch;

const event = (page: number, i: number, type = "refund.updated") => ({ id: `evt_p${page}_${i}`, object: "event", type, created: Math.floor(NOW / 1000) - i, data: { object: { id: `re_${page}_${i}`, object: "refund", status: "succeeded" } } });
const store = { stripeAccountId: "acct_1TestEvents" };

async function main(): Promise<void> {
  part("Every page, until Stripe says there is no more");
  pages = [{ data: Array.from({ length: 100 }, (_, i) => event(0, i)), has_more: true }, { data: Array.from({ length: 30 }, (_, i) => event(1, i)), has_more: false }];
  asked = [];
  const two = await readSalesEventsSince(store, NOW - 3_600_000, NOW);
  is("two pages read, 130 events", [two?.length, asked.length], [130, 2]);
  const first = asked[0];
  is("the types asked are the types read, at most Stripe's 20", [first.searchParams.getAll("types[]").sort().join(), SALES_EVENT_TYPE_LIST.length <= 20], [[...SALES_EVENT_TYPE_LIST].sort().join(), true]);
  is("from a little before the kept reading", Number(first.searchParams.get("created[gte]")), Math.floor((NOW - 3_600_000) / 1000) - EVENTS_OVERLAP_SECONDS);
  is("every request is the events list", asked.every((u) => u.pathname.endsWith("/events")), true);

  part("Anything short of whole: null, so the whole reading is made");
  pages = Array.from({ length: EVENTS_PAGES + 1 }, (_, p) => ({ data: Array.from({ length: 100 }, (_, i) => event(p, i)), has_more: true }));
  is(`more than ${EVENTS_PAGES} pages`, await readSalesEventsSince(store, NOW - 3_600_000, NOW), null);
  pages = [{ data: [event(0, 0), { id: "evt_p0_bad", object: "event", type: "refund.updated", created: 1, data: {} }], has_more: false }];
  is("an event without its object", await readSalesEventsSince(store, NOW - 3_600_000, NOW), null);
  pages = [{ data: [event(0, 0), event(0, 0)], has_more: false }];
  is("an event twice", await readSalesEventsSince(store, NOW - 3_600_000, NOW), null);
  pages = [{ data: [], has_more: true }];
  is("a page that says there is more but holds nothing", await readSalesEventsSince(store, NOW - 3_600_000, NOW), null);
  down = true;
  is("Stripe not answering", await readSalesEventsSince(store, NOW - 3_600_000, NOW), null);
  down = false;
  asked = [];
  is("a kept reading older than a day: nothing asked", [await readSalesEventsSince(store, NOW - EVENTS_MAX_AGE_MS - 1, NOW), asked.length], [null, 0]);
  is("nor one from the future", await readSalesEventsSince(store, NOW + 1, NOW), null);
  is("a store without Stripe has no events", await readSalesEventsSince({ stripeAccountId: null } as never, NOW - 60_000, NOW), []);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
