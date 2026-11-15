/**
 * Asking the store's numbers (lib/numbers-ask.ts; added 12 October 2026).
 * Checked:
 *
 *   - the model is handed what the Numbers panel shows, money written as the
 *     creator reads it, channels by their names, and nothing about a buyer;
 *   - a figure the answer names is shown only if it is in those numbers;
 *   - the answer says which days and which part of the panel to open;
 *   - each question is one of the month's AI jobs, retained when no answer
 *     comes; the weekly summary is one too, and the email goes without it
 *     when none is left.
 */
import { figureIn, numbersContext, askNumbers, weeklySummary } from "@/lib/numbers-ask";
import { aiLeft } from "@/lib/ai";
import type { StatsData } from "@/lib/stats";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { windowId } from "@/lib/allowance-window";

let reply: string | null = null;
const prompts: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.anthropic.com") {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    prompts.push(body.messages[0].content);
    if (reply === null) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const window = (visitors: number, checkouts: number, sales: number, cents: number) => ({ visitors, views: visitors * 2, checkouts, sales, cents });
const data = {
  currency: "usd",
  sales: "ok",
  totals: { d7: window(120, 9, 3, 8100), d30: window(480, 30, 11, 45000), d90: window(1300, 80, 30, 120000), all: window(2000, 100, 0, 0) },
  previous: { d7: { visitors: 90, views: 180, checkouts: 6, sales: 2, cents: 5400 }, d30: { visitors: 400, views: 800, checkouts: 20, sales: 8, cents: 30000 }, d90: { visitors: 1000, views: 2000, checkouts: 60, sales: 20, cents: 90000 } },
  channels: {
    d7: [{ source: "instagram", visits: 80, checkouts: 6, free: 2, sales: 2, cents: 5400 }],
    d30: [
      { source: "instagram", visits: 300, checkouts: 18, free: 5, sales: 7, cents: 31500 },
      { source: "youtube", visits: 120, checkouts: 9, free: 1, sales: 4, cents: 13500 },
    ],
    d90: [],
  },
  products: [{ id: "p1", title: "Bread School", d7: { views: 100, checkouts: 9, sales: 3, cents: 8100 }, d30: { views: 400, checkouts: 30, sales: 11, cents: 45000 }, d90: { views: 1000, checkouts: 80, sales: 30, cents: 120000 }, all: { views: 0, checkouts: 0, sales: 0, cents: 0 } }],
  posts: { d7: [], d30: [], d90: [] },
  ads: { d7: [], d30: [], d90: [] },
  countries: { d7: [], d30: [{ name: "US", visits: 600 }], d90: [], all: [] },
  devices: { d7: [], d30: [], d90: [], all: [] },
  renewals: null,
  buyers: { d7: { buyers: 3, orders: 3, cents: 8100, returning: 1, repeat: 0 }, d30: { buyers: 10, orders: 11, cents: 45000, returning: 2, repeat: 1 }, d90: { buyers: 25, orders: 30, cents: 120000, returning: 4, repeat: 2 } },
  searchMisses: { d7: [], d30: [], d90: [] },
  topBuyers: [{ email: "ana@example.com", cents: 9000, orders: 2, last: 0, reference: "cs_x" }],
} as unknown as StatsData;

async function main(): Promise<void> {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  redis.clear();

  part("What the model is handed");
  const context = JSON.stringify(numbersContext(data));
  is("money as the creator reads it, channels by name", [context.includes('"revenue":"$450.00"') || context.includes('"revenue":"$450"'), context.includes('"channel":"Instagram"')], [true, true]);
  is("nothing about any buyer", context.includes("@example.com"), false);
  is("a figure is found only as given", [figureIn(context, "480"), figureIn(context, "481"), figureIn(context, "Instagram"), figureIn(context, "$999.00")], [true, false, true, false]);

  const variants = { ...data, ads: { d7: [], d30: [{ content: "variant-a", campaign: "launch", source: "google", cents: 12345, sales: 2 }], d90: [] } };
  is("complete variant amount reaches assistant", JSON.stringify(numbersContext(variants)).includes("variant-a"), true);
  is("partial variant amount withheld", JSON.stringify(numbersContext({ ...variants, partial: true })).includes("variant-a"), false);

  const owner = "owner@example.com";
  await claimHandle(owner, "numshop", "Num Shop", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_Num0001", subscriptionId: "sub_Num0001", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const before = await aiLeft(store);

  part("A question");
  const money = (numbersContext(data).last_30_days as { channels: { revenue: string }[] }).channels[0].revenue;
  reply = JSON.stringify({
    answer: `Instagram brought the most money in the last 30 days: ${money} from 7 sales.`,
    used: [{ label: "Instagram revenue", value: money }, { label: "Instagram sales", value: 7 }, { label: "Made up", value: "$9,999.00" }],
    window: "d30",
    section: "channels",
  });
  const asked = await askNumbers(store, "Which channel brought the most money this month?", data);
  is("answered, with only the figures that are in the numbers", asked.ok ? [asked.value.used.map((u) => u.value), asked.value.window, asked.value.section] : asked, [[money, "7"], "d30", "channels"]);
  is("one of the month's jobs", await aiLeft(store), before - 1);
  is("the question and the numbers reached the model", prompts.at(-1)?.includes("Which channel brought the most money") && prompts.at(-1)?.includes('"last_30_days"'), true);

  reply = JSON.stringify({ answer: "Something", used: [], window: "d365", section: "everything" });
  const odd = await askNumbers(store, "How are things?", data);
  is("a window or part the panel does not have becomes 30 days and none", odd.ok ? [odd.value.window, odd.value.section] : odd, ["d30", ""]);

  reply = null;
  const failed = await askNumbers(store, "How are things?", data);
  is("no answer: the started attempt stays counted", [failed.ok, await aiLeft(store)], [false, before - 3]);

  part("The weekly summary");
  reply = "Visitors rose to 120 from 90. Instagram brought most of the money.";
  is("a few sentences from the same numbers", await weeklySummary(store, data), "Visitors rose to 120 from 90. Instagram brought most of the money.");
  await redis.pipeline([["SET", `nl:ai:${store.statsId}:${windowId(store)}`, "999999"]]);
  is("none left: the email goes without it", await weeklySummary(store, data), null);

  part("Discounts on sales paid in another currency (LOW 2 of #4576)");
  const elsewhere = numbersContext({ ...data, discounts: { rows: null, refundsRead: false, elsewhere: [{ currency: "eur", sales: 2, cents: 9000, discounted: 1, off: 500 }] } } as StatsData);
  is("each other currency on its own line, never added to the store's", elsewhere.discounts_other_currencies_last_90_days, [{ currency: "EUR", sales: 2, revenue: "€90.00", discounted_sales: 1, given_off: "€5.00" }]);
  is("none when there are none", numbersContext({ ...data, discounts: { rows: null, refundsRead: false, elsewhere: [] } } as StatsData).discounts_other_currencies_last_90_days, undefined);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
