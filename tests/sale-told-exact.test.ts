/**
 * CX-123 rule 24 on lib/sale-events.ts: which paid checkouts were told
 * already is read in its exact shape. Each EXISTS on `nl:sale:told:<id>`
 * answers 0 or 1, one per checkout; anything else (a missing reply, null, a
 * string, a negative or a fraction, a short or a long list, no list at all) is
 * unknown, and noteSales refuses the whole reading with UnknownReplyError:
 * nothing is posted to the team's chat and nothing is written to the store's
 * recent purchases on it. The phone and the email platform keep marks of
 * their own; the chat line and the recent-purchases list have only this one,
 * so an unknown taken as "not told" posted the same sale twice to Slack or
 * Discord and showed it twice on the store's pages.
 *
 * Controls: a confirmed 0 tells once and marks it; a confirmed 1 tells
 * nothing; a checkout refused on an unknown reading waits and is told once on
 * the next exact one.
 */
import { noteSales } from "@/lib/sale-events";
import { setChatAddress } from "@/lib/chat-summary";
import { addProduct, claimHandle, ensureStatsId, setChatSales, setRecentSales, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_sale_told_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "sale-told-owner@example.com";
const SLACK = "https://hooks.slack.com/services/T000/B000/abcdefghijklmnop";
const posted: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "hooks.slack.com") {
    posted.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return new Response("ok", { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

type Commands = (string | number)[][];
const TOLD = "nl:sale:told:";

/** The first EXISTS pipeline on the told marks never reaches Redis; `reply` is all there is. */
async function withToldReply<T>(reply: unknown, run: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  let used = false;
  redis.pipeline = (async (commands: Commands) => {
    if (!used && commands[0]?.[0] === "EXISTS" && String(commands[0]?.[1] ?? "").startsWith(TOLD)) {
      used = true;
      return reply;
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

async function outcome(run: () => Promise<number>): Promise<string> {
  try {
    return `told ${await run()}`;
  } catch (error) {
    return error instanceof Error ? error.name : "thrown";
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "toldshop", "Told Shop", "");
  await ensureStatsId(OWNER);
  const added = await addProduct(OWNER, "Bread course", "", "29", null);
  if (!added.ok) throw new Error("no product");
  await setChatSales(OWNER, true);
  await setRecentSales(OWNER, true);
  const base = (await storeForEmail(OWNER))!;
  const shop = { ...base, stripeAccountId: "acct_test_sale_told" };
  is("the chat address is kept", await setChatAddress(shop.statsId as string, shop.name, SLACK), "saved");
  posted.length = 0;

  const NOW = Math.floor(Date.now() / 1000);
  let n = 0;
  const checkout = () => {
    n += 1;
    return {
      id: `cs_live_${String(n).padStart(24, "a")}`,
      status: "complete",
      payment_status: "paid",
      mode: "payment",
      created: NOW - 60,
      amount_total: 2900,
      currency: "usd",
      payment_intent: `pi_live${n}abcdef`,
      metadata: { store: "toldshop", product: added.product.id },
      customer_details: { email: "buyer@example.com", name: "Dana Buyer", address: { country: "DE" } },
    };
  };
  const listed = async () => ((await redis.pipeline([["LLEN", `nl:recent:${shop.statsId}`]])) as number[])[0];
  const marked = async (id: string) => ((await redis.pipeline([["EXISTS", `${TOLD}${id}`]])) as number[])[0];

  part("Control: a confirmed 0 tells once, a confirmed 1 tells nothing");
  const sold = checkout();
  is("first pass: told once", await outcome(() => noteSales(shop, [sold])), "told 1");
  is("one chat line", posted.length, 1);
  is("one recent purchase", await listed(), 1);
  is("and marked told", await marked(sold.id), 1);
  is("second pass: told nothing", await outcome(() => noteSales(shop, [sold])), "told 0");
  is("still one chat line and one recent purchase", [posted.length, await listed()], [1, 1]);

  part("An already told sale, its mark answered in an unknown shape");
  const unknown: [string, unknown][] = [
    ["no reply in the list", []],
    ["a null reply", [null]],
    ["an undefined reply", [undefined]],
    ["a string one", ["1"]],
    ["a string zero", ["0"]],
    ["an object", [{}]],
    ["a negative", [-1]],
    ["a fraction", [0.5]],
    ["a two", [2]],
    ["NaN", [Number.NaN]],
    ["a list too long", [0, 0]],
    ["no list at all (null)", null],
    ["no list at all (object)", {}],
  ];
  for (const [name, reply] of unknown) {
    const lines = posted.length;
    const kept = await listed();
    is(`${name}: refused as unknown`, await outcome(() => withToldReply(reply, () => noteSales(shop, [sold]))), "UnknownReplyError");
    is(`${name}: no second chat line`, posted.length, lines);
    is(`${name}: no second recent purchase`, await listed(), kept);
  }

  part("Two sales, one mark unknown: the whole reading waits");
  const fresh = checkout();
  const lines = posted.length;
  const kept = await listed();
  is("refused as unknown", await outcome(() => withToldReply([0, null], () => noteSales(shop, [fresh, sold]))), "UnknownReplyError");
  is("nothing posted on it", posted.length, lines);
  is("nothing written on it", await listed(), kept);
  is("the fresh sale is not marked", await marked(fresh.id), 0);

  part("Control: the waiting sale is told once on the next exact reading");
  is("told once", await outcome(() => noteSales(shop, [fresh, sold])), "told 1");
  is("one more chat line", posted.length, lines + 1);
  is("one more recent purchase", await listed(), kept + 1);
  is("and marked told", await marked(fresh.id), 1);

  part("A Redis that fails is refused, as before");
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async () => {
    throw new Error("Redis down");
  }) as typeof redis.pipeline;
  const before = posted.length;
  try {
    is("rejected", await outcome(() => noteSales(shop, [checkout()])), "Error");
  } finally {
    redis.pipeline = real;
  }
  is("nothing posted", posted.length, before);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
