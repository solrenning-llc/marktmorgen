/**
 * 624 [SZ8](23), the three MEDIUMs of Codex G2 on #1928, checked on the code:
 *
 *   1. the builder shows a short link only on an answer that confirms the
 *      very link asked for (2xx, ok exactly true, one link with this name, a
 *      code of the right shape and this cart: these products in this order
 *      and this code); a refusal is believed only when it says so in full,
 *      and anything else says it is not known, never "made";
 *   2. an answer is read against what was asked when it was sent (the screen
 *      keeps the short link with what it was made for and shows it only
 *      while it still asks for the same);
 *   3. the builder's products are chosen from the index without a read, at
 *      most CART_LINK_CHOICES, and the listings not already in the store
 *      record are weighed and paid for in studio requests before any is
 *      read; refused, nothing is read and nothing is offered.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CartLinkBuilder, SHORT_UNCONFIRMED, confirmedCartLink, shortLinkProblem } from "@/components/cart-link-builder";
import { CART_LINK_CHOICES, CART_LINK_UNIT_BYTES, CART_LINK_UNIT_COMMANDS, cartLinkCandidates, cartLinkProducts, cartLinkUnits } from "@/lib/cart-link-products";
import { MAX_PRODUCT_BYTES, productIds } from "@/lib/catalog";
import { addDraftProducts, claimHandle, ensureStatsId, setProductHidden, setSubscription, storeForEmail } from "@/lib/store";
import { countStudio } from "@/lib/studio-route";
import { paidPeriod } from "./billing-period-fixture";
import { listingKeysRead, listingValues } from "./listing-reads";
import { store as redis } from "./redis-stub";

globalThis.fetch = async () => {
  throw new Error("No external service in this test");
};

const ask = { name: "october-reel", place: "instagram", ids: ["aaaaaa", "bbbbbb"], code: "" };
const answer = (target: unknown, more: Record<string, unknown> = {}) => ({ ok: true, links: [{ code: "abc234", name: "october-reel", place: "instagram", made: 1, target, ...more }] });

test("MEDIUM 1: a short link is shown only on a full confirmation of the link asked for", () => {
  const cart = { kind: "cart", ids: ["aaaaaa", "bbbbbb"] };
  assert.equal(confirmedCartLink(200, answer(cart), ask), "abc234");
  assert.equal(confirmedCartLink(201, answer({ ...cart, code: "SPRING" }), { ...ask, code: "SPRING" }), "abc234");
  const unconfirmed: [string, number, unknown, typeof ask][] = [
    ["an error status", 500, answer(cart), ask],
    ["ok not exactly true", 200, { ...answer(cart), ok: "true" }, ask],
    ["no list", 200, { ok: true, links: null }, ask],
    ["a target without its products", 200, answer({ kind: "cart" }), ask],
    ["the products in another order", 200, answer({ kind: "cart", ids: ["bbbbbb", "aaaaaa"] }), ask],
    ["another product", 200, answer({ kind: "cart", ids: ["aaaaaa", "cccccc"] }), ask],
    ["no code where one was asked", 200, answer(cart), { ...ask, code: "SPRING" }],
    ["a code where none was asked", 200, answer({ ...cart, code: "SPRING" }), ask],
    ["another post's name", 200, answer(cart, { name: "november-reel" }), ask],
    ["a code of the wrong shape", 200, answer(cart, { code: "ABC-234" }), ask],
    ["not a cart", 200, answer({ kind: "store" }), ask],
    ["two links that both match", 200, { ok: true, links: [...answer(cart).links, ...answer(cart).links] }, ask],
    ["not JSON", 200, null, ask],
  ];
  for (const [label, status, data, asked] of unconfirmed) assert.equal(confirmedCartLink(status, data, asked), null, label);
});

test("MEDIUM 1: a refusal is believed only in full; everything else is not known", () => {
  assert.match(shortLinkProblem(409, { ok: false, error: "taken" }), /already has that name/);
  assert.match(shortLinkProblem(400, { ok: false, error: "target" }), /not on your store anymore/);
  for (const [status, data] of [
    [500, { ok: false, error: "taken" }],
    [200, { ok: false, error: "taken" }],
    [409, { ok: "false", error: "taken" }],
    [409, { ok: false, error: "toString" }],
    [500, { ok: true, links: [] }],
    [502, null],
  ] as [number, unknown][])
    assert.equal(shortLinkProblem(status, data), SHORT_UNCONFIRMED, JSON.stringify([status, data]));
  assert.doesNotMatch(SHORT_UNCONFIRMED, /^The short link was made/i);
  assert.doesNotMatch(SHORT_UNCONFIRMED, /try again/i);
  assert.match(shortLinkProblem(403, { ok: false, error: "role" }), /Your role/);
  assert.match(shortLinkProblem(429, { ok: false, error: "studio_used" }), /was not made/);
});

test("MEDIUM 2: an answer is read against what was asked when it was sent", () => {
  const builder = readFileSync("components/cart-link-builder.tsx", "utf8");
  // The request is built from a copy fixed before it is sent, and the answer is checked against that copy.
  assert.ok(builder.includes("const ask: CartLinkAsk = { name, place, ids: [...picked], code: code.trim().toUpperCase() };"));
  assert.ok(builder.includes("confirmedCartLink(response.status, data, ask)"));
  // The link is shown only while the screen still asks for the same; otherwise a note without the address.
  assert.ok(builder.includes("short.ask.name === linkName(post) && short.ask.place === place && short.ask.code === typed && sameIds(short.ask.ids, picked) ? short.url : null"));
  assert.ok(builder.includes("The short link you made is for your earlier choice, and it is under Short links. Make another for this one."));
});

test("the builder says when only the first products are listed", () => {
  const products = [
    { id: "aaaaaa", title: "Product A" },
    { id: "bbbbbb", title: "Product B" },
  ];
  assert.ok(renderToStaticMarkup(createElement(CartLinkBuilder, { address: "https://example.test/@s", products, more: CART_LINK_CHOICES })).includes(`Only the first ${CART_LINK_CHOICES} products of your store, in its order, are listed here.`));
  assert.ok(!renderToStaticMarkup(createElement(CartLinkBuilder, { address: "https://example.test/@s", products })).includes("Only the first"));
});

test("MEDIUM 3: a studio request's shape is the cost registry's", () => {
  const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
  // The registry's studio request: the same base of commands and bytes, with the take and whatever else each request
  // also sends (main added LOCKED_UNTIL_STAR_COMMANDS).
  const bytes = CART_LINK_UNIT_BYTES.toLocaleString("en-US").replace(/,/g, "_");
  assert.ok(new RegExp(`studio: request\\("studio", ${CART_LINK_UNIT_COMMANDS} \\+ TAKE_COMMANDS( \\+ [A-Z_]+)*, ${bytes}\\),`).test(registry));
  assert.equal(cartLinkUnits(1, 1), 1);
  assert.equal(cartLinkUnits(24, 24 * MAX_PRODUCT_BYTES), Math.ceil((24 * MAX_PRODUCT_BYTES) / CART_LINK_UNIT_BYTES));
  assert.equal(cartLinkUnits(40, 0), 3);
});

type Watch = { reads: number; bytes: number; debits: number[]; paidBeforeFirst: number | null; weighs: number };

/** Watches the stand-in Redis: listing reads, their bytes, studio debits, and what was paid before the first listing read. */
function watch(hmget?: (batch: (string | number)[][]) => unknown[] | null): { seen: Watch; stop: () => void } {
  const base = redis.pipeline.bind(redis);
  const seen: Watch = { reads: 0, bytes: 0, debits: [], paidBeforeFirst: null, weighs: 0 };
  redis.pipeline = async (batch) => {
    if (batch.some((c) => listingKeysRead(c).length > 0) && seen.paidBeforeFirst === null) seen.paidBeforeFirst = seen.debits.reduce((a, b) => a + b, 0);
    if (batch.some((c) => c[0] === "HMGET" && /^nl:data:/.test(String(c[1])))) {
      seen.weighs += 1;
      const forced = hmget?.(batch as (string | number)[][]);
      if (forced) return forced;
    }
    const answers = await base(batch);
    batch.forEach((c) => {
      if (c[0] === "INCRBY" && String(c[1]).includes(":studio:")) seen.debits.push(Number(c[2]));
    });
    // Each listing record read, alone or in an MGET (lib/catalog.ts getMany), and the bytes it answered.
    for (const read of listingValues(batch, answers)) {
      seen.reads += 1;
      seen.bytes += Buffer.byteLength(String(read.value));
    }
    return answers;
  };
  return { seen, stop: () => (redis.pipeline = base) };
}

/** A paying store whose first page is free products and whose paid ones lie past it, so listing them needs reads. */
async function storeWithPaidPastTheHead(email: string, handle: string, paid: number, tier: "pro" | null = "pro") {
  await claimHandle(email, handle, "Synthetic store", "");
  await ensureStatsId(email);
  if (tier) await setSubscription(email, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier, period: paidPeriod() });
  const free = Array.from({ length: 30 }, (_, i) => ({ title: `Free ${i}`, summary: "", priceCents: 0, link: "https://example.test/free" }));
  const sold = Array.from({ length: paid }, (_, i) => ({ title: `Guide ${i} ${"€".repeat(70)}`, summary: "€".repeat(300), priceCents: 1900, link: "https://example.test/guide" }));
  assert.equal((await addDraftProducts(email, [...free, ...sold])).ok, true);
  for (const id of productIds((await storeForEmail(email))!)) assert.equal((await setProductHidden(email, id, false)).ok, true);
  return (await storeForEmail(email))!;
}

test("MEDIUM 3: listings past the head are weighed and paid for before any is read, and at most CART_LINK_CHOICES", async () => {
  redis.clear();
  const shop = await storeWithPaidPastTheHead("cart-link-paid@example.test", "cart-link-paid", 40);
  assert.equal(cartLinkCandidates(shop).length, 40);
  const { seen, stop } = watch();
  try {
    const listed = await cartLinkProducts(shop);
    assert.equal(listed.length, CART_LINK_CHOICES);
    assert.ok(seen.reads > 0 && seen.reads <= CART_LINK_CHOICES, `reads ${seen.reads}`);
    assert.equal(seen.weighs, 1);
    assert.ok(seen.paidBeforeFirst !== null && seen.paidBeforeFirst > 0, "paid before the first read");
    assert.ok(seen.bytes <= CART_LINK_UNIT_BYTES * seen.paidBeforeFirst!, JSON.stringify(seen));
  } finally {
    stop();
  }
});

test("MEDIUM 3: a weight Redis did not answer exactly is the ceiling", async () => {
  redis.clear();
  const shop = await storeWithPaidPastTheHead("cart-link-unknown@example.test", "cart-link-unknown", 3);
  const { seen, stop } = watch(() => [null]);
  try {
    await cartLinkProducts(shop);
    const needed = shop.catalog.items.filter((item) => cartLinkCandidates(shop).includes(item.id) && !shop.catalog.head.some((l) => l.id === item.id)).length;
    assert.ok(needed > 0);
    assert.deepEqual(seen.debits, [cartLinkUnits(needed, needed * MAX_PRODUCT_BYTES)]);
  } finally {
    stop();
  }
});

test("MEDIUM 3: studio requests used up read nothing and offer nothing", async () => {
  redis.clear();
  const shop = await storeWithPaidPastTheHead("cart-link-used@example.test", "cart-link-used", 3, null);
  // A store without a plan has a small figure; take all of it first.
  while ((await countStudio(shop, null, 50)).ok);
  const { seen, stop } = watch();
  try {
    assert.deepEqual(await cartLinkProducts(shop), []);
    assert.equal(seen.reads, 0);
  } finally {
    stop();
  }
});
