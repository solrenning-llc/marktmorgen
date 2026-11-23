// Codex G (G-20261121-0428, MEDIUM, money): the year of earnings read a paid checkout, a one-click extra or a paid
// invoice whose metadata names a store in a shape no handle has (" shop ", an empty string) as another store's and
// left it out, so the months it reached could be shown with less money than the store took, zero included, with no
// proof the money was another store's. Only a well-formed handle of another store proves that; an unreadable one is
// unknown: that point and every older month are not reached, as the refunds already read it. A handle this store
// owns, its old ones included, is still counted. Synthetic Stripe lists and Redis only.
process.env.STRIPE_SECRET_KEY = "sk_test_g0428_earnings_synthetic";
import assert from "node:assert/strict";
import test from "node:test";
import { readEarningsYear } from "@/lib/earnings-read";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const NOW = Date.UTC(2031, 5, 15, 12);
/** A day in April 2031: the third month back from June. */
const APRIL = Date.UTC(2031, 3, 10) / 1000;
const paths = ["/checkout/sessions", "/payment_intents", "/invoices", "/refunds"] as const;
type Path = (typeof paths)[number];
const page = (data: unknown[]) => ({ object: "list", data, has_more: false });

/** One paid row of the list at `path`, its metadata naming `owner` as the store, or naming none (undefined). */
function row(path: Path, owner: string | undefined): unknown {
  const store = owner === undefined ? {} : { store: owner };
  if (path === "/checkout/sessions") return { id: "cs_g0428", object: "checkout.session", created: APRIL, status: "complete", payment_status: "paid", amount_total: 3000, currency: "usd", metadata: store };
  if (path === "/payment_intents") return { id: "pi_g0428", object: "payment_intent", created: APRIL, status: "succeeded", amount: 3000, currency: "usd", metadata: { kind: "upsell", ...store } };
  return { id: "in_g0428", object: "invoice", created: APRIL, status: "paid", billing_reason: "subscription_cycle", amount_paid: 3000, currency: "usd", parent: { type: "subscription_details", subscription_details: { metadata: store } } };
}

function setup(path: Path, owner: string | undefined): Store {
  redis.clear();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.stripe.com");
    const asked = url.pathname.replace(/^\/v1/, "") as Path;
    return new Response(JSON.stringify(page(asked === path ? [row(path, owner)] : [])), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { handle: "shop", previousHandles: ["oldshop"], releasedHandles: [], statsId: "g0428-earnings-synthetic", stripeAccountId: "acct_g0428synthetic", paypalSeller: null, currency: "usd" } as unknown as Store;
}

/** The Stripe source's state in the first four months, June back to March: "read", or why not. */
async function states(shop: Store): Promise<{ states: unknown[]; april: unknown }> {
  const months = (await readEarningsYear(shop, "UTC", NOW))?.value?.months ?? [];
  return {
    states: months.slice(0, 4).map((month) => {
      const stripe = month.sources.find((source) => source.source === "stripe");
      if (!stripe) return "none";
      return stripe.state === "read" ? "read" : "why" in stripe ? stripe.why : "no reason";
    }),
    april: months[2]?.totals ?? null,
  };
}

for (const path of ["/checkout/sessions", "/payment_intents", "/invoices"] as const) {
  for (const owner of [" shop ", "", "SHOP!"]) {
    test(`${path}: a store named ${JSON.stringify(owner)} cannot prove the money is another store's`, async () => {
      const read = await states(setup(path, owner));
      assert.deepEqual(read.states, ["read", "read", "not_reached", "not_reached"]);
      assert.equal(read.april, null);
    });
  }

  test(`${path}: control, a well-formed handle of another store is left out and the months are read`, async () => {
    const read = await states(setup(path, "othershop"));
    assert.deepEqual(read.states, ["read", "read", "read", "read"]);
    assert.equal(JSON.stringify(read.april).includes("3000"), false, JSON.stringify(read.april));
  });

  // #5196 triple audit (coordinator 090d): a checkout or an invoice naming no store at all is a sale made outside
  // Marktmorgen on the creator's account (every checkout and subscription it makes writes metadata[store]): skipped,
  // never hiding its month and every older one. A one-click extra naming none stays unknown.
  test(`${path}: a row naming no store (metadata {}) is ${path === "/payment_intents" ? "unknown" : "skipped, and the months are read"}`, async () => {
    const read = await states(setup(path, undefined));
    if (path === "/payment_intents") {
      assert.deepEqual(read.states, ["read", "read", "not_reached", "not_reached"]);
      assert.equal(read.april, null);
    } else {
      assert.deepEqual(read.states, ["read", "read", "read", "read"]);
      assert.equal(JSON.stringify(read.april).includes("3000"), false, JSON.stringify(read.april));
    }
  });

  test(`${path}: control, this store's old handle is still counted`, async () => {
    const read = await states(setup(path, "oldshop"));
    assert.deepEqual(read.states, ["read", "read", "read", "read"]);
    // A renewal is counted with the sales of its month (lib/earnings-read.ts, readEarningsYear); the month holds its 3000.
    assert.equal(JSON.stringify(read.april).includes("3000"), true, JSON.stringify(read.april));
  });
}
