/**
 * Proof (CX-123 rules 24 and 30): lib/buyer-profile.ts reads a PayPal sale's
 * paid record with `readPaid(...).catch(() => null)`. readPaid itself already
 * answers null for a reply in another shape and for text that is not JSON,
 * and the catch turns a thrown read into null too. Null is taken as "no
 * PayPal payment": the sale is shown to the creator as "brought" ("No payment
 * here" on the studio's person page), its money is left out of "Spent with
 * you", and nothing on the page says the read failed (stripeError and partial
 * stay false). The creator is told something false about what a buyer paid.
 */
import { readFileSync } from "node:fs";
import { buyerProfile } from "@/lib/buyer-profile";
import { grantImported, importedKey } from "@/lib/imported-purchases";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsppprofile01";
const ORDER = "5O190127TN3647101";
const paidKey = `nl:ppsell:paid:${ORDER}`;
const NOW = Math.floor(Date.now() / 1000);
const products = [{ id: "guide1", title: "Sourdough Guide", course: null, options: [] }];

const shop = (): Store =>
  ({
    sid: "sidppprof0001",
    handle: "harbor",
    name: "Harbor Kitchen",
    email: "owner@example.com",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    listId: null,
    callsId: null,
    currency: "usd",
    language: "en",
    stripeAccountId: null,
    pastBuyers: true,
    catalog: { id: null, head: [], items: products.map((p) => ({ id: p.id, kind: 0, options: [] })), inline: products },
  }) as unknown as Store;

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

type Seen = { kind: string; cents: number; note: string; paid: number; stripeError: boolean; partial: boolean } | string;

/** What the page would say about the PayPal sale, or that the read could not be done. */
async function seen(store: Store): Promise<Seen> {
  try {
    const profile = await buyerProfile(store, "buyer@example.com");
    const sale = profile.orders.find((o) => o.note === "paypal");
    return { kind: sale?.kind ?? "none", cents: sale?.cents ?? -1, note: sale?.note ?? "", paid: profile.paid, stripeError: profile.stripeError, partial: profile.partial };
  } catch (error) {
    return `refused: ${(error as Error).name}`;
  }
}

/** True when the page tells the creator "no payment here" for a paid PayPal sale, without saying the read failed. */
const falseStatement = (s: Seen) => typeof s !== "string" && s.kind === "brought" && s.paid === 0 && !s.stripeError && !s.partial;

async function main(): Promise<void> {
  redis.clear();
  const store = shop();
  const record = JSON.stringify({ store: STATS, order: ORDER, capture: "3C679366HH908701", email: "buyer@example.com", product: "guide1", cents: 4900, currency: "usd", at: NOW - 3600, handle: "harbor" });
  await grantImported(STATS, `paypal:${ORDER}`, [{ email: "buyer@example.com", productId: "guide1", items: null }], NOW - 3600, store.sid);
  await redis.pipeline([["SET", paidKey, record]]);

  part("Healthy control");
  const healthy = await seen(store);
  is("a PayPal sale, its money counted", healthy, { kind: "sale", cents: 4900, note: "paypal", paid: 4900, stripeError: false, partial: false });

  part("The paid record is not JSON (RED)");
  await redis.pipeline([["SET", paidKey, "{\"store\":\"" + STATS + "\", not json"]]);
  const malformed = await seen(store);
  console.log(`        page: ${JSON.stringify(malformed)}`);
  is("an unknown paid record is never shown as 'No payment here', $0, with no word of a failed read", falseStatement(malformed), false);
  await redis.pipeline([["SET", paidKey, record]]);

  const pipeline = redis.pipeline.bind(redis);
  part("A Redis reply in another shape (RED)");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await pipeline(commands);
    return commands.map((command, i) => (command[0] === "GET" && command[1] === paidKey ? { result: replies[i] } : replies[i]));
  }) as typeof redis.pipeline;
  const shape = await seen(store);
  console.log(`        page: ${JSON.stringify(shape)}`);
  is("an unknown reply is never shown as 'No payment here', $0, with no word of a failed read", falseStatement(shape), false);

  part("The read throws (RED: swallowed by .catch(() => null))");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((command) => command[0] === "GET" && command[1] === paidKey)) throw new Error("Redis did not answer");
    return pipeline(commands);
  }) as typeof redis.pipeline;
  const thrown = await seen(store);
  console.log(`        page: ${JSON.stringify(thrown)}`);
  is("a thrown read is never shown as 'No payment here', $0, with no word of a failed read", falseStatement(thrown), false);
  is("the sale stays an unknown amount (no money counted) and the page warns", thrown, { kind: "brought", cents: 0, note: "paypal", paid: 0, stripeError: false, partial: true });

  part("The handed-over purchases cannot be read");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((command) => command[0] === "HGETALL" && String(command[1]).startsWith(`nl:imp:buy:${STATS}:`))) throw new Error("Redis did not answer");
    return pipeline(commands);
  }) as typeof redis.pipeline;
  const lost = await buyerProfile(store, "buyer@example.com");
  is("a failed read is not 'nothing handed over': the page warns", { orders: lost.orders.length, paid: lost.paid, partial: lost.partial }, { orders: 0, paid: 0, partial: true });
  redis.pipeline = pipeline;

  // Claude 4 on #2908 (LEVE): the record was trusted once its store matched, so a record of this store with an amount
  // that is not a whole number of cents, or a currency that is not a lowercase three-letter code, was counted: a
  // string amount concatenated into "Spent with you", a negative or fractional one counted as money. Each is unknown.
  part("A paid record of this store with fields in another format (RED)");
  const base = JSON.parse(record) as Record<string, unknown>;
  const odd: [string, Record<string, unknown>][] = [
    ["an amount as text", { ...base, cents: "4900" }],
    ["a negative amount", { ...base, cents: -4900 }],
    ["a fractional amount", { ...base, cents: 49.5 }],
    ["no amount", { ...base, cents: undefined }],
    ["a currency in capitals", { ...base, currency: "USD" }],
    ["a currency that is not a code", { ...base, currency: "dollars" }],
    ["no currency", { ...base, currency: undefined }],
    ["a time that is not a whole number of seconds", { ...base, at: "yesterday" }],
  ];
  for (const [label, bad] of odd) {
    await redis.pipeline([["SET", paidKey, JSON.stringify(bad)]]);
    is(`${label}: no money counted, the sale shown without an amount, and the page warns`, await seen(store), { kind: "brought", cents: 0, note: "paypal", paid: 0, stripeError: false, partial: true });
  }
  await redis.pipeline([["SET", paidKey, record]]);
  is("a free PayPal sale (0 cents, whole) is still a sale", await (async () => {
    await redis.pipeline([["SET", paidKey, JSON.stringify({ ...base, cents: 0 })]]);
    const s = await seen(store);
    await redis.pipeline([["SET", paidKey, record]]);
    return s;
  })(), { kind: "sale", cents: 0, note: "paypal", paid: 0, stripeError: false, partial: false });

  // Claude 4 and Claude 6 on #2908 (LEVE): with the handed-over read failed and nothing else read, the page still said
  // "Nothing bought from this store under this address." Unknown is not "nothing": the empty list says the reading is incomplete.
  part("The person page never says 'Nothing bought' when the reading is partial (RED)");
  const page = readFileSync("app/studio/people/page.tsx", "utf8");
  const empty = page.slice(page.indexOf("{!bought ? ("), page.indexOf("Nothing bought from this store under this address."));
  // Rule 23: the RED regex wanted " ?" on the same line; the page is formatted with the "?" on the next line, so any whitespace is read.
  is("the empty list checks partial and Stripe's failure before saying nothing was bought", /profile\.partial \|\| profile\.stripeError\s*\?/.test(empty), true);
  is("and says the list may be incomplete instead", page.includes("Their purchases could not all be read just now, so this list may be missing some."), true);

  // Claude 6 on #2908 (LEVE, comment 6697867589): the record's own order was not checked, yet it keys the payment that
  // is summed into "Spent with you". A record without its order, or one naming another order, collapsed two $49 sales
  // into one $49 payment with no warning. A record that does not name its own order is unknown.
  part("A paid record that does not name its own order (RED)");
  is("a record without its order: no money counted, the sale shown without an amount, and the page warns", await (async () => {
    await redis.pipeline([["SET", paidKey, JSON.stringify({ ...base, order: undefined })]]);
    const s = await seen(store);
    await redis.pipeline([["SET", paidKey, record]]);
    return s;
  })(), { kind: "brought", cents: 0, note: "paypal", paid: 0, stripeError: false, partial: true });
  const ORDER_B = "7XK51290AB1234567";
  const paidKeyB = `nl:ppsell:paid:${ORDER_B}`;
  await grantImported(STATS, `paypal:${ORDER_B}`, [{ email: "buyer@example.com", productId: "guide2", items: null }], NOW - 1800, store.sid);
  await redis.pipeline([["SET", paidKeyB, JSON.stringify({ ...base, product: "guide2", capture: "9D111111AA222222", at: NOW - 1800 })]]);
  const two = await buyerProfile(store, "buyer@example.com");
  const shown = two.orders.filter((o) => o.note === "paypal").map((o) => ({ kind: o.kind, cents: o.cents })).sort((a, b) => a.kind.localeCompare(b.kind));
  is("a second sale whose record names the first order: never two $49 sales summed as $49 with no warning", { shown, paid: two.paid, partial: two.partial }, { shown: [{ kind: "brought", cents: 0 }, { kind: "sale", cents: 4900 }], paid: 4900, partial: true });
  await redis.pipeline([["SET", paidKeyB, JSON.stringify({ ...base, order: ORDER_B, product: "guide2", capture: "9D111111AA222222", at: NOW - 1800 })]]);
  const both = await buyerProfile(store, "buyer@example.com");
  is("with each record naming its own order, both sales are counted", { sales: both.orders.filter((o) => o.kind === "sale").length, paid: both.paid, partial: both.partial }, { sales: 2, paid: 9800, partial: false });
  await redis.pipeline([["DEL", paidKeyB], ["HDEL", importedKey(STATS, "buyer@example.com"), "guide2"]]);

  // Claude 4 (comment 6696369130) and Claude 6 (comment 6697867589) on #2908 (LEVE): with nothing read and the reading
  // partial or Stripe unread, the tiles above the list still said "$0.00", "0" and "nothing bought yet". Unknown is not zero.
  part("The person page tiles never say $0 or 'nothing bought yet' when nothing could be read (RED)");
  const tilesSrc = page.slice(page.indexOf("const tiles = "), page.indexOf("const contact = profile.contact;"));
  is("an unread flag: no order read and the reading partial or Stripe unread", /const unread = !bought && \(profile\.partial \|\| profile\.stripeError\);/.test(page), true);
  const unreadBranch = tilesSrc.slice(tilesSrc.indexOf("unread"), tilesSrc.indexOf(": ["));
  is("the tiles take the unread branch first", /^unread\s*\?\s*\[/.test(unreadBranch), true);
  is("each of the 4 unread tiles shows a dash and says it could not be read", [(unreadBranch.match(/value: "—"/g) ?? []).length, (unreadBranch.match(/could not be read/g) ?? []).length], [4, 4]);
  is("no amount, count or 'nothing bought yet' in the unread tiles", /money\(|String\(profile|nothing bought yet/.test(unreadBranch), false);

  part("Control after the failures");
  is("the healthy sale is read again, nothing flagged", await seen(store), { kind: "sale", cents: 4900, note: "paypal", paid: 4900, stripeError: false, partial: false });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
