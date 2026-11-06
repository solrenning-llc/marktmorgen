/**
 * Sweep A3 proof (CX-123 rules 24 and 30), synthetic only: the in-memory Redis double and a stand-in for the
 * creator's Stripe account. lib/licence-keys.ts revokeRefunded (the five-minute job that revokes the key of a sale
 * refunded in full):
 *
 * 1. Lines 637-646: the sale's key is read with HGET and a reply in an unknown shape is taken for "this sale has no
 *    key" (typeof key !== "string"), the refund is then marked read (SADD seen, line 643), and the anchor moves.
 *    The refunded buyer's key stays "valid" at the public check (/api/store/licence), and no later run looks at
 *    that refund again: the creator's software keeps accepting a key whose money went back.
 * 2. Lines 598-631: Stripe's list of checkouts for the refunded payment read with
 *    `Array.isArray(sessions.data) ? ... : []`: a 200 answer without its list is "no checkout", the lookups fall
 *    through to "not an offer, not a plan", and the refund is marked read with nothing revoked. lib/gifts.ts
 *    (refundsKnown) and lib/group-buy.ts (readStripePage) already refuse a list of unknown shape (rule 30).
 */
import { claimHandle, ensureStatsId, addProduct, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { checkKey, keyForSale, revokeRefunded } from "@/lib/licence-keys";
import { readListing } from "@/lib/catalog";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_sweep_a3_keys_only";
const OWNER = "sweepa3keys@example.com";
const ACCOUNT = "acct_1TestSweepKeys1";
const NOW = Math.floor(Date.now() / 1000);

const sessionsByPayment: Record<string, Record<string, unknown>[]> = {};
let refunds: Record<string, unknown>[] = [];
/** When set, the checkouts list for a payment answers 200 without its list. */
let sessionsShapeless = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    if (sessionsShapeless) return answer({ object: "list" });
    return list(sessionsByPayment[url.searchParams.get("payment_intent") ?? ""] ?? []);
  }
  if (path === "/refunds") return list(refunds);
  if (/^\/payment_intents\/pi_/.test(path)) return answer({ object: "payment_intent", metadata: {} });
  return list([]);
}) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const refund = (id: string, pi: string) => ({ id, object: "refund", created: NOW - 30, status: "succeeded", payment_intent: pi, charge: { object: "charge", amount: 2900, amount_refunded: 2900, refunded: true } });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "sweepkeys", "Sweep Keys", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_SweepKeys0001", subscriptionId: "sub_SweepKeys0001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Firing App", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/app");
  await setProductKeys(OWNER, made.product.id, { source: "generated", prefix: "FIRE", groups: 4, groupLength: 4, lowAt: 0 });
  const store = (await storeForEmail(OWNER))!;
  const app = (await readListing(store, made.product.id))!;
  const sale = async (ref: string, pi: string) => {
    const given = await keyForSale(store, app, ref, "buyer@example.com");
    if (given?.state !== "issued") throw new Error("no key");
    sessionsByPayment[pi] = [{ id: ref, metadata: { store: "sweepkeys", product: made.product.id } }];
    return given.key;
  };

  part("Healthy control: a full refund revokes its key");
  const good = await sale("cs_test_sweepkeys00001", "pi_SweepKeys0001");
  refunds = [refund("re_SweepKeys0001", "pi_SweepKeys0001")];
  is("revoked", [await revokeRefunded(store, Date.now() + 10_000), await checkKey(store, app, good)], [1, "revoked"]);

  part("1. DEFECT: the HGET of the sale's key answers in an unknown shape");
  const kept = await sale("cs_test_sweepkeys00002", "pi_SweepKeys0002");
  refunds = [refund("re_SweepKeys0002", "pi_SweepKeys0002")];
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.length === 1 && commands[0][0] === "HGET" && String(commands[0][1]).endsWith(":sale")) return [{ unexpected: true }];
    return real(commands);
  }) as typeof redis.pipeline;
  const first = await revokeRefunded(store, Date.now() + 10_000);
  redis.pipeline = real;
  const seen = (await real([["SISMEMBER", `nl:keys:${store.statsId}:refunds:seen`, "re_SweepKeys0002"]]))[0];
  is("DEFECT: nothing revoked, yet the refund is marked read", [first, seen], [0, 1]);
  const second = await revokeRefunded(store, Date.now() + 10_000);
  is("DEFECT: the next healthy run skips it as read, and the refunded key stays valid", [second, await checkKey(store, app, kept)], [0, "valid"]);

  part("2. DEFECT: Stripe's checkouts list for the payment answers 200 without its list");
  const kept2 = await sale("cs_test_sweepkeys00003", "pi_SweepKeys0003");
  refunds = [refund("re_SweepKeys0003", "pi_SweepKeys0003")];
  sessionsShapeless = true;
  const third = await revokeRefunded(store, Date.now() + 10_000);
  sessionsShapeless = false;
  const seen3 = (await real([["SISMEMBER", `nl:keys:${store.statsId}:refunds:seen`, "re_SweepKeys0003"]]))[0];
  is("DEFECT: nothing revoked, yet the refund is marked read", [third, seen3], [0, 1]);
  const fourth = await revokeRefunded(store, Date.now() + 10_000);
  is("DEFECT: the next run (Stripe healthy again) skips it, and the key stays valid", [fourth, await checkKey(store, app, kept2)], [0, "valid"]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
