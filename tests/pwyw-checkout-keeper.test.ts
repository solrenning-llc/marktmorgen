/**
 * The server checkout keeps a pay-what-you-want Price (nl:pwyw:) only while its store is live: createCheckout
 * (lib/store-checkout.ts) hands pwywPriceId the store-live keeper (setWhileStoreLive). tests/price-cache-erased-store
 * hands that keeper to pwywPriceId itself, so a plain SET put back at the checkout's call stayed green there (LOW from
 * Claude 6 and Codex X6 on #4896 @eec5031598). Here the real createCheckout is driven for a pay-what-you-want product,
 * Stripe stubbed: a live store keeps the Price; a store whose record goes, or whose erasure begins, while Stripe makes
 * it keeps nothing. With the keeper replaced by a plain SET EX, the two erasure cases fail.
 * Every service and identifier here is a local synthetic stand-in.
 */
import { addProduct, claimHandle, ensureStatsId, ERASING_KEY, erasingField, ownerKey, setProductLink, setStripeAccount, setSubscription, storeForEmail, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_pwyw_checkout_keeper";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const ACCOUNT = "acct_PwywKeeper01";

/** What the next price POST does while Stripe is working on it, before it answers. */
let duringPost: () => Promise<void> = async () => {};
let made = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.origin !== "https://api.stripe.com") throw new Error(`unexpected synthetic host ${url}`);
  if (url.pathname === "/v1/prices" && method === "POST") {
    await duringPost();
    made += 1;
    return Response.json({ id: `price_SyntheticKeep${String(made).padStart(4, "0")}`, object: "price" });
  }
  if (url.pathname === "/v1/checkout/sessions" && method === "POST") {
    return Response.json({ id: `cs_test_${"k".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (method === "GET") return Response.json({ object: "list", data: [], has_more: false });
  throw new Error(`unexpected synthetic operation ${method} ${url}`);
}) as typeof fetch;

const kept = () => redis.keys().filter((key) => key.startsWith("nl:pwyw:"));

/** The store's erasure, as closeStoreRecord leaves it: its id key and record gone, or only its erasing mark set. */
async function erase(store: Store, how: "gone" | "erasing"): Promise<void> {
  if (how === "erasing") {
    await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]]);
    return;
  }
  await redis.pipeline([["DEL", storeIdCommand(store.sid)[1]], ["DEL", await ownerKey(storeRef(store))]]);
}

async function main(): Promise<void> {
  for (const how of ["live", "gone", "erasing"] as const) {
    part(`the server checkout's pay-what-you-want Price, its store ${how === "live" ? "live" : how === "gone" ? "gone during the call" : "being erased during the call"}`);
    redis.clear();
    made = 0;
    const owner = `pwyw-keeper-${how}@example.com`;
    const claimed = await claimHandle(owner, `pwyw-keep-${how}`, "Pay what you want shop", "");
    if (!claimed.ok) throw new Error("synthetic store was not made");
    await ensureStatsId(owner);
    await setStripeAccount(owner, ACCOUNT, true);
    await setSubscription(owner, { customerId: "cus_PwywKeeper01", subscriptionId: "sub_PwywKeeper01", active: true, period: paidPeriod() });
    const added = await addProduct(owner, "Synthetic guide", "", "10", null, "15");
    if (!added.ok) throw new Error(`synthetic product was not made: ${JSON.stringify(added)}`);
    await setProductLink(owner, added.product.id, "https://example.com/guide");
    const seller = (await storeForEmail(owner))!;
    const guide = (await readProduct(seller, added.product.id))!;
    if (how !== "live") duringPost = () => erase(seller, how);
    const opened = await createCheckout(seller, guide, "https://marktmorgen.com", "", { digitalConsent: TEST_CONSENT })
      .then(() => "opened", (error: unknown) => `threw: ${String(error)}`);
    duringPost = async () => {};
    is("Stripe's Price was asked for once", made, 1);
    if (how === "live") {
      is("the checkout opened", opened, "opened");
      is("a live store keeps the Price", kept().length, 1);
    } else {
      is("nothing kept under nl:pwyw:", kept(), []);
    }
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
