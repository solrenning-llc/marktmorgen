/**
 * What counting a limited product's sale costs in billed database commands (Claude 7's MÉDIO on #4472, 14 and 15
 * November 2026: "the sale's extra billed commands have no cost line"; an unknown cost is never zero).
 *
 * Checked against the real lib/stock.ts with the memory Redis (lib/redis-memory.ts), Stripe mocked, nothing real:
 *   - the memory model bills STOCK_SELL's own calls (HDEL, HINCRBY) as Upstash does, so a test can see them;
 *   - a paid order's confirmation on the thanks page, for a cart of MAX_CART limited products, stays inside
 *     STOCK_CONFIRM_COMMANDS_MOST, and that line inside its declared share of an order's compute;
 *   - the thanks page opened again sends one read a product and no script, as main's confirmation did;
 *   - a public page's count of a record still written the old way (a field per sale) sends its one read and no
 *     write at all: the fold of up to 200 scripts a product on every page load is gone, so no page pays for it;
 *   - such a sale is folded by its own checkout's confirmation, once, the count unchanged.
 */
import { parseProduct } from "@/lib/catalog";
import { MAX_CART } from "@/lib/cart-rules";
import { confirmCartStock, confirmStock, STOCK_SELL, stockLeft } from "@/lib/stock";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import {
  CART_STOCK_SHARE_OF_ORDER_COMPUTE,
  COMMAND,
  CONTACT_SHARE_OF_ORDER_COMPUTE,
  ORDER_COMPUTE,
  STOCK_CONFIRM_COMMANDS_MOST,
  STOCK_CONFIRM_SHARE_OF_ORDER_COMPUTE,
  STOCK_SELL_COMMANDS,
} from "./plan-cost-registry";

const creator = { statsId: "q".repeat(32), stripeAccountId: "acct_test_stocksellcost" } as Store;
const limited = (id: string, stock: number) => parseProduct({ id, title: `Print ${id}`, summary: "", priceCents: 2000, stock, link: `https://example.com/${id}` }) as Listing;
const key = (id: string) => `nl:stock:${creator.statsId}:${id}`;
const session = (i: number) => `cs_live_b2${String(i).padStart(56, "0")}`;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const one = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  if (url.hostname === "api.stripe.com" && one) return new Response(JSON.stringify({ id: one[1], status: "expired" }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

/** Every command a pipeline sends, plus the calls the memory model runs inside a script: what Upstash bills. */
async function billed<T>(work: () => Promise<T>): Promise<{ commands: number; writes: string[]; value: T }> {
  const original = redis.pipeline;
  let commands = 0;
  const writes: string[] = [];
  redis.pipeline = async (batch) => {
    for (const command of batch) {
      commands += 1;
      if (command[0] !== "HGETALL" && command[0] !== "HGET" && command[0] !== "HEXISTS") writes.push(String(command[0]));
    }
    return original(batch);
  };
  const before = redis.scriptCalls;
  try {
    const value = await work();
    return { commands: commands + (redis.scriptCalls - before), writes, value };
  } finally {
    redis.pipeline = original;
  }
}

async function hold(id: string, i: number): Promise<void> {
  await redis.pipeline([["HSET", key(id), session(i), JSON.stringify({ until: Date.now() + 30 * 60_000 })]]);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_only";

  part("The memory model bills STOCK_SELL's own calls");
  await hold("sx_one", 1);
  const counted = await billed(() => redis.pipeline([["EVAL", STOCK_SELL, 1, key("sx_one"), session(1)]]));
  is("a unit counted: the EVAL and its HDEL and HINCRBY", [counted.value, counted.commands], [[1], STOCK_SELL_COMMANDS]);
  const again = await billed(() => redis.pipeline([["EVAL", STOCK_SELL, 1, key("sx_one"), session(1)]]));
  is("told again: the EVAL and its HDEL, nothing counted", [again.value, again.commands], [[0], 2]);

  part("A paid order's confirmation at its worst: a cart of MAX_CART limited products");
  const cart = Array.from({ length: MAX_CART }, (_, i) => limited(`sx_cart${i}`, 5));
  for (const product of cart) await hold(product.id, 2);
  // The thanks page: the product bought first, then the cart's others (app/[handle]/thanks/page.tsx).
  const first = await billed(async () => {
    await confirmStock(creator, cart[0], session(2));
    await confirmCartStock(creator, cart.slice(1), session(2));
  });
  is("every unit counted once", await Promise.all(cart.map((product) => stockLeft(creator, product))), cart.map(() => 4));
  is("its commands stay inside STOCK_CONFIRM_COMMANDS_MOST", first.commands <= STOCK_CONFIRM_COMMANDS_MOST, true);
  is("that line stays inside its share of an order's compute", STOCK_CONFIRM_COMMANDS_MOST * COMMAND <= STOCK_CONFIRM_SHARE_OF_ORDER_COMPUTE * ORDER_COMPUTE, true);
  is("and the order's declared shares stay inside one order's compute", CART_STOCK_SHARE_OF_ORDER_COMPUTE + STOCK_CONFIRM_SHARE_OF_ORDER_COMPUTE + CONTACT_SHARE_OF_ORDER_COMPUTE <= 1, true);
  console.log(`  (measured: ${first.commands} commands for ${MAX_CART} limited products; declared ${STOCK_CONFIRM_COMMANDS_MOST})`);

  part("The thanks page opened again");
  const reopened = await billed(async () => {
    await confirmStock(creator, cart[0], session(2));
    await confirmCartStock(creator, cart.slice(1), session(2));
  });
  is("one read a product and no script, as main's confirmation (HEXISTS) did", [reopened.commands, reopened.writes], [MAX_CART, []]);
  is("and nothing more counted", await Promise.all(cart.map((product) => stockLeft(creator, product))), cart.map(() => 4));

  part("A public page's count of a record written the old way");
  const old = limited("sx_old", 1_000);
  const writes: (string | number)[][] = [];
  for (let i = 0; i < 250; i += 1) writes.push(["HSET", key("sx_old"), session(100 + i), JSON.stringify({ until: 0, paid: true })]);
  await redis.pipeline(writes);
  const page = await billed(() => stockLeft(creator, old));
  is("the count is right", page.value, 750);
  is("the page sends its one read and no write: no fold paid by a page load", [page.commands, page.writes], [1, []]);
  const cartRead = await billed(() => Promise.all(Array.from({ length: MAX_CART }, () => stockLeft(creator, old))));
  is("an open cart of MAX_CART such products: one read each, as its line prices", [cartRead.commands, cartRead.writes], [MAX_CART, []]);

  part("A sale written the old way is folded by its own checkout's confirmation, once");
  const fold = await billed(() => confirmStock(creator, old, session(100)));
  is("the count is unchanged", await stockLeft(creator, old), 750);
  is("its field let go and counted in #sold", (await redis.pipeline([["HGET", key("sx_old"), session(100)], ["HGET", key("sx_old"), "#sold"]])) as unknown[], [null, "1"]);
  is("inside the order's own confirmation (one read and one STOCK_SELL)", fold.commands, 1 + STOCK_SELL_COMMANDS);

  done();
}

void main();
