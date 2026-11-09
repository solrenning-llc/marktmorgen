/**
 * The license keys' refund job reads on past the refunds a run may read (Claude 5's audit of the Stripe reads, A3).
 * Synthetic only: the in-memory Redis double and a stand-in for the creator's Stripe account that lists refunds newest
 * first, honoring `created[gte]` and `starting_after`; the real revokeRefunded, keyForSale and checkKey.
 *
 * Before: every run read the refunds from the newest one again, at most REFUND_PAGES pages of a hundred, and the anchor
 * moved only after a read to the end. With more refunds since the anchor than a run reads (300 newer partial refunds,
 * a refund row that does not read, a pending refund holding the anchor, a store's lookups spent), the oldest refunds
 * were never read: the key of a sale refunded in full stayed "valid" until the anchor lapsed, and then the gap was
 * skipped. Now a pass over the refunds goes on from where the last run stopped (one key, kept seven days), a run that
 * resumes a pass first reads the newest page so a refund made meanwhile does not wait for the pass, and the anchor moves
 * only at the end of a pass, never past a refund left unknown or pending in it.
 */
import * as licenceKeys from "@/lib/licence-keys";
import { PENDING_REFUND_SALE, checkKey, keyForSale, revokeRefunded } from "@/lib/licence-keys";
import { type Listing, type Store, addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { NOT_A_COST } from "./plan-cost-registry";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_licence_progress";
const OWNER = "kilnprogress@example.com";
const HANDLE = "kilnprogress";
const NOW = Math.floor(Date.now() / 1000);

type Row = Record<string, unknown>;
const sessionsByPayment: Record<string, Row[]> = {};
/** The account's refunds, newest first. */
let refunds: Row[] = [];
let refundPages = 0;
let paymentReads = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/refunds") {
    refundPages += 1;
    const gte = Number(url.searchParams.get("created[gte]") ?? "0");
    const window = refunds.filter((row) => typeof row.created !== "number" || row.created >= gte);
    const after = url.searchParams.get("starting_after");
    const at = after ? window.findIndex((row) => row.id === after) : -1;
    // Stripe answers a cursor it does not know with an error, never with the first page.
    if (after && at < 0) return answer({ error: { type: "invalid_request_error", message: "No such refund" } }, 400);
    const from = after ? at + 1 : 0;
    const limit = Number(url.searchParams.get("limit") ?? "10");
    return answer({ object: "list", data: window.slice(from, from + limit), has_more: from + limit < window.length });
  }
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessionsByPayment[url.searchParams.get("payment_intent") ?? ""] ?? [], has_more: false });
  if (/^\/payment_intents\/pi_/.test(path)) {
    paymentReads += 1;
    return answer({ id: path.split("/").pop(), object: "payment_intent", metadata: {} });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

type Command = (string | number)[];
const memory = redis.pipeline.bind(redis);
/** Every command sent, for the place's cost. */
let sent: Command[] = [];
redis.pipeline = (async (commands: Command[]) => {
  sent.push(...commands);
  return memory(commands);
}) as typeof redis.pipeline;

const partial = (n: number, created: number): Row => ({
  id: `re_Partial${String(n).padStart(6, "0")}`,
  object: "refund",
  created,
  status: "succeeded",
  payment_intent: `pi_Other${String(n).padStart(6, "0")}`,
  charge: { object: "charge", amount: 2900, amount_refunded: 100, refunded: false },
});
/** `count` partial refunds of other sales, newest first, all newer than `older`. */
const partials = (count: number, older: number, tag = 0): Row[] => Array.from({ length: count }, (_, i) => partial(tag * 10_000 + i, older + count - i));
const full = (id: string, pi: string, created: number, status: "succeeded" | "pending" | "failed" = "succeeded"): Row => {
  const back = status !== "failed";
  return { id, object: "refund", created, status, payment_intent: pi, charge: { object: "charge", amount: 2900, amount_refunded: back ? 2900 : 0, refunded: back } };
};

let store: Store;
let app: Listing;
const anchorKey = () => `nl:keys:${store.statsId}:refunds:since`;
const passKey = () => `nl:keys:${store.statsId}:refunds:pass`;
const seenKey = () => `nl:keys:${store.statsId}:refunds:seen`;
const anchorOf = async () => Number((await memory([["GET", anchorKey()]]))[0] ?? 0);
const placeOf = async (reference: string) => (await memory([["HGET", `nl:keys:${store.statsId}:${app.id}:sale`, reference]]))[0];
/** A new window: no anchor, no pass, nothing read. */
const fresh = async () => {
  await memory([["DEL", anchorKey(), passKey(), seenKey(), `nl:lostdispute:cursor:keys:${store.statsId}`]]);
  refundPages = 0;
};
let saleNo = 0;
/** A paid checkout of this store for the app; its key given unless `keyless`. */
async function sale(keyless = false): Promise<{ reference: string; pi: string; key: string }> {
  saleNo += 1;
  const n = String(saleNo).padStart(4, "0");
  const reference = `cs_test_progress${n}`;
  const pi = `pi_Progress${n}`;
  sessionsByPayment[pi] = [{ id: reference, object: "checkout.session", metadata: { store: HANDLE, product: app.id } }];
  if (keyless) return { reference, pi, key: "" };
  const given = await keyForSale(store, app, reference, `buyer${n}@example.com`);
  if (given?.state !== "issued") throw new Error("no key");
  return { reference, pi, key: given.key };
}
/** Runs the five-minute job up to `most` times, until `until` holds; how many runs it took (most + 1 when never). */
async function runs(most: number, until: () => Promise<boolean>): Promise<number> {
  for (let run = 1; run <= most; run += 1) {
    await revokeRefunded(store, Date.now() + 10_000);
    if (await until()) return run;
  }
  return most + 1;
}
const revokedKey = (key: string) => async () => (await checkKey(store, app, key)) === "revoked";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Kiln Progress", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestProgress1", true);
  await setSubscription(OWNER, { customerId: "cus_Progress0001", subscriptionId: "sub_Progress0001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Firing App", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/firing-app");
  await setProductKeys(OWNER, made.product.id, { source: "generated", prefix: "FIRE", groups: 4, groupLength: 4, lowAt: 0 });
  store = (await storeForEmail(OWNER))!;
  app = (await readListing(store, made.product.id))!;

  part("1. The audit's proof: the key's full refund behind 300 newer partial refunds");
  {
    await fresh();
    const control = await sale();
    refunds = [...partials(299, NOW - 3000), full("re_ProgressCtl001", control.pi, NOW - 3600)];
    is("control, 299 newer partial refunds: revoked in the first run", await runs(5, revokedKey(control.key)), 1);
    await fresh();
    const keyed = await sale();
    refunds = [...partials(300, NOW - 3000), full("re_ProgressKey001", keyed.pi, NOW - 3600)];
    const took = await runs(5, revokedKey(keyed.key));
    is("300 newer partial refunds: the key is revoked within five runs", took <= 5, true);
    is("the key reads revoked", await checkKey(store, app, keyed.key), "revoked");
    is("no run read more than REFUND_PAGES (3) pages of refunds", refundPages <= 3 * Math.min(took, 5), true);
  }

  part("2. A pending refund in the pass holds the anchor, never the pass");
  {
    await fresh();
    const keyless = await sale(true);
    const keyed = await sale();
    const pendingCreated = NOW - 3000;
    const pending = full("re_ProgressPend01", keyless.pi, pendingCreated, "pending");
    const older = [full("re_ProgressKey002", keyed.pi, NOW - 3500)];
    refunds = [...partials(300, NOW - 2900, 1), pending, ...older];
    const took = await runs(5, revokedKey(keyed.key));
    is("the older full refund behind it is revoked within five runs", took <= 5, true);
    is("the keyless sale holds the pending mark: no key while it is pending", await placeOf(keyless.reference), PENDING_REFUND_SALE);
    for (let i = 0; i < 4; i += 1) await revokeRefunded(store, Date.now() + 10_000);
    is("the anchor never moves past the pending refund", (await anchorOf()) <= pendingCreated, true);
    // Stripe answers the same refund failed: the next pass reads it again and clears the mark.
    refunds = [...partials(300, NOW - 2900, 1), full("re_ProgressPend01", keyless.pi, pendingCreated, "failed"), ...older];
    const cleared = await runs(6, async () => (await placeOf(keyless.reference)) === null);
    is("the failed refund clears the pending mark within six runs", cleared <= 6, true);
    const given = await keyForSale(store, app, keyless.reference, "keyless@example.com");
    is("the paid sale is given its key", given?.state, "issued");
  }

  part("3. A refund row that does not read holds the anchor, never the pass");
  {
    await fresh();
    const keyed = await sale();
    const odd = { id: "re_ProgressOdd001", object: "refund", created: NOW - 3200, status: "mystery", payment_intent: "pi_Odd0000001", charge: null };
    refunds = [...partials(150, NOW - 3000, 2), odd, ...partials(150, NOW - 3300, 3), full("re_ProgressKey003", keyed.pi, NOW - 3600)];
    const took = await runs(5, revokedKey(keyed.key));
    is("the full refund past the unreadable row is revoked within five runs", took <= 5, true);
    const start = NOW - 30 * 86_400;
    for (let i = 0; i < 4; i += 1) await revokeRefunded(store, Date.now() + 10_000);
    const anchor = await anchorOf();
    is("the anchor stays where the window began, before the unreadable row", anchor >= start - 5 && anchor <= start + 60, true);
  }

  part("4. A refund made while a pass goes on is read in the next run; the pass still reaches the oldest");
  {
    await fresh();
    const oldest = await sale();
    const late = await sale();
    refunds = [...partials(600, NOW - 3000, 4), full("re_ProgressKey004", oldest.pi, NOW - 3600)];
    await revokeRefunded(store, Date.now() + 10_000);
    refunds = [full("re_ProgressLate01", late.pi, NOW - 5), ...refunds];
    await revokeRefunded(store, Date.now() + 10_000);
    is("the new refund's key is revoked by the next run", await checkKey(store, app, late.key), "revoked");
    const took = await runs(5, revokedKey(oldest.key));
    is("the oldest refund's key is revoked within five more runs", took <= 5, true);
  }

  part("5. A store's lookups spent on a page: the next run goes on from the last refund it read");
  {
    await fresh();
    const keyed = await sale();
    // Refunds in full of payments that are not this store's: each takes three lookups (checkout, payment, plan).
    const foreign = Array.from({ length: 30 }, (_, i) => full(`re_ProgressFor${String(i).padStart(3, "0")}`, `pi_Foreign${String(i).padStart(6, "0")}`, NOW - 3100 - i));
    refunds = [...partials(280, NOW - 3000, 5), ...foreign, full("re_ProgressKey005", keyed.pi, NOW - 3600)];
    paymentReads = 0;
    const took = await runs(12, revokedKey(keyed.key));
    is("the key is revoked within twelve runs", took <= 12, true);
    is("every foreign refund was read once, not again run after run", paymentReads <= 30 + 12, true);
  }

  part("6. A pass kept in an unknown shape starts again from the anchor");
  {
    await fresh();
    const keyed = await sale();
    await memory([["SET", anchorKey(), String(NOW - 7200), "EX", 3600], ["SET", passKey(), "{\"after\":7}", "EX", 3600]]);
    refunds = [full("re_ProgressKey006", keyed.pi, NOW - 3600)];
    await revokeRefunded(store, Date.now() + 10_000);
    is("the refund since the anchor is read", await checkKey(store, app, keyed.key), "revoked");
  }

  part("6b. A pass whose place Stripe no longer knows starts again from the anchor, never stuck on it");
  {
    await fresh();
    const keyed = await sale();
    await memory([["SET", anchorKey(), String(NOW - 7200), "EX", 3600], ["SET", passKey(), JSON.stringify({ from: NOW - 7200, start: NOW - 60, after: "re_GoneFromStripe1", newest: NOW - 7200, floor: null }), "EX", 3600]]);
    // Behind a full page of newer refunds, so the newest page a resuming run reads first does not reach it.
    refunds = [...partials(100, NOW - 3000, 7), full("re_ProgressKey007", keyed.pi, NOW - 3600)];
    const took = await runs(2, revokedKey(keyed.key));
    is("the refund since the anchor is read within two runs", took <= 2, true);
    is("the anchor never moved past it", (await anchorOf()) >= NOW - 7200, true);
  }

  part("7. What a run sends for its place is registered (CX-123 rule 24)");
  {
    const listed = (licenceKeys as Record<string, unknown>).KEY_REFUND_PLACE_COMMANDS;
    is("the commands of the place are a number the job exports", typeof listed, "number");
    is("and named in the cost registry", typeof NOT_A_COST.KEY_REFUND_PLACE_COMMANDS, "string");
    await fresh();
    refunds = partials(450, NOW - 3000, 6);
    const placeKeys = new Set([anchorKey(), passKey(), seenKey()]);
    let most = 0;
    for (let run = 0; run < 4; run += 1) {
      sent = [];
      const before = refundPages;
      await revokeRefunded(store, Date.now() + 10_000);
      is(`run ${run + 1} reads at most REFUND_PAGES (3) pages of refunds`, refundPages - before <= 3, true);
      most = Math.max(most, sent.filter((command) => placeKeys.has(String(command[1]))).length);
    }
    is("no run sends more commands for its place than registered", typeof listed === "number" && most <= listed, true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
