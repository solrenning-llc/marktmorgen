/**
 * Which products an email may show (546 [EB1], unit 1; added 4 November
 * 2026): only one a buyer can get on its page now. On a synthetic store,
 * with the stand-in Redis and no real Stripe call.
 */
import { addProduct, claimHandle, removeProduct, ensureStatsId, setProductBundle, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { parseProduct, readListings } from "@/lib/catalog";
import type { CallSetup } from "@/lib/call-setup";
import { productsBuyableNow } from "@/lib/mail-product-sellable";
import { blockProblems, leavingProducts, productsLine } from "@/lib/mail-product-block";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

// Nothing here may reach Stripe: a held unit that ran out would ask it, and the answer is "unknown".
globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;

const EMAIL = "owner@example.com";

function listing(raw: Record<string, unknown>): Listing {
  const product = parseProduct({ title: "Synthetic", summary: "", priceCents: 1900, link: "https://example.com/x", ...raw });
  if (!product) throw new Error("synthetic product refused");
  return product;
}

async function made(title: string, price: string, link = true): Promise<string> {
  const added = await addProduct(EMAIL, title, "", price, null);
  if (!added.ok) throw new Error(`no product ${title}`);
  if (link) await setProductLink(EMAIL, added.product.id, `https://example.com/${added.product.id}`);
  return added.product.id;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_mail_cards_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_mail_cards_only_a_stand_in";
  await claimHandle(EMAIL, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(EMAIL);
  await setStripeAccount(EMAIL, "acct_1TestHarbor0001", true);
  await setSubscription(EMAIL, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });

  const paid = await made("Guide", "19");
  const free = await made("Sampler", "0");
  const empty = await made("Nothing yet", "9", false);
  const draft = await made("Draft", "9");
  await setProductHidden(EMAIL, draft, true);
  const one = await made("One", "5");
  const two = await made("Two", "6");
  const bundle = await made("Both", "9", false);
  const bundled = await setProductBundle(EMAIL, bundle, [one, two]);
  if (!bundled.ok) throw new Error("no bundle");
  let store = (await storeForEmail(EMAIL))!;
  const all = async () => readListings(store);
  const buyable = async (products?: Listing[]) => productsBuyableNow(store, products ?? (await all()));

  part("What the store can sell or give");
  is("a paid product with something to hand over, a free one the store can give, and a full bundle", [...(await buyable())].sort(), [paid, free, one, two, bundle].sort());
  is("a draft is out", (await buyable()).has(draft), false);
  is("a paid product with nothing to hand over is out", (await buyable()).has(empty), false);
  const shut: Store = { ...store, stripeChargesEnabled: false };
  is("a store that cannot sell: only its free product", [...(await productsBuyableNow(shut, await all()))], [free]);
  const unpaid: Store = { ...store, subscriptionActive: false };
  is("a store whose plan is not paid: nothing, free included", (await productsBuyableNow(unpaid, await all())).size, 0);
  const noList: Store = { ...store, listId: null };
  is("free only while the store can give it", (await productsBuyableNow(noList, await all())).has(free), false);

  part("Options");
  const options = (link: boolean) => [{ id: "opt_a", label: "A", priceCents: 1900, ...(link ? { link: "https://example.com/a" } : {}) }];
  is("options: in while one can be picked, out with none", [(await buyable([listing({ id: "opts000001", options: options(true), link: undefined })])).size, (await buyable([listing({ id: "opts000002", options: options(false), link: undefined })])).size], [1, 0]);

  part("Coming soon");
  const STATS = store.statsId!;
  await redis.pipeline([["SADD", `nl:wl:${STATS}:soon`, paid]]);
  is("coming soon is out", (await buyable()).has(paid), false);
  await redis.pipeline([["HSET", `nl:wl:${STATS}:pre`, paid, "2099-01-01"]]);
  is("coming soon with pre-orders is out too", (await buyable()).has(paid), false);
  await redis.pipeline([["SREM", `nl:wl:${STATS}:soon`, paid], ["HDEL", `nl:wl:${STATS}:pre`, paid]]);
  is("back in once it is out", (await buyable()).has(paid), true);
  const original: typeof redis.pipeline = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    if (commands.some((command) => command[0] === "SMEMBERS")) throw new Error("synthetic outage");
    return original(commands);
  };
  try {
    is("a failed read of what is coming soon leaves every product out", (await buyable()).size, 0);
  } finally {
    redis.pipeline = original;
  }

  part("Stock");
  const limited = (id: string) => listing({ id, stock: 3 });
  const sold = async (id: string, units: number) => {
    for (let i = 0; i < units; i += 1) await redis.pipeline([["HSET", `nl:stock:${STATS}:${id}`, `cs_test_${id}_${i}`, JSON.stringify({ until: 0, paid: true })]]);
  };
  await sold("limited001", 3);
  await sold("limited003", 2);
  is("0 left is out; 1 or 3 of 3 left is in", [(await buyable([limited("limited001")])).size, (await buyable([limited("limited003")])).size, (await buyable([limited("limited002")])).size], [0, 1, 1]);
  await redis.pipeline([["HSET", `nl:stock:${STATS}:limited004`, "cs_test_bad", "{"]]);
  is("stock that cannot be read is out", (await buyable([limited("limited004")])).size, 0);

  part("Licence keys");
  const keyed = listing({ id: "keyed00001", keys: { source: "pool" } });
  is("keys from an empty pool: out, as its page says Sold out", (await buyable([keyed])).size, 0);
  await redis.pipeline([["RPUSH", `nl:keys:${STATS}:keyed00001:pool`, "AAAA-BBBB-CCCC-DDDD"]]);
  is("with a key left in the pool: in", (await buyable([keyed])).size, 1);
  redis.pipeline = async (commands) => {
    if (commands.some((command) => command[0] === "LLEN")) throw new Error("synthetic outage");
    return original(commands);
  };
  try {
    is("a pool that cannot be read: out", (await buyable([keyed])).size, 0);
  } finally {
    redis.pipeline = original;
  }
  is("keys made on the spot never run out", (await buyable([listing({ id: "keyed00002", keys: { source: "generated" } })])).size, 1);

  part("Calls");
  const at = Date.now();
  const call = (kind: "weekly" | "live", starts: number[]): Listing => ({
    ...listing({ id: `call${kind}${starts.length}`.padEnd(10, "0"), link: undefined }),
    call: { kind, minutes: 30, tz: "UTC", weekly: [], noticeHours: 2, horizonDays: 30, bufferMinutes: 0, room: null, video: false, meet: null, seats: 1, sessions: starts.map((start, i) => ({ id: `s${i}`, start, minutes: 30, seats: 5, room: null })) } as CallSetup,
  });
  is("weekly hours: in", (await buyable([call("weekly", [])])).size, 1);
  is("a live session with no date on sale: out, as its page says No dates", [(await buyable([call("live", [])])).size, (await buyable([call("live", [at - 3_600_000, at + 3_600_000])])).size], [0, 0]);
  is("a live session with a date still before its notice: in", (await buyable([call("live", [at + 3 * 3_600_000])])).size, 1);

  part("Suspended or selling through PayPal");
  const suspended: Store = { ...store, suspended: "2026-11-04T00:00:00.000Z" };
  is("a suspended store shows nothing, free products included", (await productsBuyableNow(suspended, await all())).size, 0);
  process.env.PAYPAL_PARTNER_CLIENT_ID = "paypal_client_stand_in";
  process.env.PAYPAL_PARTNER_SECRET = "paypal_secret_stand_in";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNER0001";
  process.env.PAYPAL_BN_CODE = "BN_STAND_IN";
  const paypalOnly: Store = { ...store, stripeChargesEnabled: false, paypalSeller: { merchant: "SELLER00001", at: 1 } };
  is("a store selling only through PayPal: its PayPal products are in", (await productsBuyableNow(paypalOnly, await all())).has(paid), true);
  is("without its PayPal account: out again", (await productsBuyableNow({ ...paypalOnly, paypalSeller: null }, await all())).has(paid), false);
  for (const name of ["PAYPAL_PARTNER_CLIENT_ID", "PAYPAL_PARTNER_SECRET", "PAYPAL_PARTNER_MERCHANT_ID", "PAYPAL_BN_CODE"]) delete process.env[name];

  part("Bundles");
  // A draft inside a bundle is still handed over with it (lib/bundle-rules.ts, canBeInBundle).
  await setProductHidden(EMAIL, two, true);
  store = (await storeForEmail(EMAIL))!;
  is("a bundle holding a draft is still in, as on its page", (await buyable()).has(bundle), true);
  // Its products read from storage, not from the first page the store record carries.
  const alone: Store = { ...store, catalog: { ...store.catalog, head: store.catalog.head.filter((p) => p.id === bundle) } };
  const theBundle = (await all()).filter((p) => p.id === bundle);
  is("its products are read from storage here", (await productsBuyableNow(alone, theBundle)).has(bundle), true);
  redis.pipeline = async (commands) => {
    if (commands.some((command) => command[0] !== "SMEMBERS" && command[0] !== "HGETALL")) throw new Error("synthetic outage");
    return original(commands);
  };
  try {
    is("a bundle whose products cannot be read is out", (await productsBuyableNow(alone, theBundle)).size, 0);
  } finally {
    redis.pipeline = original;
  }
  await removeProduct(EMAIL, two);
  store = (await storeForEmail(EMAIL))!;
  is("a bundle left with fewer than 2 to hand over is out", (await buyable()).has(bundle), false);

  part("The email's block reads it");
  const onSale = await buyable();
  is("a block of a draft and a product on sale: the draft leaves, the email goes", [leavingProducts(productsLine([paid, draft]), onSale), blockProblems(productsLine([paid, draft]), onSale)], [[draft], null]);
  is("a block of only products not on sale stops the email", blockProblems(productsLine([draft, empty]), onSale), { why: "empty", ids: [draft, empty] });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
