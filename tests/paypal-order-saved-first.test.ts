/**
 * Synthetic only (#4354, Codex X5): a PayPal approval link is handed out only once the local order record is
 * confirmed. The capture finds the order by that record; an order PayPal approves with no record here is a payment the
 * site cannot complete. Only SET's exact "OK" is a write; any other answer is checked by reading the very record back.
 *
 * Checks marked [CORRETO] say what should happen; a FAIL there is the defect.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setPayPalSeller, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { openOrder } from "@/lib/paypal-sales";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SELLER = "7KNGBPH2U58GQ";
let made = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && (init?.method ?? "GET") === "POST") {
    made += 1;
    const id = `5O190127TN36471${String(made).padStart(2, "0")}`;
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" }] });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const original = redis.pipeline;
const orderRecords = () => redis.keys().filter((k) => k.startsWith("nl:ppsell:o:"));

/** Runs `run` with the order record's SET answered by `answer` (after running it when `ran`). */
async function withSet<T>(answer: () => unknown, ran: boolean, run: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "SET" && String(commands[0]?.[1]).startsWith("nl:ppsell:o:")) {
      if (ran) await original(commands);
      return answer();
    }
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
  await claimHandle("owner@example.com", "harborpp", "Harbor PayPal", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_OwnerPP001", subscriptionId: "sub_OwnerPP001", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, added.product.id))!;
  const open = () => openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });

  part("The order record's SET answered with an empty reply list and not stored (the issue's case)");
  const lost = await withSet(() => [], false, open);
  is("[CORRETO] no approval link is handed out", lost.ok, false);
  is("and no order record exists", orderRecords().length, 0);

  part("The SET failed outright");
  const failed = await withSet(() => { throw new Error("Redis request failed with status 503"); }, false, open);
  is("no approval link is handed out", failed.ok, false);

  part("The SET stored the record but its answer was lost");
  const stored = await withSet(() => [{ error: "unknown" }], true, open);
  is("[CORRETO] the record read back exactly lets the buyer go to PayPal", stored.ok, true);
  is("and the record is there", orderRecords().length, 1);

  part("The ordinary write");
  is("a confirmed SET hands out the link", (await open()).ok, true);
  done();
}

void main();
