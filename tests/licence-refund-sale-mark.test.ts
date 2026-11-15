/**
 * A refunded sale never ends up holding a valid license key (Claude 2's second money review of #2868, comment
 * 6732354680). Synthetic only: the in-memory Redis double and a stand-in for the creator's Stripe account; the real
 * revokeRefunded, keyForSale and checkKey.
 *
 * HIGH: a refund read before its sale had a key used to be marked read with nothing to revoke, and the key given
 * afterwards (the confirmation email, the offer's email, the buyer's list) stayed valid for good. The refund job now
 * writes a durable mark in the sale's place among the keys given (`:sale`, HSETNX), which is never a key (it has
 * spaces, and no key has one): a sale holding it is never given a key, and settle's HSETNX of a key and the mark's
 * cannot both win, so the race in between closes too.
 *
 * MEDIUM: a refund read between settle's two writes (the sale's key, then the key's record) found the key with no
 * record yet; setRevoked answered false and the refund was marked read, so the record written next was valid. A sale
 * that has a key whose record is not there yet is now unsure: the refund stays unread and the next run revokes it.
 *
 * The interleavings are real: the refund job runs from inside the database wrapper at the moment keyForSale sends
 * the command named, and keyForSale's command goes on afterwards.
 */
import { type Store, claimHandle, ensureStatsId, addProduct, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { addKeys, checkKey, keyCounts, keyForSale, readKeyList, revokeRefunded } from "@/lib/licence-keys";
import { ORDERS_KEY_COMMANDS } from "@/lib/buyer-orders-rules";
import { readListing } from "@/lib/catalog";
import { CLOSING, closingFamilyOf, countedInRoom } from "@/lib/data-families";
import { prepareStore, walkPage } from "@/lib/closed-store-data";
import type { Listing } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_licence_sale_mark";
const OWNER = "licencemark@example.com";
const ACCOUNT = "acct_1TestLicMark1";
const NOW = Math.floor(Date.now() / 1000);

const sessionsByPayment: Record<string, Record<string, unknown>[]> = {};
let refunds: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return list(sessionsByPayment[url.searchParams.get("payment_intent") ?? ""] ?? []);
  if (path === "/refunds") return list(refunds);
  if (/^\/payment_intents\/pi_/.test(path)) return answer({ id: path.split("/").pop(), object: "payment_intent", metadata: {} });
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

// Regra 23: the row now carries its own amount, as every refund Stripe sends does: a refund of the whole charge is whole
// on its own. Without it the job reads the charge's refunds first (Claude 2's focal money review of #2868, HIGH).
const refund = (id: string, pi: string) => ({ id, object: "refund", amount: 2900, created: NOW - 30, status: "succeeded", payment_intent: pi, charge: { object: "charge", amount: 2900, amount_refunded: 2900, refunded: true } });
let store: Store;
const run = async (): Promise<number | "threw"> => {
  try {
    return await revokeRefunded(store, Date.now() + 10_000);
  } catch {
    return "threw";
  }
};
const seenOf = async (id: string) => (await real([["SISMEMBER", `nl:keys:${store.statsId}:refunds:seen`, id]]))[0];
const saleKeyOf = async (product: Listing, reference: string) => (await real([["HGET", `nl:keys:${store.statsId}:${product.id}:sale`, reference]]))[0];
/** The script settle writes the sale's key with (HSETNX on `:sale`), and the one it writes the key's record with (`:info` and `:waiting`). */
const isEval = (command: Command) => ["EVAL", "EVALSHA"].includes(String(command[0]).toUpperCase());
const writesSale = (reference: string) => (command: Command) => isEval(command) && command.some((arg) => String(arg).endsWith(":sale")) && command.includes(reference);
const writesRecord = (reference: string) => (command: Command) => isEval(command) && command.some((arg) => String(arg).endsWith(":waiting")) && command.includes(reference);
/** The refunded mark the job leaves in a sale's place: text that is not a key (no key has a space), never a key itself. */
const isMark = (value: unknown) => typeof value === "string" && /\s/.test(value) && readKeyList(value).keys.length === 0;
/** The refund job's write of that mark (an order script naming `:sale` and the sale, not settle's, which carries a key). */
const marksSale = (reference: string) => (command: Command) => writesSale(reference)(command) && command.some((arg) => isMark(arg));

/** Runs the refund job once, from inside the database wrapper, just before the first command `when` picks is sent; then sends it. */
function interleave(when: (command: Command) => boolean): { result: () => number | "threw" | "not run" } {
  let result: number | "threw" | "not run" = "not run";
  let fired = false;
  redis.pipeline = (async (commands: Command[]) => {
    if (!fired && commands.some(when)) {
      fired = true;
      redis.pipeline = real;
      result = await run();
    }
    return real(commands);
  }) as typeof redis.pipeline;
  return { result: () => result };
}

/** keyForSale, its outcome by name when it throws. */
async function give(product: Listing, reference: string, email = "buyer@example.com"): Promise<unknown> {
  try {
    return await keyForSale(store, product, reference, email);
  } catch (error) {
    return error instanceof Error ? error.name : "threw";
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "licencemark", "Licence Mark", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_LicenceMark001", subscriptionId: "sub_LicenceMark001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Kiln App", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/app");
  await setProductKeys(OWNER, made.product.id, { source: "generated", prefix: "KILN", groups: 4, groupLength: 4, lowAt: 0 });
  const pooled = await addProduct(OWNER, "Glaze Pack", "", "19", null);
  if (!pooled.ok) throw new Error("no pool product");
  await setProductLink(OWNER, pooled.product.id, "https://example.com/glaze");
  await setProductKeys(OWNER, pooled.product.id, { source: "pool", prefix: "", groups: 4, groupLength: 4, lowAt: 50 });
  store = (await storeForEmail(OWNER))!;
  const app = (await readListing(store, made.product.id))!;
  const pack = (await readListing(store, pooled.product.id))!;
  const pool = `nl:keys:${store.statsId}:${pack.id}:pool`;
  const waiting = `nl:keys:${store.statsId}:${pack.id}:waiting`;
  /** A paid checkout of this store for a product, refunded in full, its key not given yet. */
  const refundedSale = (n: string, product: Listing) => {
    const reference = `cs_test_licmark0000${n}`;
    const pi = `pi_LicenceMark00${n}`;
    sessionsByPayment[pi] = [{ id: reference, object: "checkout.session", metadata: { store: "licencemark", product: product.id } }];
    refunds = [refund(`re_LicenceMark00${n}`, pi)];
    return { reference, refundId: `re_LicenceMark00${n}` };
  };

  part("Healthy control: a sale that was not refunded is given a valid key");
  const fine = await give(app, "cs_test_licmark000000");
  const fineKey = (fine as { key?: string }).key ?? "";
  is("given and valid", [(fine as { state?: string }).state, (fine as { revoked?: boolean }).revoked, await checkKey(store, app, fineKey)], ["issued", false, "valid"]);

  part("1. HIGH: the refund is read before the sale has a key (the buyer closed the tab, the creator refunded)");
  const early = refundedSale("01", app);
  is("the run revokes nothing and reads the refund", [await run(), await seenOf(early.refundId)], [0, 1]);
  is("the sale's place holds the refunded mark, never a key", isMark(await saleKeyOf(app, early.reference)), true);
  is("the confirmation email's keyForSale gives no key", await give(app, early.reference), null);
  is("the sale's place still holds the mark", isMark(await saleKeyOf(app, early.reference)), true);
  is("a later run revokes nothing and the refund stays read", [await run(), await seenOf(early.refundId)], [0, 1]);
  is("asked again (the offer's email, the buyer's list), still no key", await give(app, early.reference), null);
  is("the public check never answers valid for the mark", await checkKey(store, app, String(await saleKeyOf(app, early.reference))), "unknown");

  part("1b. HIGH, a pool: no key is taken from the creator's pool for a refunded sale, and no waiting place is kept");
  await addKeys(store, pack, ["GLAZE-AAAA-BBBB-CCCC", "GLAZE-DDDD-EEEE-FFFF"]);
  const poolEarly = refundedSale("02", pack);
  is("the run reads the refund", [await run(), await seenOf(poolEarly.refundId)], [0, 1]);
  is("keyForSale gives no key", await give(pack, poolEarly.reference), null);
  is("both keys are still in the pool, and the sale waits for none", [(await real([["LLEN", pool]]))[0], (await real([["HEXISTS", waiting, poolEarly.reference]]))[0]], [2, 0]);
  is("the studio counts no key given for it", (await keyCounts(store, pack)).issued, 0);

  part("2. HIGH, the race: the refund job runs just as settle writes the sale's key");
  const racing = refundedSale("03", app);
  const atSale = interleave(writesSale(racing.reference));
  const raced = await give(app, racing.reference);
  redis.pipeline = real;
  is("the refund job ran in between, found no key and read the refund", [atSale.result(), await seenOf(racing.refundId)], [0, 1]);
  is("settle loses to the mark: no key is given, and the made key is let go", [raced, isMark(await saleKeyOf(app, racing.reference))], [null, true]);
  is("asked again, still no key", await give(app, racing.reference), null);

  part("2b. HIGH, the race on a pool: the key taken out goes back");
  await addKeys(store, pack, ["GLAZE-GGGG-HHHH-JJJJ"]);
  const poolRace = refundedSale("04", pack);
  const before = (await real([["LLEN", pool]]))[0];
  const atPoolSale = interleave(writesSale(poolRace.reference));
  const poolRaced = await give(pack, poolRace.reference);
  redis.pipeline = real;
  is("no key given, the refund read, the pool as it was", [poolRaced, atPoolSale.result(), await seenOf(poolRace.refundId), (await real([["LLEN", pool]]))[0]], [null, 0, 1, before]);

  part("3. MEDIUM: the refund job runs between settle's two writes (the sale's key, then its record)");
  const between = refundedSale("05", app);
  const atRecord = interleave(writesRecord(between.reference));
  const split = await give(app, between.reference);
  redis.pipeline = real;
  const splitKey = (split as { key?: string }).key ?? "";
  is("the refund job found the key without its record: unsure, the refund stays unread", [atRecord.result(), await seenOf(between.refundId)], [0, 0]);
  is("the next run revokes the record written meanwhile and reads the refund", [await run(), await seenOf(between.refundId), await checkKey(store, app, splitKey)], [1, 1, "revoked"]);
  is("the buyer's key shows revoked", await give(app, between.reference), { state: "issued", key: splitKey, revoked: true });

  part("4. Rule 24: the mark's write answered in an unknown shape is not \"no key\"");
  const odd = refundedSale("06", app);
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.length === 1 && marksSale(odd.reference)(commands[0])) return [{ unexpected: true }];
    return real(commands);
  }) as typeof redis.pipeline;
  const oddRun = await run();
  redis.pipeline = real;
  is("the refund stays unread", [oddRun === "threw" ? 0 : oddRun, await seenOf(odd.refundId)], [0, 0]);
  is("the next healthy run marks the sale and reads the refund", [await run(), await seenOf(odd.refundId), isMark(await saleKeyOf(app, odd.reference))], [0, 1, true]);
  is("and no key is given for it", await give(app, odd.reference), null);

  part("4b. Rule 24: the sale's place read back empty after the mark lost is unknown, never \"no key\"");
  const taken = await give(app, "cs_test_licmark000007");
  const takenKey = (taken as { key?: string }).key ?? "";
  sessionsByPayment.pi_LicenceMark0007 = [{ id: "cs_test_licmark000007", object: "checkout.session", metadata: { store: "licencemark", product: app.id } }];
  refunds = [refund("re_LicenceMark0007", "pi_LicenceMark0007")];
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.length === 1 && commands[0][0] === "HGET" && String(commands[0][1]).endsWith(":sale") && commands[0][2] === "cs_test_licmark000007") return [null];
    return real(commands);
  }) as typeof redis.pipeline;
  const emptyRun = await run();
  redis.pipeline = real;
  is("the refund stays unread and the key is not taken for gone", [emptyRun === "threw" ? 0 : emptyRun, await seenOf("re_LicenceMark0007"), await checkKey(store, app, takenKey)], [0, 0, "valid"]);
  is("the next healthy run revokes it", [await run(), await checkKey(store, app, takenKey)], [1, "revoked"]);

  part("5. A buyer waiting on an empty pool who was refunded meanwhile does not hold up the next one");
  const emptyPool = await addProduct(OWNER, "Slip Pack", "", "9", null);
  if (!emptyPool.ok) throw new Error("no empty pool product");
  await setProductLink(OWNER, emptyPool.product.id, "https://example.com/slip");
  await setProductKeys(OWNER, emptyPool.product.id, { source: "pool", prefix: "", groups: 4, groupLength: 4, lowAt: 0 });
  store = (await storeForEmail(OWNER))!;
  const slip = (await readListing(store, emptyPool.product.id))!;
  const slipWaiting = `nl:keys:${store.statsId}:${slip.id}:waiting`;
  is("two buyers wait", [await give(slip, "cs_test_licmark000008", "first@example.com"), await give(slip, "cs_test_licmark000009", "second@example.com")], [{ state: "waiting" }, { state: "waiting" }]);
  // The first one's refund leaves its mark while its waiting place is still there (the job's HDEL not reached yet).
  await real([["HSETNX", `nl:keys:${store.statsId}:${slip.id}:sale`, "cs_test_licmark000008", String(await saleKeyOf(app, early.reference))]]);
  const upload = await addKeys(store, slip, ["SLIP-AAAA-BBBB-CCCC"]);
  is("the upload serves the second buyer, and lets the first one's place go", [upload.served, (await give(slip, "cs_test_licmark000009")) !== null, (await real([["HLEN", slipWaiting]]))[0]], [1, true, 0]);
  is("the first one is given nothing", await give(slip, "cs_test_licmark000008"), null);

  part("6. Cost: keyForSale stays inside ORDERS_KEY_COMMANDS on its dearest path, lost to the mark after five tries");
  let commands = 0;
  let refused = 0;
  let marked = false;
  const costly = "cs_test_licmark000010";
  redis.pipeline = (async (sent: Command[]) => {
    commands += sent.length;
    if (!marked && sent.some(writesSale(costly))) {
      marked = true;
      await real([["HSETNX", `nl:keys:${store.statsId}:${app.id}:sale`, costly, String(await saleKeyOf(app, early.reference))]]);
    }
    // Four made keys already taken: the fifth try is the one settled.
    if (sent.length === 1 && sent[0][0] === "SADD" && String(sent[0][1]).endsWith(":all") && refused < 4) {
      refused += 1;
      return [0];
    }
    return real(sent);
  }) as typeof redis.pipeline;
  const lost = await give(app, costly);
  redis.pipeline = real;
  is(`no key given, in ${commands} commands, within ${ORDERS_KEY_COMMANDS}`, [lost, commands <= ORDERS_KEY_COMMANDS], [null, true]);

  part("7. The mark is the store's data: in the keys' family, counted in its room, and erased with the store when it closes");
  const saleHash = `nl:keys:${store.statsId}:${app.id}:sale`;
  const otherHash = `nl:keys:${"b".repeat(32)}:${app.id}:sale`;
  await real([["HSET", otherHash, "cs_test_someone_else", "OTHER-AAAA"]]);
  is("its family is the license keys', counted in the room and erased on closing", [closingFamilyOf(saleHash), countedInRoom(saleHash), CLOSING[closingFamilyOf(saleHash)]?.how], ["nl:keys:", true, "erase"]);
  const closing = await prepareStore(store);
  const owners = { byMark: new Map(closing.marks.map((mark) => [mark, closing.ref])), byHandle: new Map(closing.handles.map((handle) => [handle, closing.ref])), byRef: new Map([[closing.ref, closing.ref]]) };
  await walkPage([saleHash, otherHash], new Map([[closing.ref, closing]]), owners);
  is("the closing walk deletes this store's sales and their marks, and leaves another store's", [(await real([["EXISTS", saleHash]]))[0], (await real([["EXISTS", otherHash]]))[0]], [0, 1]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
