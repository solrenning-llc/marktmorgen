/**
 * Fair prices limited to more products than MAX_FAIR_PRODUCTS (Claude 1's order C1-20261117-1449-c6c3-2, from
 * Codex V's finding on main): the setting is refused with "fair_products" and the one saved before stays exactly as
 * it was, never cut to the first 200 and saved as if all went in. Counted as parseFair keeps them: distinct product
 * ids of the right shape, so repeats and ids it would drop never push a list over. The studio says why in plain
 * words (lib/studio-messages.ts) and does not send a list it knows is too long (components/fair-price-editor.tsx).
 * Synthetic only: Redis is lib/redis-memory.ts, nothing reaches Stripe.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { MAX_FAIR_PRODUCTS, fairProductsOverCap } from "@/lib/fair-price";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { POST as fairRoute } from "@/app/api/store/fair/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "fair-cap-owner@example.com";
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `prod_${String(from + i).padStart(4, "0")}`);

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "faircap", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_FairCap1", true);
  await setSubscription(OWNER, { customerId: "cus_FairCap1", subscriptionId: "sub_FairCap1", active: true, period: paidPeriod() });
  const session = await openSession(OWNER);
  const save = async (body: Record<string, unknown>) => {
    const response = await fairRoute(
      new NextRequest("https://marktmorgen.com/api/store/fair", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }),
    );
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return [response.status, data.ok === true, data.error ?? null] as const;
  };
  const saved = async () => {
    const fair = (await storeForEmail(OWNER))?.fair;
    return fair ? { on: fair.on, all: fair.all, products: fair.products } : null;
  };
  const setting = (products: string[]) => ({ on: true, auto: true, maxOff: 50, levels: {}, all: false, products });

  part("A setting saved first, limited to two products");
  is("control: saved", await save(setting(ids(2))), [200, true, null]);
  const before = await saved();
  is("control: as sent", before, { on: true, all: false, products: ids(2) });

  part(`One more than MAX_FAIR_PRODUCTS (${MAX_FAIR_PRODUCTS}) is refused, and nothing saved changes`);
  is("refused with fair_products", await save(setting(ids(MAX_FAIR_PRODUCTS + 1))), [400, false, "fair_products"]);
  is("the setting saved before stays exactly as it was", await saved(), before);
  is("far more, the same", await save(setting(ids(MAX_FAIR_PRODUCTS * 3))), [400, false, "fair_products"]);
  is("still as it was", await saved(), before);

  part("At the limit, and over it only by repeats or ids it would drop: saved whole");
  is("exactly MAX_FAIR_PRODUCTS: saved", await save(setting(ids(MAX_FAIR_PRODUCTS))), [200, true, null]);
  is("all of them kept", (await saved())?.products.length, MAX_FAIR_PRODUCTS);
  const repeated = [...ids(MAX_FAIR_PRODUCTS), ...ids(20)];
  is("repeats do not count twice: saved", await save(setting(repeated)), [200, true, null]);
  const odd = [...ids(MAX_FAIR_PRODUCTS - 1), "not an id!", "", 42, "x".repeat(65)];
  is("ids parseFair would drop do not count: saved", await save(setting(odd)), [200, true, null]);
  is("and what is kept is the valid ones", (await saved())?.products, ids(MAX_FAIR_PRODUCTS - 1));

  part("The count is the one parseFair keeps");
  is("over", fairProductsOverCap({ products: ids(MAX_FAIR_PRODUCTS + 1) }), true);
  is("at", fairProductsOverCap({ products: ids(MAX_FAIR_PRODUCTS) }), false);
  is("repeats", fairProductsOverCap({ products: [...ids(MAX_FAIR_PRODUCTS), ...ids(MAX_FAIR_PRODUCTS)] }), false);
  is("no list, or not a list", [fairProductsOverCap({}), fairProductsOverCap({ products: "prod_0001" }), fairProductsOverCap(null)], [false, false, false]);

  part("The studio says why, and does not send a list it knows is too long");
  is("a plain message for fair_products", typeof STUDIO_MESSAGES.fair_products === "string" && STUDIO_MESSAGES.fair_products.includes(String(MAX_FAIR_PRODUCTS)), true);
  const editor = readFileSync(join(process.cwd(), "components/fair-price-editor.tsx"), "utf8");
  is("the editor checks the count before saving", /picked\.length > MAX_FAIR_PRODUCTS/.test(editor), true);
  done();
}

void main();
