process.env.STRIPE_SECRET_KEY = "sk_test_x8_earnings_synthetic";
import assert from "node:assert/strict";
import test from "node:test";
import { readEarningsYear } from "@/lib/earnings-read";
import { ReadingFailed } from "@/lib/store-readings";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const NOW = Date.UTC(2031, 5, 15, 12);
const AT = Date.UTC(2031, 5, 5) / 1000;
const paths = ["/checkout/sessions", "/payment_intents", "/invoices", "/refunds"] as const;
type Path = (typeof paths)[number];
type Wire = (path: Path, after: string | null) => unknown;
const empty = () => ({ object: "list", data: [], has_more: false });
const paid = { id: "cs_x8_envelope", object: "checkout.session", created: AT, status: "complete", payment_status: "paid", amount_total: 3000, currency: "usd", metadata: { store: "x8shop" } };
const refund = { id: "re_x8_envelope", object: "refund", created: AT, status: "succeeded", amount: 1000, currency: "usd", payment_intent: { id: "pi_x8_envelope", object: "payment_intent", metadata: { store: "x8shop" } } };
const page = (data: unknown[], more = false) => ({ object: "list", data, has_more: more });
const healthy: Wire = (path) => path === "/checkout/sessions" ? page([paid]) : path === "/refunds" ? page([refund]) : empty();
let calls = 0;
function setup(wire: Wire): Store {
  redis.clear(); calls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.stripe.com");
    assert.equal(init?.method, "GET");
    const path = url.pathname.replace(/^\/v1/, "") as Path;
    assert.ok(paths.includes(path)); calls += 1;
    return new Response(JSON.stringify(wire(path, url.searchParams.get("starting_after"))), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { handle: "x8shop", previousHandles: [], releasedHandles: [], statsId: "x8-earnings-envelope-synthetic", stripeAccountId: "acct_x8_synthetic", paypalSeller: null, currency: "usd" } as unknown as Store;
}

for (const path of paths) {
  for (const object of [undefined, null, "invoice", "search_result"] as const) {
    test(`${path}: envelope object ${String(object)} cannot certify money or zero`, async () => {
      const shop = setup((p) => p === path ? { ...(object === undefined ? {} : { object }), data: [], has_more: false } : healthy(p, null));
      const kept = await readEarningsYear(shop, "UTC", NOW);
      const months = kept?.value?.months ?? [];
      assert.equal(months.length, 12);
      assert.equal(calls, 4);
      assert.equal(Number(redis.run(["GET", `nl:reading:day:${shop.statsId}:2031-06-15:heavy`])), 1);
      const before = calls;
      const cached = await readEarningsYear(shop, "UTC", NOW + 60_000);
      assert.deepEqual(cached?.value, kept?.value);
      assert.equal(calls, before);
      for (const month of months) {
        const source = month.sources.find((s) => s.source === "stripe");
        assert.equal(source?.state, "unknown");
        assert.equal(source && "why" in source ? source.why : null, "unread");
        assert.equal(month.totals, null);
        assert.equal(source && "lines" in source ? source.lines : undefined, undefined);
      }
    });
  }
}

test("a later refund page of another kind invalidates the whole list, including the newer month", async () => {
  const shop = setup((path, after) => path === "/refunds" ? after ? { object: "search_result", data: [], has_more: false } : page([refund], true) : healthy(path, after));
  const kept = await readEarningsYear(shop, "UTC", NOW);
  assert.equal(calls, 5);
  const june = kept?.value?.months[0];
  assert.equal(june?.sources.find((s) => s.source === "stripe")?.state, "unknown");
  assert.equal(june?.totals, null);
});

test("four invalid envelopes with no PayPal history fail, consume the reading and keep no copy", async () => {
  const shop = setup(() => ({ data: [], has_more: false }));
  await assert.rejects(readEarningsYear(shop, "UTC", NOW), ReadingFailed);
  assert.equal(calls, 4);
  assert.equal(redis.run(["GET", `nl:reading:earnings:${shop.statsId}`]), null);
  assert.equal(Number(redis.run(["GET", `nl:reading:day:${shop.statsId}:2031-06-15:heavy`])), 1);
});

test("control: real list envelopes retain the exact sale and refund, then reuse their copy", async () => {
  const shop = setup(healthy);
  const kept = await readEarningsYear(shop, "UTC", NOW);
  const june = kept?.value?.months[0];
  assert.equal(june?.sources.find((s) => s.source === "stripe")?.state, "read");
  assert.equal(june?.totals?.[0].salesCents, 3000);
  assert.equal(june?.totals?.[0].refundCents, 1000);
  assert.equal(june?.totals?.[0].netCents, 2000);
  const before = calls;
  const cached = await readEarningsYear(shop, "UTC", NOW + 60_000);
  assert.deepEqual(cached?.value, kept?.value);
  assert.equal(calls, before);
});

test("control: four valid empty lists are a proved zero", async () => {
  const shop = setup(empty);
  const kept = await readEarningsYear(shop, "UTC", NOW);
  assert.equal(calls, 4);
  for (const month of kept?.value?.months ?? []) {
    assert.equal(month.sources.find((s) => s.source === "stripe")?.state, "read");
    assert.deepEqual(month.totals, []);
  }
});
