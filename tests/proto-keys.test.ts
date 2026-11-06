/**
 * Words from outside the server used as the keys of a plain object (rule 30, after #2856's mail-revenue fix).
 *
 * A utm_source is typed by whoever writes a link, lowered and kept to [a-z0-9._-], so "__proto__" and
 * "constructor" both pass; a product id in a sale's metadata comes from the creator's own Stripe account. On a
 * plain `{}` such a key is no own key at all: `obj["constructor"]` is Object itself, and `obj["__proto__"] = x`
 * swaps the object's prototype instead of storing x. Each test below asks for the tag to be an ordinary own key of
 * the answer and for nothing shared (Object.prototype, the Object function) to be written.
 *
 * Fixed here: lib/source-rules.ts (sourceAlias), lib/also-bought.ts, lib/next-bought.ts.
 * Proved but not fixed, because the file is held by an open pull request: those tests are marked `todo`, so they
 * report without failing the run, and turn green once the holder applies the same pattern.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifySource, sourceAlias } from "@/lib/source-rules";
import { cameFrom } from "@/lib/came-from";
import { channelOfRequest, touchFrom } from "@/lib/visit-channel";
import { parseTogether, togetherFrom } from "@/lib/also-bought";
import { parsePaths, pathsFrom } from "@/lib/next-bought";
import { readDepth } from "@/lib/page-depth";
import { shareProblem } from "@/lib/partner-share";
import { readAllTimeSales, readSales, renewalsFrom } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

const TAGS = ["__proto__", "constructor"] as const;
const HOST = "marktmorgen.com";
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";

/** The value a key holds as the object's own data, never one found up its prototype chain. */
const own = (record: object, key: string): unknown => Object.getOwnPropertyDescriptor(record, key)?.value;

/** Nothing shared was written: no stray field on Object.prototype nor on the Object function. */
function nothingShared(fields: string[]): void {
  for (const field of fields) {
    assert.equal(Object.hasOwn(Object.prototype, field), false, `Object.prototype.${field} was written`);
    assert.equal(Object.hasOwn(Object, field), false, `Object.${field} was written`);
  }
}

/** Takes back whatever a failing proof wrote, so it never leaks into the next test. */
function cleanShared(fields: string[]): void {
  for (const field of fields) {
    delete (Object.prototype as Record<string, unknown>)[field];
    delete (Object as unknown as Record<string, unknown>)[field];
  }
}

// ---- lib/source-rules.ts: a visitor's utm_source ---------------------------------------------------------------

for (const tag of TAGS) {
  test(`a utm_source "${tag}" is counted under its own word, and a store page opened with it still has a channel`, () => {
    const link = `https://${HOST}/@harbor?utm_source=${tag}`;
    assert.equal(sourceAlias(tag), tag);
    assert.equal(classifySource({ referrer: "", utm: tag, userAgent: BROWSER, ownHost: HOST }), tag);
    assert.equal(cameFrom(link, HOST).source, tag);
    // proxy.ts reads this on every store page: before, it threw (".trim is not a function") and the page failed.
    assert.deepEqual(touchFrom({ url: new URL(link), referrer: "", userAgent: BROWSER, ownHost: HOST }), { source: tag, medium: "", campaign: "", content: "" });
    // And the checkout's metadata names the channel instead of carrying Object or Object.prototype.
    const meta = channelOfRequest({ headers: new Headers({ referer: link }), cookies: { get: () => undefined } }, "harbor", HOST);
    assert.deepEqual([own(meta, "channel"), own(meta, "channel_first")], [tag, tag]);
  });
}

test("the assistants' and Meta's own tags still count under their usual word", () => {
  assert.deepEqual(["fb", "ig", "chatgpt.com", "openai", "youtube"].map(sourceAlias), ["facebook", "instagram", "chatgpt", "chatgpt", "youtube"]);
  assert.equal(classifySource({ referrer: "", utm: "IG", userAgent: BROWSER, ownHost: HOST }), "instagram");
  assert.equal(cameFrom(`https://${HOST}/@harbor?utm_source=claude.ai`, HOST).source, "claude");
});

// ---- lib/also-bought.ts and lib/next-bought.ts: product ids from a sale's metadata --------------------------------

const DAY_MS = 86_400_000;
const START = Date.UTC(2026, 9, 1, 12);
let session = 0;
const sale = (buyer: string, product: string, created: number, bump = "") => ({
  created,
  product,
  upsell: false,
  row: { id: `cs_proto_${++session}`, customer_details: { email: `${buyer}@example.com` }, metadata: { product, ...(bump ? { bump } : {}) } },
});

for (const tag of TAGS) {
  test(`a product id "${tag}" bought together is its own row of what was bought together`, () => {
    const together = togetherFrom(["ana", "ben", "cy"].map((buyer) => sale(buyer, tag, START, "lists")));
    assert.equal(Object.getPrototypeOf(together), Object.prototype);
    assert.deepEqual(Object.keys(together).sort(), [tag, "lists"].sort());
    assert.deepEqual(own(together, tag), [["lists", 3]]);
    assert.deepEqual(own(together, "lists"), [[tag, 3]]);

    const kept = parseTogether(JSON.parse(JSON.stringify({ [tag]: [["lists", 3]], lists: [[tag, 3]] })));
    assert.equal(Object.getPrototypeOf(kept), Object.prototype);
    assert.deepEqual(own(kept, tag), [["lists", 3]]);
    nothingShared(["lists", "0"]);
  });

  test(`a product id "${tag}" bought first is counted as a first purchase, and what came after it is its own path`, () => {
    const sales = ["ana", "ben", "cy"].flatMap((buyer) => [sale(buyer, tag, START), sale(buyer, "course", START + 10 * DAY_MS)]);
    const paths = pathsFrom(sales, START + 20 * DAY_MS);
    assert.equal(Object.getPrototypeOf(paths.starts), Object.prototype);
    assert.equal(Object.getPrototypeOf(paths.next), Object.prototype);
    assert.equal(own(paths.starts, tag), 3);
    assert.deepEqual(own(paths.next, tag), [{ id: "course", buyers: 3, days: 10 }]);
    assert.deepEqual(Object.keys(paths.starts), [tag]);

    const kept = parsePaths(JSON.parse(JSON.stringify({ at: 1, starts: { [tag]: 3 }, next: { [tag]: [{ id: "course", buyers: 3, days: 10 }] } })));
    assert.ok(kept);
    assert.equal(Object.getPrototypeOf(kept.starts), Object.prototype);
    assert.equal(Object.getPrototypeOf(kept.next), Object.prototype);
    assert.equal(own(kept.starts, tag), 3);
    assert.deepEqual(own(kept.next, tag), [{ id: "course", buyers: 3, days: 10 }]);
  });
}

test("ordinary product ids still give the same plain records as before", () => {
  const together = togetherFrom(["ana", "ben", "cy"].map((buyer) => sale(buyer, "planner", START, "lists")));
  assert.deepEqual(together, { planner: [["lists", 3]], lists: [["planner", 3]] });
  assert.deepEqual(togetherFrom([sale("ana", "a", START, "b")]), {});
  assert.deepEqual(parseTogether({ planner: [["lists", 3], ["x", 2], "z"], bad: "no" }), { planner: [["lists", 3]] });
  const paths = pathsFrom(["ana", "ben", "cy"].flatMap((buyer) => [sale(buyer, "guide", START), sale(buyer, "course", START + 10 * DAY_MS)]), 5);
  assert.deepEqual(paths, { at: 5, starts: { guide: 3 }, next: { guide: [{ id: "course", buyers: 3, days: 10 }] } });
  assert.deepEqual(parsePaths({ at: 1, starts: { a: 2, b: "x" }, next: { x: [{ id: "y", buyers: 2, days: 1 }] } }), { at: 1, starts: { a: 2 }, next: {} });
});

// ---- Held files: proved, not fixed here (todo) -------------------------------------------------------------------

const WRITTEN = ["played", "quarter", "half", "threeQuarters", "end", "sales", "cents", "d7", "d30", "d90", "refunds"];

test(
  "page-depth: a visitor's block id \"constructor\" is its own block and writes nothing onto the Object function",
  { todo: "lib/page-depth.ts is held by #2571 (Claude 3, claude3/gl7-time-on-page), which rewrites readDepth" },
  async () => {
    redis.clear();
    const statsId = "0".repeat(32);
    // What the read route (app/api/store/read) lets any visitor of the page write: BLOCK_ID_PATTERN is /^[a-z0-9]{4,12}$/.
    await redis.pipeline([["HSET", `nl:depth:${statsId}:prod000001`, "constructor!constructor.p", "2", "abcd1234", "3"]]);
    try {
      const depth = await readDepth(statsId, "prod000001");
      nothingShared(WRITTEN);
      assert.equal(own(depth.stopped, "constructor"), 2);
      assert.deepEqual(own(depth.videos, "constructor"), { played: 2, quarter: 0, half: 0, threeQuarters: 0, end: 0 });
      assert.equal(depth.visitors, 5);
    } finally {
      cleanShared(WRITTEN);
    }
  },
);

test(
  "partner-share: a share on a product id \"constructor\" is weighed as an ordinary product, never as Object",
  { todo: "lib/partner-share.ts and app/api/store/affiliates/route.ts are held by #1924 (Claude 3, claude3/hn6-partner-term)" },
  () => {
    // parsePartnerShare keeps /^[a-z0-9]{6,40}$/, so a creator can send it; the route's `others[product] ??= []` then reads Object too.
    assert.equal(shareProblem({ percent: 10, products: ["constructor"], others: {}, affiliatePercent: {} }), null);
  },
);

const NOW = Date.UTC(2026, 10, 6, 12);
const SEC = Math.floor(NOW / 1000);
const TODAY = new Date(NOW).toISOString().slice(0, 10);

test(
  "stats renewalsFrom: a renewal whose channel is \"__proto__\" or \"constructor\" is its own channel's day, not Object.prototype's",
  { todo: "lib/stats.ts is held by #2571 (Claude 3) and #1933 (Claude 3, claude3/aa1-read-imports-bundles)" },
  () => {
    const store = { handle: "harbor", previousHandles: [], releasedHandles: [] } as never;
    const invoice = (channel: string, n: number) => ({
      id: `in_proto_${n}`,
      status: "paid",
      billing_reason: "subscription_cycle",
      amount_paid: 2000,
      currency: "usd",
      created: SEC,
      subscription_details: { metadata: { store: "harbor", channel } },
    });
    try {
      const read = renewalsFrom(store, [invoice("__proto__", 1), invoice("constructor", 2)], NOW, "usd");
      nothingShared([TODAY]);
      assert.equal(Object.getPrototypeOf(read.bySourceDay), Object.prototype);
      assert.deepEqual([own(read.bySourceDay, "__proto__"), own(read.bySourceDay, "constructor")], [{ [TODAY]: 2000 }, { [TODAY]: 2000 }]);
    } finally {
      cleanShared([TODAY]);
    }
  },
);

let sessions: Record<string, unknown>[] = [];
const realFetch = globalThis.fetch;
async function harbor() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_proto_keys_stand_in";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
    return new Response(JSON.stringify({ object: "list", data: path === "/checkout/sessions" ? sessions : [], has_more: false }));
  }) as typeof fetch;
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  return (await storeForEmail("owner@example.com"))!;
}
const paid = (id: string, meta: Record<string, string>) => ({
  id,
  status: "complete",
  payment_status: "paid",
  amount_total: 1900,
  currency: "usd",
  created: SEC - 86_400,
  payment_intent: `pi_${id}`,
  customer_details: { email: `${id}@example.com` },
  metadata: { store: "harbor", product: "prod000001", ...meta },
});
const YESTERDAY = new Date(NOW - 86_400_000).toISOString().slice(0, 10);

test(
  "stats readSales: a sale tagged utm_source \"__proto__\" is its own channel's day, and a product id \"__proto__\" its own product",
  { todo: "lib/stats.ts is held by #2571 and #1933 (Claude 3)" },
  async () => {
    try {
      const store = await harbor();
      sessions = [paid("cs_proto_a", { utm_source: "__proto__" }), paid("cs_proto_b", { utm_source: "constructor" })];
      const bySource = await readSales(store, NOW);
      nothingShared([YESTERDAY]);
      assert.deepEqual([own(bySource!.channelDays!, "__proto__"), own(bySource!.channelDays!, "constructor")], [{ [YESTERDAY]: 1900 }, { [YESTERDAY]: 1900 }]);

      // A creator's own Stripe account can carry any product id: before, this threw (Object.prototype.d90 is undefined).
      sessions = [paid("cs_proto_c", { product: "__proto__" })];
      const byProduct = await readSales(store, NOW);
      nothingShared(WRITTEN);
      assert.equal((own(byProduct!.byProduct, "__proto__") as { d90: { sales: number } }).d90.sales, 1);
    } finally {
      globalThis.fetch = realFetch;
      cleanShared([YESTERDAY, ...WRITTEN]);
    }
  },
);

test(
  "stats readAllTimeSales: a product id \"__proto__\" or \"constructor\" is its own product and writes no sales onto Object.prototype",
  { todo: "lib/stats.ts is held by #2571 and #1933 (Claude 3)" },
  async () => {
    try {
      const store = await harbor();
      sessions = [paid("cs_proto_d", { product: "__proto__" }), paid("cs_proto_e", { product: "constructor" })];
      const all = await readAllTimeSales(store);
      nothingShared(WRITTEN);
      assert.deepEqual([own(all!.byProduct, "__proto__"), own(all!.byProduct, "constructor")], [{ sales: 1, cents: 1900 }, { sales: 1, cents: 1900 }]);
    } finally {
      globalThis.fetch = realFetch;
      cleanShared(WRITTEN);
    }
  },
);
