/**
 * License keys read Redis and Stripe only in their exact shape (CX-123 rules 24 and 30; sweep A3 finding 2 and its
 * siblings, docs/reviews/c5-sweep-a3.md). Synthetic only: the in-memory Redis double and a stand-in for the
 * creator's Stripe account.
 *
 * A refund is marked read only once the key it takes back is revoked for sure. An answer of unknown shape (Redis
 * replying something that is not a key nor "none", Stripe answering a list without its `data` array) is not "this
 * sale has no key" nor "no checkout": the refund stays unread and the next run revokes the key. The same file's
 * low-pool warning, pool cap and data copy treat an unknown count or list as unknown, never as zero or empty.
 *
 * Review MEDIUM on #2868: a product the store still lists whose listing read comes back empty (a product outside the
 * catalog head, its GET answered in an unknown shape) is not "the product is gone": the refund stays unread and the
 * next run revokes the key.
 *
 * Review MEDIUM on #2868 (Codex G): a key's record read back as text that is not JSON, or as JSON of another shape,
 * is not "this product never gave the key": the refund stays unread, the healthy record is not overwritten, and the
 * next run revokes the key. The data copy says such a record is unknown rather than leave the key out.
 *
 * Review MEDIUM on #2868 (Claude 4, after Codex G): a record whose times are of a shape the writers never write (a
 * revocation time of -1, 0, 0.5 or Infinity, a given time below zero, a refund mark without a revocation time) is
 * unknown too, never "already revoked": the refund stays unread. The public check and the buyer's key never read such
 * a record as valid or revoked.
 */
import { type Store, claimHandle, ensureStatsId, addProduct, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { MAX_POOL_KEYS, addKeys, checkKey, keyForSale, keysOf, revokeRefunded, setRevoked } from "@/lib/licence-keys";
import { readListing } from "@/lib/catalog";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_licence_refund_exact";
const OWNER = "licencerefund@example.com";
const ACCOUNT = "acct_1TestLicRef01";
const NOW = Math.floor(Date.now() / 1000);

const sessionsByPayment: Record<string, Record<string, unknown>[]> = {};
let refunds: Record<string, unknown>[] = [];
/** How the checkouts list for a payment answers: healthy, 200 without its list, or with a list of another shape. */
let sessionsShape: "healthy" | "no-data" | "data-not-list" | "row-unreadable" = "healthy";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    if (sessionsShape === "no-data") return answer({ object: "list" });
    if (sessionsShape === "data-not-list") return answer({ object: "list", data: { 0: "x" }, has_more: false });
    if (sessionsShape === "row-unreadable") return list(["cs_not_an_object"]);
    return list(sessionsByPayment[url.searchParams.get("payment_intent") ?? ""] ?? []);
  }
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
const run = async (): Promise<number | "threw"> => {
  try {
    return await revokeRefunded(store, Date.now() + 10_000);
  } catch {
    return "threw";
  }
};
const seenOf = async (id: string) => (await real([["SISMEMBER", `nl:keys:${store.statsId}:refunds:seen`, id]]))[0];
const writesInfo = (command: Command) => ["EVAL", "EVALSHA", "HSET"].includes(String(command[0]).toUpperCase()) && command.some((arg) => String(arg).endsWith(":info"));

let store: Store;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "licencerefund", "Licence Refund", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_LicenceRef0001", subscriptionId: "sub_LicenceRef0001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Kiln App", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/app");
  await setProductKeys(OWNER, made.product.id, { source: "generated", prefix: "KILN", groups: 4, groupLength: 4, lowAt: 0 });
  store = (await storeForEmail(OWNER))!;
  const app = (await readListing(store, made.product.id))!;
  const sale = async (ref: string, pi: string) => {
    const given = await keyForSale(store, app, ref, "buyer@example.com");
    if (given?.state !== "issued") throw new Error("no key");
    sessionsByPayment[pi] = [{ id: ref, object: "checkout.session", metadata: { store: "licencerefund", product: made.product.id } }];
    return given.key;
  };

  part("Healthy control: a full refund revokes its key, once");
  const good = await sale("cs_test_licref000001", "pi_LicenceRef0001");
  refunds = [refund("re_LicenceRef0001", "pi_LicenceRef0001")];
  is("first run revokes it and marks the refund read", [await run(), await checkKey(store, app, good), await seenOf("re_LicenceRef0001")], [1, "revoked", 1]);
  is("a second run finds it read and revokes nothing more", [await run(), await checkKey(store, app, good)], [0, "revoked"]);

  part("Healthy control: a key whose sale was not refunded stays valid");
  const unrefunded = await sale("cs_test_licref000009", "pi_LicenceRef0009");
  is("valid after the job ran", [await run(), await checkKey(store, app, unrefunded)], [0, "valid"]);

  part("Healthy control: the refund is marked read only after the revocation is written");
  const failing = await sale("cs_test_licref000002", "pi_LicenceRef0002");
  refunds = [refund("re_LicenceRef0002", "pi_LicenceRef0002")];
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.some(writesInfo)) throw new Error("synthetic: the revocation could not be written");
    return real(commands);
  }) as typeof redis.pipeline;
  const failed = await run();
  redis.pipeline = real;
  is("nothing revoked and the refund left unread", [failed === "threw" ? 0 : failed, await seenOf("re_LicenceRef0002"), await checkKey(store, app, failing)], [0, 0, "valid"]);
  is("the next healthy run revokes it", [await run(), await checkKey(store, app, failing), await seenOf("re_LicenceRef0002")], [1, "revoked", 1]);

  part("1. The HGET of the sale's key answers in an unknown shape");
  const kept = await sale("cs_test_licref000003", "pi_LicenceRef0003");
  refunds = [refund("re_LicenceRef0003", "pi_LicenceRef0003")];
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.length === 1 && commands[0][0] === "HGET" && String(commands[0][1]).endsWith(":sale")) return [{ unexpected: true }];
    return real(commands);
  }) as typeof redis.pipeline;
  const first = await run();
  redis.pipeline = real;
  is("nothing revoked, and the refund is left unread", [first === "threw" ? 0 : first, await seenOf("re_LicenceRef0003")], [0, 0]);
  is("the next healthy run revokes the refunded key", [await run(), await checkKey(store, app, kept)], [1, "revoked"]);

  part("1b. The HGET of the key's record answers in an unknown shape (setRevoked)");
  const kept1b = await sale("cs_test_licref000004", "pi_LicenceRef0004");
  refunds = [refund("re_LicenceRef0004", "pi_LicenceRef0004")];
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.length === 1 && commands[0][0] === "HGET" && String(commands[0][1]).endsWith(":info")) return [42];
    return real(commands);
  }) as typeof redis.pipeline;
  const first1b = await run();
  redis.pipeline = real;
  is("nothing revoked, and the refund is left unread", [first1b === "threw" ? 0 : first1b, await seenOf("re_LicenceRef0004")], [0, 0]);
  is("the next healthy run revokes the refunded key", [await run(), await checkKey(store, app, kept1b)], [1, "revoked"]);

  for (const [label, shape, n] of [
    ["2. Stripe's checkouts list for the payment answers 200 without its list", "no-data", 5],
    ["2b. Stripe's checkouts list answers a data that is not a list", "data-not-list", 6],
    ["2c. Stripe's checkouts list answers a row that cannot be read", "row-unreadable", 7],
  ] as const) {
    part(label);
    const ref = `cs_test_licref00000${n}`;
    const pi = `pi_LicenceRef000${n}`;
    const id = `re_LicenceRef000${n}`;
    const key = await sale(ref, pi);
    refunds = [refund(id, pi)];
    sessionsShape = shape;
    const once = await run();
    sessionsShape = "healthy";
    is("nothing revoked, and the refund is left unread", [once === "threw" ? 0 : once, await seenOf(id)], [0, 0]);
    is("the next run (Stripe healthy again) revokes the refunded key", [await run(), await checkKey(store, app, key)], [1, "revoked"]);
  }

  part("2d. A listed product's listing read answers in an unknown shape (review of #2868)");
  const outside = await sale("cs_test_licref000010", "pi_LicenceRef0010");
  refunds = [refund("re_LicenceRef0010", "pi_LicenceRef0010")];
  // The product sits outside the catalog head (a store with more than a page of products, or a head over its bytes),
  // so its listing is read with a GET of its own; that GET answers with no reply at all.
  is("control: the store still lists the product", store.catalog.items.some((item) => item.id === app.id), true);
  const headless: Store = { ...store, catalog: { ...store.catalog, head: [] } };
  const listingGet = (commands: Command[]) => commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).endsWith(`:l:${app.id}`);
  redis.pipeline = (async (commands: Command[]) => (listingGet(commands) ? [] : real(commands))) as typeof redis.pipeline;
  let outsideRun: number | "threw";
  try {
    outsideRun = await revokeRefunded(headless, Date.now() + 10_000);
  } catch {
    outsideRun = "threw";
  }
  redis.pipeline = real;
  is("nothing revoked, and the refund is left unread", [outsideRun === "threw" ? 0 : outsideRun, await seenOf("re_LicenceRef0010"), await checkKey(store, app, outside)], [0, 0, "valid"]);
  is("the next healthy run revokes the refunded key", [await run(), await checkKey(store, app, outside), await seenOf("re_LicenceRef0010")], [1, "revoked", 1]);

  part("2e. Healthy control: a refunded product the store no longer lists is read, with nothing to revoke");
  refunds = [refund("re_LicenceRef0011", "pi_LicenceRef0011")];
  sessionsByPayment.pi_LicenceRef0011 = [{ id: "cs_test_licref000011", object: "checkout.session", metadata: { store: "licencerefund", product: "prodgone000001" } }];
  is("the refund is marked read and nothing is revoked", [await run(), await seenOf("re_LicenceRef0011")], [0, 1]);

  part("3. MEDIUM: an unknown pool count never emails \"No license keys left\" while keys are in stock");
  const pooled = await addProduct(OWNER, "Glaze Pack", "", "19", null);
  if (!pooled.ok) throw new Error("no pool product");
  await setProductLink(OWNER, pooled.product.id, "https://example.com/glaze");
  await setProductKeys(OWNER, pooled.product.id, { source: "pool", prefix: "", groups: 4, groupLength: 4, lowAt: 1 });
  store = (await storeForEmail(OWNER))!;
  const pack = (await readListing(store, pooled.product.id))!;
  const warned = `nl:keys:${store.statsId}:${pack.id}:warned`;
  const pool = `nl:keys:${store.statsId}:${pack.id}:pool`;
  const upload = await addKeys(store, pack, ["GLAZE-AAAA-BBBB-CCCC", "GLAZE-DDDD-EEEE-FFFF", "GLAZE-GGGG-HHHH-JJJJ", "GLAZE-KKKK-LLLL-MMMM"]);
  is("control: four keys in the pool", upload.added, 4);
  await keyForSale(store, pack, "cs_test_licrefpool01", "a@example.com");
  is("control: three left, above the warning, no warning", (await real([["EXISTS", warned]]))[0], 0);
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.length === 1 && commands[0][0] === "LLEN") return [{ unexpected: true }];
    return real(commands);
  }) as typeof redis.pipeline;
  const given = await keyForSale(store, pack, "cs_test_licrefpool02", "b@example.com");
  redis.pipeline = real;
  is("the sale still gets its key", given?.state, "issued");
  is("no low-pool warning claimed on an unknown count (two keys still in stock)", [(await real([["EXISTS", warned]]))[0], (await real([["LLEN", pool]]))[0]], [0, 2]);

  part("4. LOW: an unknown pool count never lets an upload pass the pool's cap");
  await real([["DEL", pool]]);
  const filler = Array.from({ length: MAX_POOL_KEYS }, (_, i) => `FILL-${String(i).padStart(6, "0")}-ZZZZ`);
  for (let i = 0; i < filler.length; i += 1000) await real([["RPUSH", pool, ...filler.slice(i, i + 1000)]]);
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.length === 1 && commands[0][0] === "LLEN") return [null];
    return real(commands);
  }) as typeof redis.pipeline;
  let capped: unknown;
  try {
    capped = (await addKeys(store, pack, ["GLAZE-NNNN-PPPP-QQQQ"])).added;
  } catch {
    capped = "threw";
  }
  redis.pipeline = real;
  is("refused, never above the cap", [capped === "threw" ? 0 : capped, (await real([["LLEN", pool]]))[0]], [0, MAX_POOL_KEYS]);

  part("5. LOW: the person's data copy never leaves their keys out on an unknown answer");
  is("control: the buyer's key is in their copy", (await keysOf(store, [app.id], "buyer@example.com")).some((k) => k.key === good), true);
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.some((c) => c[0] === "HGETALL")) return commands.map(() => "garbled");
    return real(commands);
  }) as typeof redis.pipeline;
  let copy: unknown;
  try {
    copy = await keysOf(store, [app.id], "buyer@example.com");
  } catch (error) {
    copy = error instanceof Error ? error.name : "threw";
  }
  redis.pipeline = real;
  is("an unknown answer is said as unknown, never as no keys", copy, "UnknownReplyError");

  part("6. MEDIUM (Codex G): a key's record read back unreadable keeps its refund unread and the record whole");
  const infoOf = `nl:keys:${store.statsId}:${app.id}:info`;
  // The healthy record with one field changed to a shape no writer writes (settle writes {r, e, at}, setRevoked adds a
  // positive whole v, and w only with it).
  const changed = (fields: Record<string, unknown>) => (before: string) => JSON.stringify({ ...JSON.parse(before), ...fields });
  for (const [label, bad, n] of [
    ["text that is not JSON", () => "{cut", "21"],
    ["JSON of another shape", () => "{}", "22"],
    ["a revocation time of -1", changed({ v: -1 }), "24"],
    ["a revocation time of 0.5", changed({ v: 0.5 }), "25"],
    ["a revocation time read as Infinity", (before: string) => before.replace(/}$/, ',"v":1e999}'), "26"],
    ["a revocation time of 0", changed({ v: 0 }), "27"],
    ["a given time below zero", changed({ at: -1 }), "28"],
    ["a refund mark without a revocation time", changed({ w: "refund" }), "29"],
  ] as const) {
    const key = await sale(`cs_test_licref0000${n}`, `pi_LicenceRef00${n}`);
    const id = `re_LicenceRef00${n}`;
    refunds = [refund(id, `pi_LicenceRef00${n}`)];
    const before = (await real([["HGET", infoOf, key]]))[0];
    let faults = 0;
    redis.pipeline = (async (commands: Command[]) => {
      if (commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === infoOf && commands[0][2] === key) {
        faults += 1;
        return [bad(String(before))];
      }
      return real(commands);
    }) as typeof redis.pipeline;
    const first = await run();
    redis.pipeline = real;
    is(`${label}: the record was read once, unreadable`, faults, 1);
    is(`${label}: nothing counted revoked and the refund stays unread`, [first, await seenOf(id)], [0, 0]);
    is(`${label}: the healthy record is not overwritten`, (await real([["HGET", infoOf, key]]))[0], before);
    is(`${label}: the next healthy run revokes the key and marks the refund read`, [await run(), await checkKey(store, app, key), await seenOf(id)], [1, "revoked", 1]);
  }

  part("6b. Same pattern: the creator's revoke never answers \"not your key\" on an unreadable record");
  const clicked = await sale("cs_test_licref000023", "pi_LicenceRef0023");
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === infoOf) return ["{cut"];
    return real(commands);
  }) as typeof redis.pipeline;
  let answered: unknown;
  try {
    answered = await setRevoked(store, app, clicked, true);
  } catch (error) {
    answered = error instanceof Error ? error.name : "threw";
  }
  redis.pipeline = real;
  is("an unreadable record is unknown, never false", answered, "UnknownReplyError");
  is("control: a key this product never gave is false", await setRevoked(store, app, "KILN-NONE-NONE-NONE", true), false);

  part("6c. Same pattern: the data copy never leaves a key out because its record is unreadable");
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.some((c) => c[0] === "HGETALL")) return commands.map(() => [good, "{cut"]);
    return real(commands);
  }) as typeof redis.pipeline;
  let unreadable: unknown;
  try {
    unreadable = await keysOf(store, [app.id], "buyer@example.com");
  } catch (error) {
    unreadable = error instanceof Error ? error.name : "threw";
  }
  redis.pipeline = real;
  is("an unreadable record is said as unknown, never left out", unreadable, "UnknownReplyError");

  part("6d. Same pattern: the public check never reads a record of another shape as valid or revoked");
  const checked = await sale("cs_test_licref000030", "pi_LicenceRef0030");
  const healthy = String((await real([["HGET", infoOf, checked]]))[0]);
  is("control: the healthy record is valid", await checkKey(store, app, checked), "valid");
  for (const [label, odd] of [
    ["JSON of another shape", "{}"],
    ["a revocation time of -1", changed({ v: -1 })(healthy)],
    ["a revocation time that is text", changed({ v: "soon" })(healthy)],
  ] as const) {
    redis.pipeline = (async (commands: Command[]) => {
      if (commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === infoOf && commands[0][2] === checked) return [odd];
      return real(commands);
    }) as typeof redis.pipeline;
    const status = await checkKey(store, app, checked);
    redis.pipeline = real;
    is(`${label}: the check answers unknown`, status, "unknown");
  }

  part("6e. Same pattern: the buyer's key is never shown good or revoked from a record of another shape");
  const shown = await sale("cs_test_licref000031", "pi_LicenceRef0031");
  is("control: the buyer's key is shown good", await keyForSale(store, app, "cs_test_licref000031", "buyer@example.com"), { state: "issued", key: shown, revoked: false });
  for (const [label, odd] of [
    ["JSON of another shape", "{}"],
    ["a revocation time of -1", changed({ v: -1 })(String((await real([["HGET", infoOf, shown]]))[0]))],
  ] as const) {
    redis.pipeline = (async (commands: Command[]) => {
      if (commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === infoOf && commands[0][2] === shown) return [odd];
      return real(commands);
    }) as typeof redis.pipeline;
    let given: unknown;
    try {
      given = await keyForSale(store, app, "cs_test_licref000031", "buyer@example.com");
    } catch (error) {
      given = error instanceof Error ? error.name : "threw";
    }
    redis.pipeline = real;
    is(`${label}: the buyer's key is unknown`, given, "UnknownReplyError");
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
