/**
 * A full refund still pending denies the sale's key only while it is pending (Claude 2's focal money review of #2868
 * at ea3794beb4, comment 6732750465, LOW). Synthetic only: the in-memory Redis double and a stand-in for the
 * creator's Stripe account; the real revokeRefunded, keyForSale, addKeys and checkKey.
 *
 * Before: the refund job wrote the final refunded mark (REFUNDED_SALE) for a keyless sale on a full refund still
 * `pending` and read the refund. When that refund then failed or was canceled, the paid sale could never get its key,
 * and nothing could clear the mark. Now a pending refund writes a mark of its own, which denies the key exactly like
 * the final one, and leaves the refund unread. The next runs read the refund again: `succeeded` (or a lost dispute)
 * turns the mark final, and only a refund Stripe answers exactly `failed` or `canceled` clears it. Both changes are a
 * compare-and-swap on the mark itself, so a key given in between is never overwritten and never left valid (the HIGH
 * of the same review stays closed). Anything unknown keeps the key denied and the refund unread.
 */
import { type Store, claimHandle, ensureStatsId, addProduct, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { REFUNDED_SALE, addKeys, checkKey, keyForSale, readKeyList, revokeRefunded } from "@/lib/licence-keys";
import { readListing } from "@/lib/catalog";
import type { Listing } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_licence_pending_mark";
const OWNER = "licencepending@example.com";
const ACCOUNT = "acct_1TestLicPend1";
const NOW = Math.floor(Date.now() / 1000);

const sessionsByPayment: Record<string, Record<string, unknown>[]> = {};
let refunds: Record<string, unknown>[] = [];
let sessionsAnswer: "list" | "broken" = "list";
/** How the charge's own refunds (GET /refunds?charge=) are answered, and the charges asked about. */
let chargeRefundsAnswer: "list" | "broken" | "more" = "list";
const chargeReads: string[] = [];
/** The charge a refund row names, as an id or its expanded object. */
const chargeIdOf = (row: Record<string, unknown>) => (typeof row.charge === "string" ? row.charge : ((row.charge as { id?: string } | null)?.id ?? ""));
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return sessionsAnswer === "broken" ? answer({ object: "list" }) : list(sessionsByPayment[url.searchParams.get("payment_intent") ?? ""] ?? []);
  if (path === "/refunds" && url.searchParams.has("charge")) {
    const charge = url.searchParams.get("charge") ?? "";
    chargeReads.push(charge);
    if (chargeRefundsAnswer === "broken") return answer({ object: "list" });
    // Stripe lists a charge's refunds with the charge as its id (not expanded on this read).
    const rows = refunds.filter((row) => chargeIdOf(row) === charge).map((row) => ({ ...row, charge }));
    return chargeRefundsAnswer === "more" ? answer({ object: "list", data: rows, has_more: true }) : list(rows);
  }
  if (path === "/refunds") return list(refunds);
  if (/^\/payment_intents\/pi_/.test(path)) return answer({ id: path.split("/").pop(), object: "payment_intent", metadata: {} });
  if (path === "/events") return list([]);
  return list([]);
}) as typeof fetch;

type Command = (string | number)[];
const memory = redis.pipeline.bind(redis);
/** The double with LPOP, which it does not implement: LINDEX 0 then LTRIM, one test process, nothing in between. */
const real = (async (commands: Command[]) => {
  if (!commands.some((command) => command[0] === "LPOP")) return memory(commands);
  const out: unknown[] = [];
  for (const command of commands) {
    if (command[0] !== "LPOP") {
      out.push((await memory([command]))[0]);
      continue;
    }
    const [head] = await memory([["LINDEX", command[1], 0]]);
    if (typeof head === "string") await memory([["LTRIM", command[1], 1, -1]]);
    out.push(typeof head === "string" ? head : null);
  }
  return out;
}) as typeof redis.pipeline;
redis.pipeline = real;

type Status = "pending" | "succeeded" | "failed" | "canceled";
/** A refund row of GET /refunds as Stripe gives it: a full refund going through sets the charge refunded, a failed or canceled one sets it back. */
const refundRow = (id: string, pi: string, status: Status) => {
  const back = status === "pending" || status === "succeeded";
  return { id, object: "refund", created: NOW - 30, status, payment_intent: pi, charge: { object: "charge", amount: 2900, amount_refunded: back ? 2900 : 0, refunded: back } };
};
let store: Store;
const run = async (): Promise<number | "threw"> => {
  try {
    return await revokeRefunded(store, Date.now() + 10_000);
  } catch {
    return "threw";
  }
};
const seenOf = async (id: string) => (await real([["SISMEMBER", `nl:keys:${store.statsId}:refunds:seen`, id]]))[0];
const placeOf = async (product: Listing, reference: string) => (await real([["HGET", `nl:keys:${store.statsId}:${product.id}:sale`, reference]]))[0];
/** A mark the job leaves in a sale's place: text that is not a key (no key has a space). */
const isMark = (value: unknown) => typeof value === "string" && /\s/.test(value) && readKeyList(value).keys.length === 0;
/** The pending refund's own mark: a mark, not the final one. */
const isPendingMark = (value: unknown) => isMark(value) && value !== REFUNDED_SALE;
/** The compare-and-swap the job turns or clears a pending mark with. */
const isSwap = (command: Command) => String(command[0]).toUpperCase() === "EVAL" && String(command[1]).includes("license-sale-swap");

async function give(product: Listing, reference: string, email = "buyer@example.com"): Promise<unknown> {
  try {
    return await keyForSale(store, product, reference, email);
  } catch (error) {
    return error instanceof Error ? error.name : "threw";
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "licencepending", "Licence Pending", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_LicencePend001", subscriptionId: "sub_LicencePend001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Kiln App", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/app");
  await setProductKeys(OWNER, made.product.id, { source: "generated", prefix: "KILN", groups: 4, groupLength: 4, lowAt: 0 });
  const pooled = await addProduct(OWNER, "Glaze Pack", "", "19", null);
  if (!pooled.ok) throw new Error("no pool product");
  await setProductLink(OWNER, pooled.product.id, "https://example.com/glaze");
  await setProductKeys(OWNER, pooled.product.id, { source: "pool", prefix: "", groups: 4, groupLength: 4, lowAt: 0 });
  store = (await storeForEmail(OWNER))!;
  const app = (await readListing(store, made.product.id))!;
  const pack = (await readListing(store, pooled.product.id))!;
  const waiting = `nl:keys:${store.statsId}:${pack.id}:waiting`;
  /** A paid checkout of this store for a product, with one refund of the given status; its key not given yet. */
  const sale = (n: string, product: Listing, status: Status) => {
    const reference = `cs_test_licpend0000${n}`;
    const pi = `pi_LicencePend00${n}`;
    const id = `re_LicencePend00${n}`;
    sessionsByPayment[pi] = [{ id: reference, object: "checkout.session", metadata: { store: "licencepending", product: product.id } }];
    refunds = [refundRow(id, pi, status)];
    return { reference, pi, id, set: (next: Status) => (refunds = [refundRow(id, pi, next)]) };
  };

  part("1. LOW: a full refund still pending, read before the sale has a key, denies the key and stays unread");
  const failing = sale("01", app, "pending");
  is("the run revokes nothing and leaves the pending refund unread", [await run(), await seenOf(failing.id)], [0, 0]);
  is("the sale's place holds the pending mark, not the final one", isPendingMark(await placeOf(app, failing.reference)), true);
  is("while it is pending, keyForSale gives no key", await give(app, failing.reference), null);
  is("a run while it is still pending changes nothing", [await run(), await seenOf(failing.id), isPendingMark(await placeOf(app, failing.reference))], [0, 0, true]);

  part("2. The refund fails: the mark is cleared, the refund is read, and the paid sale gets its key");
  failing.set("failed");
  is("the run reads the failed refund", [await run(), await seenOf(failing.id)], [0, 1]);
  is("the sale's place is empty again", await placeOf(app, failing.reference), null);
  const given = (await give(app, failing.reference)) as { state?: string; key?: string; revoked?: boolean } | null;
  is("keyForSale now gives a key, and it is valid", [given?.state, given?.revoked, await checkKey(store, app, given?.key ?? "")], ["issued", false, "valid"]);
  is("a later run changes nothing", [await run(), await checkKey(store, app, given?.key ?? "")], [0, "valid"]);

  part("3. A pending refund that is canceled clears its mark the same way");
  const canceled = sale("02", app, "pending");
  await run();
  canceled.set("canceled");
  is("the run reads the canceled refund and the place is empty", [await run(), await seenOf(canceled.id), await placeOf(app, canceled.reference)], [0, 1, null]);
  is("the sale gets a valid key", ((await give(app, canceled.reference)) as { state?: string } | null)?.state, "issued");

  part("4. A pending refund that succeeds turns the mark final: the key stays denied for good");
  const settles = sale("03", app, "pending");
  await run();
  settles.set("succeeded");
  is("the run reads the refund", [await run(), await seenOf(settles.id)], [0, 1]);
  is("the place holds the final mark", await placeOf(app, settles.reference), REFUNDED_SALE);
  is("keyForSale gives no key", await give(app, settles.reference), null);

  part("5. HIGH stays closed: a key settled in the moment between the read of the pending mark and its swap is revoked");
  const raced = sale("04", app, "pending");
  await run();
  raced.set("succeeded");
  let racedKey = "";
  let swapped = false;
  redis.pipeline = (async (commands: Command[]) => {
    if (!swapped && commands.some(isSwap)) {
      swapped = true;
      // Another run cleared the mark, and the buyer's page settled a key, just before this swap.
      await real([["HDEL", `nl:keys:${store.statsId}:${app.id}:sale`, raced.reference]]);
      redis.pipeline = real;
      racedKey = ((await give(app, raced.reference)) as { key?: string } | null)?.key ?? "";
      redis.pipeline = intercept;
    }
    return real(commands);
  }) as typeof redis.pipeline;
  const intercept = redis.pipeline;
  const racedRun = await run();
  redis.pipeline = real;
  is("the swap saw the key, not its mark: the refund stays unread and the key is not overwritten", [swapped, racedRun, await seenOf(raced.id), await placeOf(app, raced.reference) === racedKey], [true, 0, 0, true]);
  is("the next run revokes that key and reads the refund", [await run(), await seenOf(raced.id), await checkKey(store, app, racedKey)], [1, 1, "revoked"]);

  part("6. Rule 24: a swap answered in an unknown shape keeps the key denied and the refund unread");
  const odd = sale("05", app, "pending");
  await run();
  odd.set("failed");
  redis.pipeline = (async (commands: Command[]) => (commands.some(isSwap) ? [{ unexpected: true }] : real(commands))) as typeof redis.pipeline;
  const oddRun = await run();
  redis.pipeline = real;
  is("the failed refund stays unread and the mark stays", [oddRun === "threw" ? 0 : oddRun, await seenOf(odd.id), isPendingMark(await placeOf(app, odd.reference))], [0, 0, true]);
  is("still no key", await give(app, odd.reference), null);
  is("the next healthy run clears it", [await run(), await seenOf(odd.id), await placeOf(app, odd.reference)], [0, 1, null]);

  part("7. A failed refund whose sale cannot be told is not read, and the mark stays");
  const unknown = sale("06", app, "pending");
  await run();
  unknown.set("failed");
  sessionsAnswer = "broken";
  is("the run leaves the failed refund unread", [await run(), await seenOf(unknown.id), isPendingMark(await placeOf(app, unknown.reference))], [0, 0, true]);
  sessionsAnswer = "list";
  is("read once the checkout can be told", [await run(), await seenOf(unknown.id), await placeOf(app, unknown.reference)], [0, 1, null]);

  part("8. A pool: a buyer waiting on an empty pool keeps the place while the refund is pending, and is served once it fails");
  const waits = await give(pack, "cs_test_licpend000007", "waits@example.com");
  is("the buyer waits", waits, { state: "waiting" });
  const pooledSale = sale("07", pack, "pending");
  is("the pending refund stays unread and the waiting place is kept", [await run(), await seenOf(pooledSale.id), (await real([["HEXISTS", waiting, pooledSale.reference]]))[0]], [0, 0, 1]);
  await addKeys(store, pack, ["GLAZE-AAAA-BBBB-CCCC"]);
  is("an upload while it is pending gives it no key, and the key stays in the pool", [await give(pack, pooledSale.reference), (await real([["LLEN", `nl:keys:${store.statsId}:${pack.id}:pool`]]))[0]], [null, 1]);
  pooledSale.set("failed");
  is("the failed refund is read and the mark cleared", [await run(), await seenOf(pooledSale.id), await placeOf(pack, pooledSale.reference)], [0, 1, null]);
  is("the buyer now gets the pool's key", ((await give(pack, pooledSale.reference)) as { state?: string; key?: string } | null)?.key, "GLAZE-AAAA-BBBB-CCCC");

  part("9. A sale that already had a key keeps it while a full refund is pending, and loses it once it goes through");
  const keyed = (await give(app, "cs_test_licpend000008")) as { key?: string };
  const keyedSale = sale("08", app, "pending");
  // Regra 23: this asserted [1, 1, "revoked"] (revoked and read at once). Claude 5's pre-review of
  // claude5/licence-refunds-combined, HIGH 2: a pending refund that then failed left the paid sale's key revoked for
  // good, so a pending one now takes nothing back and stays unread.
  is("pending: nothing revoked, the refund unread, the key valid", [await run(), await seenOf(keyedSale.id), await checkKey(store, app, keyed.key ?? "")], [0, 0, "valid"]);
  is("still pending next run: the same", [await run(), await seenOf(keyedSale.id), await checkKey(store, app, keyed.key ?? "")], [0, 0, "valid"]);
  keyedSale.set("failed");
  is("failed: read, the paid sale's key still valid", [await run(), await seenOf(keyedSale.id), await checkKey(store, app, keyed.key ?? "")], [0, 1, "valid"]);
  const settled = (await give(app, "cs_test_licpend000010")) as { key?: string };
  const settledSale = sale("10", app, "pending");
  is("another pending: the key valid", [await run(), await checkKey(store, app, settled.key ?? "")], [0, "valid"]);
  settledSale.set("succeeded");
  is("succeeded: revoked and read", [await run(), await seenOf(settledSale.id), await checkKey(store, app, settled.key ?? "")], [1, 1, "revoked"]);

  part("10. Unchanged: a failed refund of a sale with a valid key and no mark is read and changes nothing");
  const kept = (await give(app, "cs_test_licpend000009")) as { key?: string };
  const keptSale = sale("09", app, "failed");
  is("read, the key still valid", [await run(), await seenOf(keptSale.id), await checkKey(store, app, kept.key ?? "")], [0, 1, "valid"]);

  part("11. HIGH (Claude 2's focal review of #2868 at 9fa5c95602): a full refund made of a succeeded part and a pending rest takes nothing back while the rest is pending");
  // A $29 sale: $10 refunded and succeeded, the other $19 refunded and still pending. Stripe counts a pending refund in
  // the charge's amount_refunded, so the charge reads refunded in full on both rows, the succeeded $10 one too.
  const CHARGE_AMOUNT = 2900;
  /** Both refunds of one charge as GET /refunds gives them, each with the charge expanded as it reads now. */
  const split = (n: string, tenStatus: Status, nineteen: Status | null, nineteenFirst = false) => {
    const pi = `pi_LicencePend00${n}`;
    const charge = `ch_LicencePendCh${n}`;
    const counts = (status: Status | null) => status === "pending" || status === "succeeded";
    const back = (counts(tenStatus) ? 1000 : 0) + (counts(nineteen) ? 1900 : 0);
    const charged = { id: charge, object: "charge", amount: CHARGE_AMOUNT, amount_refunded: back, refunded: back >= CHARGE_AMOUNT };
    const ten = { id: `re_LicencePendTen${n}`, object: "refund", amount: 1000, created: nineteenFirst ? NOW - 20 : NOW - 40, status: tenStatus, payment_intent: pi, charge: charged };
    const rest = nineteen ? [{ id: `re_LicencePendNin${n}`, object: "refund", amount: 1900, created: nineteenFirst ? NOW - 40 : NOW - 20, status: nineteen, payment_intent: pi, charge: charged }] : [];
    // Newest first, as Stripe lists them.
    refunds = [ten, ...rest].sort((a, b) => b.created - a.created);
    return { ten: ten.id, nineteen: `re_LicencePendNin${n}`, charge };
  };
  const splitSale = (n: string, product: Listing) => {
    const reference = `cs_test_licpend0000${n}`;
    sessionsByPayment[`pi_LicencePend00${n}`] = [{ id: reference, object: "checkout.session", metadata: { store: "licencepending", product: product.id } }];
    return reference;
  };

  // Probe A: both rows read in the same run.
  const aRef = splitSale("11", app);
  const aKey = ((await give(app, aRef)) as { key?: string }).key ?? "";
  let ids = split("11", "succeeded", "pending");
  is("A: the $10 succeeded and the $19 pending in one run: nothing revoked, the key valid, neither refund read", [await run(), await checkKey(store, app, aKey), await seenOf(ids.ten), await seenOf(ids.nineteen)], [0, "valid", 0, 0]);
  ids = split("11", "succeeded", "failed");
  is("A: the $19 fails: the key of a sale mostly paid stays valid", [await run(), await checkKey(store, app, aKey)], [0, "valid"]);

  // Probe A the other way round: the pending $19 made first, the succeeded $10 after it (listed first).
  const a2Ref = splitSale("12", app);
  const a2Key = ((await give(app, a2Ref)) as { key?: string }).key ?? "";
  split("12", "succeeded", "pending", true);
  is("A2: the succeeded $10 listed before the pending $19: nothing revoked, the key valid", [await run(), await checkKey(store, app, a2Key)], [0, "valid"]);
  split("12", "succeeded", "failed", true);
  is("A2: the $19 fails: the key stays valid", [await run(), await checkKey(store, app, a2Key)], [0, "valid"]);

  // Probe B: the $10 row read alone first; the pending $19 arrives next run.
  const bRef = splitSale("13", app);
  const bKey = ((await give(app, bRef)) as { key?: string }).key ?? "";
  split("13", "succeeded", null);
  is("B: the $10 alone changes nothing", [await run(), await checkKey(store, app, bKey)], [0, "valid"]);
  ids = split("13", "succeeded", "pending");
  is("B: the pending $19 arrives: the $10 row, still in the window, revokes nothing", [await run(), await checkKey(store, app, bKey), await seenOf(ids.ten)], [0, "valid", 0]);
  ids = split("13", "succeeded", "succeeded");
  const bThrough = await run();
  is("B: the $19 goes through: the key is revoked and both refunds read", [typeof bThrough === "number" && bThrough >= 1, await checkKey(store, app, bKey), await seenOf(ids.ten), await seenOf(ids.nineteen)], [true, "revoked", 1, 1]);

  // Rule 30, the same harm on a sale with no key yet: the succeeded $10 must not write the final mark while the $19 is pending.
  const cRef = splitSale("14", app);
  split("14", "succeeded", "pending");
  is("C: a keyless sale gets the pending mark, not the final one", [await run(), isPendingMark(await placeOf(app, cRef))], [0, true]);
  split("14", "succeeded", "failed");
  await run();
  is("C: the $19 fails: the mark is cleared and the paid sale gets a valid key", ((await give(app, cRef)) as { state?: string } | null)?.state, "issued");

  // Rule 24: the charge's refunds answered in an unknown shape, or more than one page, is not "none pending".
  const dRef = splitSale("15", app);
  const dKey = ((await give(app, dRef)) as { key?: string }).key ?? "";
  ids = split("15", "succeeded", "succeeded");
  chargeRefundsAnswer = "broken";
  is("D: the charge's refunds in an unknown shape: nothing revoked, the refunds unread", [await run(), await checkKey(store, app, dKey), await seenOf(ids.ten)], [0, "valid", 0]);
  chargeRefundsAnswer = "more";
  is("D: the charge's refunds with more than one page: the same", [await run(), await checkKey(store, app, dKey), await seenOf(ids.ten)], [0, "valid", 0]);
  chargeRefundsAnswer = "list";
  is("D: read in full, every part through: revoked and read", [(await run()) !== 0, await checkKey(store, app, dKey), await seenOf(ids.ten), await seenOf(ids.nineteen)], [true, "revoked", 1, 1]);

  // A single refund of the whole charge needs no read of the charge's refunds.
  const eRef = splitSale("16", app);
  const eKey = ((await give(app, eRef)) as { key?: string }).key ?? "";
  refunds = [{ id: "re_LicencePendWhole16", object: "refund", amount: CHARGE_AMOUNT, created: NOW - 30, status: "succeeded", payment_intent: "pi_LicencePend0016", charge: { id: "ch_LicencePendCh16", object: "charge", amount: CHARGE_AMOUNT, amount_refunded: CHARGE_AMOUNT, refunded: true } }];
  chargeReads.length = 0;
  is("E: one refund of the whole charge: revoked, with no read of the charge's refunds", [await run(), await checkKey(store, app, eKey), chargeReads.length], [1, "revoked", 0]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
