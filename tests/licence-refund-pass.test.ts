/**
 * A pass over the creator's refunds longer than one run goes on where the last run stopped, for license keys as for
 * gifts and pre-orders (tests/gift-preorder-refunds-cursor.test.ts; review of #2868 by nuvem T, MEDIUM).
 *
 * revokeRefunded (lib/licence-keys.ts) read at most REFUND_PAGES pages of refunds (100 each, newest first) per store
 * per run and kept the anchor while the list was not read to its end, with no place kept between runs. With more
 * refunds since the anchor than one run reads, every run read the same newest pages again and never reached the older
 * ones: a key whose sale was refunded in full long ago stayed valid for good. Synthetic only: the in-memory Redis
 * double and a stand-in for the creator's Stripe account that pages as Stripe does (newest first, starting_after).
 *
 *   - 350 refunds, the oldest a full refund of a sale that gave a key: a later run goes on from where the earlier one
 *     stopped and revokes it, and only then moves the anchor;
 *   - a run that resumes reads the newest page first, so a refund made meanwhile does not wait for the pass;
 *   - a pass kept in another shape, or kept from the store's earlier Stripe account, starts over: read again, never
 *     skipped.
 */
import { type Store, claimHandle, ensureStatsId, addProduct, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { checkKey, keyForSale, revokeRefunded } from "@/lib/licence-keys";
import { readListing } from "@/lib/catalog";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_licence_refund_pass";
const OWNER = "licencepass@example.com";
const ACCOUNT = "acct_1TestLicPass1";
const NOW = Math.floor(Date.now() / 1000);

const sessionsByPayment: Record<string, Record<string, unknown>[]> = {};
/** The creator's refunds, newest first, as Stripe lists them. */
let refunds: Record<string, unknown>[] = [];
let refundCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    return answer({ object: "list", data: sessionsByPayment[url.searchParams.get("payment_intent") ?? ""] ?? [], has_more: false });
  }
  if (path === "/refunds") {
    refundCalls += 1;
    const since = Number(url.searchParams.get("created[gte]") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const after = url.searchParams.get("starting_after");
    const window = refunds.filter((row) => (row.created as number) >= since);
    const start = after ? window.findIndex((row) => row.id === after) + 1 : 0;
    if (after && start === 0) return answer({ error: { message: "No such refund" } }, 400);
    const data = window.slice(start, start + limit);
    return answer({ object: "list", data, has_more: start + limit < window.length });
  }
  if (/^\/payment_intents\/pi_/.test(path)) return answer({ id: path.split("/").pop(), object: "payment_intent", metadata: {} });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** A refund of part of a charge: it takes nothing back and needs no lookup, so it only fills the pages. */
const partial = (i: number) => ({
  id: `re_LicPassFill${String(i).padStart(4, "0")}`,
  object: "refund",
  amount: 100,
  created: NOW - 60 - i,
  status: "succeeded",
  payment_intent: `pi_LicPassFill${String(i).padStart(4, "0")}`,
  charge: { object: "charge", amount: 2900, amount_refunded: 100, refunded: false },
});
const full = (id: string, pi: string, created: number) => ({
  id,
  object: "refund",
  amount: 2900,
  created,
  status: "succeeded",
  payment_intent: pi,
  charge: { object: "charge", amount: 2900, amount_refunded: 2900, refunded: true },
});
const run = async (): Promise<number | "threw"> => {
  try {
    return await revokeRefunded(store, Date.now() + 10_000);
  } catch {
    return "threw";
  }
};
const anchorOf = async () => (await redis.pipeline([["GET", `nl:keys:${store.statsId}:refunds:since`]]))[0];
const passKey = () => `nl:keys:${store.statsId}:refunds:pass`;

let store: Store;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "licencepass", "Licence Pass", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_LicencePass001", subscriptionId: "sub_LicencePass001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Kiln App", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/app");
  await setProductKeys(OWNER, made.product.id, { source: "generated", prefix: "KILN", groups: 4, groupLength: 4, lowAt: 0 });
  store = (await storeForEmail(OWNER))!;
  const app = (await readListing(store, made.product.id))!;
  const sale = async (ref: string, pi: string) => {
    const given = await keyForSale(store, app, ref, "buyer@example.com");
    if (given?.state !== "issued") throw new Error("no key");
    sessionsByPayment[pi] = [{ id: ref, object: "checkout.session", metadata: { store: "licencepass", product: made.product.id } }];
    return given.key;
  };

  part("More refunds since the anchor than one run reads: the oldest is still reached");
  const old = await sale("cs_test_licpass000001", "pi_LicPassOld0001");
  refunds = [...Array.from({ length: 349 }, (_, i) => partial(i)), full("re_LicPassOld0001", "pi_LicPassOld0001", NOW - 5_000)];
  const results: (number | "threw")[] = [];
  for (let i = 0; i < 4 && (await checkKey(store, app, old)) !== "revoked"; i += 1) results.push(await run());
  is("the key of the oldest refunded sale is revoked within a few runs", await checkKey(store, app, old), "revoked");
  is("no run threw", results.includes("threw"), false);
  is("the anchor moved once the list was read to its end", Number(await anchorOf()) >= NOW - 5_000, true);
  is("and the pass is let go", (await redis.pipeline([["GET", passKey()]]))[0], null);

  part("A run that resumes reads the newest page first");
  redis.clear();
  await claimHandle(OWNER, "licencepass", "Licence Pass", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_LicencePass001", subscriptionId: "sub_LicencePass001", active: true, period: paidPeriod() });
  const again = await addProduct(OWNER, "Kiln App", "", "29", null);
  if (!again.ok) throw new Error("no product");
  await setProductLink(OWNER, again.product.id, "https://example.com/app");
  await setProductKeys(OWNER, again.product.id, { source: "generated", prefix: "KILN", groups: 4, groupLength: 4, lowAt: 0 });
  store = (await storeForEmail(OWNER))!;
  const app2 = (await readListing(store, again.product.id))!;
  const sale2 = async (ref: string, pi: string) => {
    const given = await keyForSale(store, app2, ref, "buyer@example.com");
    if (given?.state !== "issued") throw new Error("no key");
    sessionsByPayment[pi] = [{ id: ref, object: "checkout.session", metadata: { store: "licencepass", product: again.product.id } }];
    return given.key;
  };
  const older = await sale2("cs_test_licpass000002", "pi_LicPassOld0002");
  refunds = [...Array.from({ length: 449 }, (_, i) => partial(i)), full("re_LicPassOld0002", "pi_LicPassOld0002", NOW - 5_000)];
  is("the first run reads only part of the list", await run(), 0);
  is("and keeps where it stopped", typeof (await redis.pipeline([["GET", passKey()]]))[0], "string");
  const fresh = await sale2("cs_test_licpass000003", "pi_LicPassNew0003");
  refunds = [full("re_LicPassNew0003", "pi_LicPassNew0003", NOW - 1), ...refunds];
  refundCalls = 0;
  await run();
  is("a refund made meanwhile is read in the run that resumes", await checkKey(store, app2, fresh), "revoked");
  for (let i = 0; i < 4 && (await checkKey(store, app2, older)) !== "revoked"; i += 1) await run();
  is("and the oldest is still reached", await checkKey(store, app2, older), "revoked");

  part("A pass kept in another shape, or from the store's earlier account, starts over");
  await redis.pipeline([["SET", passKey(), "not json"]]);
  is("a pass not readable is not trusted: the run reads from the top", [await run(), refundCalls > 0], [0, true]);
  await redis.pipeline([["SET", passKey(), JSON.stringify({ since: 0, after: "re_LicPassFill0100", newest: 0, account: "acct_1OtherAccount" })]]);
  refundCalls = 0;
  is("a pass of another account is not followed", [await run(), refundCalls > 0], [0, true]);

  done();
}

void main();
