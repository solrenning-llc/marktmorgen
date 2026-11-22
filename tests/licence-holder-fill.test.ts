/**
 * Keys given before the buyers' own lists existed (#5136, Claude 4 3rC's MEDIUM; the coordinator's pattern for #5135,
 * bb02). Stores sold on a trial until 5 October 2026 and keys exist since 26 September, so a key may sit in a product's
 * records with no line in its buyer's list. Until its store's fill is done, the person's copy reads the product's whole
 * records, as main did (complete, never worse); the five-minute sweep fills the missing lines a bounded step at a time
 * and marks the store done only when every product's records were walked to the end; after that the copy reads the
 * person's list only. Synthetic store, Redis stub, no provider.
 */
import { addProduct, claimHandle, ensureStatsId, removeProduct, setProductKeys, setProductLink, setSubscription, storeForEmail, type Listing } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { FILL_MAX_TRIES, FILL_RUN_COMMANDS, HOLDER_FILL_WHOLE, endHolderFillRound, fillHolderLines, holderFillDone, holderFillLeft, holderFillOn, keyForSale, keyHolderDigest, keysOf, keysWithoutHolderLine, startHolderFillRound } from "@/lib/licence-keys";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "fill-owner@example.com";
const DANA = "dana@example.com";

/** The commands sent, counted as the cost registry counts them: a pipelined command is 1, a script 1 plus its commands. */
function counted(commands: (string | number)[][]): number {
  return commands.reduce((n, c) => n + (c[0] === "EVAL" ? 1 + Number(c[3 + Number(c[2])]) : 1), 0);
}

/** Runs `run` and answers what it answered and the commands it sent (`counted`). */
async function metered<T>(run: () => Promise<T>): Promise<{ value: T; commands: number }> {
  let commands = 0;
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (sent: (string | number)[][]) => {
    commands += counted(sent);
    return real(sent);
  }) as typeof redis.pipeline;
  try {
    return { value: await run(), commands };
  } finally {
    redis.pipeline = real;
  }
}

/** A store with keys made the way they were before the lists: `perProduct[i]` records on product i, no line, no key in settle. */
async function oldKeysStore(owner: string, handle: string, perProduct: number[]) {
  await claimHandle(owner, handle, "Fill Keys", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}01`, subscriptionId: `sub_${handle}01`, active: true, period: paidPeriod() });
  const ids: string[] = [];
  for (let p = 0; p < perProduct.length; p += 1) {
    const made = await addProduct(owner, `Fill ${p}`, "", "29", null);
    if (!made.ok) throw new Error("no product");
    await setProductLink(owner, made.product.id, `https://example.com/${handle}-${p}`);
    await setProductKeys(owner, made.product.id, { source: "generated", prefix: "FIX", groups: 4, groupLength: 4, lowAt: 0 });
    ids.push(made.product.id);
  }
  const store = (await storeForEmail(owner))!;
  perProduct.forEach((n, p) => {
    for (let i = 0; i < n; i += 1) {
      redis.run(["HSET", `nl:keys:${store.statsId}:${ids[p]}:info`, `OLDK-${p}-${String(i).padStart(4, "0")}-ZZZZ`, JSON.stringify({ r: `cs_test_${`${p}x${i}`.padStart(24, "y")}`, e: `${handle}${p}b${i}@example.com`, at: 1_790_000_000 })]);
    }
  });
  return { store, ids };
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await claimHandle(OWNER, "fillkeys", "Fill Keys", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_FillKeys01", subscriptionId: "sub_FillKeys01", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Fill App", "", "29", null);
  const other = await addProduct(OWNER, "Fill Book", "", "9", null);
  if (!made.ok || !other.ok) throw new Error("no products");
  await setProductLink(OWNER, made.product.id, "https://example.com/fill-app");
  await setProductKeys(OWNER, made.product.id, { source: "generated", prefix: "FIL", groups: 4, groupLength: 4, lowAt: 0 });
  await setProductLink(OWNER, other.product.id, "https://example.com/fill-book");
  await setProductKeys(OWNER, other.product.id, { source: "generated", prefix: "FIB", groups: 4, groupLength: 4, lowAt: 0 });
  const store = (await storeForEmail(OWNER))!;
  const app = (await readListing(store, made.product.id))!;
  const ids = [made.product.id, other.product.id];
  const infoOf = (id: string) => `nl:keys:${store.statsId}:${id}:info`;

  // 250 keys written the way they were before the lists (a record, no line), 125 a product: one of them Dana's.
  const OLD = "OLDK-DANA-0000-0001";
  redis.run(["HSET", infoOf(ids[0]), OLD, JSON.stringify({ r: `cs_test_${"o".repeat(24)}`, e: DANA, at: 1_790_000_000 })]);
  for (let i = 0; i < 249; i += 1) {
    redis.run(["HSET", infoOf(ids[i < 124 ? 0 : 1]), `OLDK-${String(i).padStart(4, "0")}-ZZZZ-ZZZZ`, JSON.stringify({ r: `cs_test_${String(i).padStart(24, "x")}`, e: `buyer${i}@example.com`, at: 1_790_000_000 })]);
  }
  // And one given now, through settle: it has its line.
  const fresh = await keyForSale(store, app as Listing, `cs_test_${"n".repeat(24)}`, DANA);
  if (fresh?.state !== "issued") throw new Error("no fresh key");

  part("Before the fill: the copy reads as main did, and misses nothing");
  is("the store's fill is not done", await holderFillDone(store), false);
  const before = (await keysOf(store, ids, DANA)).map((k) => k.key).sort();
  is("Dana's old key and her new one are both in her copy", before, [OLD, fresh.key].sort());
  is("250 keys have no line yet", (await keysWithoutHolderLine(store, ids)).length, 250);

  part("A fill cut short marks nothing done, and goes on from where it stopped");
  // The Redis stub answers an HSCAN with a product's whole records, so a step is one product's: about 125 buyers, their
  // HMGETs and lines, 257 commands. A budget of 300 lets a run take one such step and not a second.
  const cut = await metered(() => fillHolderLines(store, Date.now() + 60_000, 300));
  const first = cut.value;
  is("the first small run is not done", first, false);
  is("and it sent no more commands than its budget", cut.commands <= 300, true);
  is("so the store is not marked done", await holderFillDone(store), false);
  is("one product's lines were written, the other's not yet", (await keysWithoutHolderLine(store, ids)).length, 125);
  is("the copy still reads every key", (await keysOf(store, ids, DANA)).map((k) => k.key).sort(), [OLD, fresh.key].sort());
  const next = await metered(() => fillHolderLines(store, Date.now() + 60_000, 300));
  is("the fill ends on the next run, from where the first stopped", next.value, true);
  is("that run too stays within its budget", next.commands <= 300, true);

  part("After the fill: every key has its line, and the copy reads the person's list only");
  is("the store is marked done", await holderFillDone(store), true);
  is("no key is left without its line", await keysWithoutHolderLine(store, ids), []);
  const reads: string[] = [];
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const c of commands) reads.push(c.map(String).join(" "));
    return real(commands);
  }) as typeof redis.pipeline;
  let after: string[];
  try {
    after = (await keysOf(store, ids, DANA)).map((k) => k.key).sort();
  } finally {
    redis.pipeline = real;
  }
  is("Dana's two keys, old and new, are in her copy", after, [OLD, fresh.key].sort());
  is("and no product's whole records are read", reads.some((r) => r.startsWith("HGETALL") && r.includes(":info")), false);
  is("a fill already done does nothing more", await fillHolderLines(store, Date.now() + 60_000, 300), true);

  part("The sweep's rounds: only a whole clean round stops the asking");
  is("before any round, the sweep still asks", await holderFillOn(), true);
  await startHolderFillRound();
  await holderFillLeft();
  await endHolderFillRound();
  is("a round where a store was left unfinished sets no mark", await holderFillOn(), true);
  await endHolderFillRound();
  is("a round that did not start at the top of the list sets no mark either", await holderFillOn(), true);
  await startHolderFillRound();
  await endHolderFillRound();
  is("a clean round from the top sets the company's mark: the sweep stops asking", await holderFillOn(), false);

  part("A fill state in a shape no writer writes is unknown, never done");
  redis.run(["HSET", `nl:keys:${store.statsId}:whofill`, "done", "yes"]);
  let threw = false;
  try {
    await holderFillDone(store);
  } catch {
    threw = true;
  }
  is("an unknown mark throws", threw, true);

  part("A run never sends more than FILL_RUN_COMMANDS, and the fill still ends");
  is("the cap is the constant the sweep runs with", FILL_RUN_COMMANDS, 400);
  const big = await oldKeysStore("fill-big@example.com", "fillbig", [150, 150, 150, 40]);
  const bigIds = big.ids;
  let bigRuns = 0;
  let most = 0;
  let ended = false;
  while (!ended && bigRuns < 20) {
    const run = await metered(() => fillHolderLines(big.store, Date.now() + 60_000));
    ended = run.value;
    most = Math.max(most, run.commands);
    bigRuns += 1;
  }
  is("every run of the sweep's budget stays at or under it", most <= FILL_RUN_COMMANDS, true);
  is("490 keys take more than one run", bigRuns > 1, true);
  is("and the fill ends, every key with its line", ended && (await keysWithoutHolderLine(big.store, bigIds)).length === 0, true);
  is("that store is done", await holderFillDone(big.store), true);

  part("A page that cannot fit in a whole run leaves the store on main's read for good");
  const huge = await oldKeysStore("fill-huge@example.com", "fillhuge", [300]);
  const one = await metered(() => fillHolderLines(huge.store, Date.now() + 60_000));
  is("the run answers that the store needs no more runs", one.value, true);
  is("and stays within the cap", one.commands <= FILL_RUN_COMMANDS, true);
  is("its mark says whole", redis.run(["HGET", `nl:keys:${huge.store.statsId}:whofill`, "done"]), HOLDER_FILL_WHOLE);
  is("which is not done: the copy keeps main's read", await holderFillDone(huge.store), false);
  const hugeKey = (await keysOf(huge.store, huge.ids, "fillhuge0b7@example.com")).map((k) => k.key);
  is("so a buyer's old key is still in their copy", hugeKey, ["OLDK-0-0007-ZZZZ"]);
  is("and the sweep does not ask that store again", await fillHolderLines(huge.store, Date.now() + 60_000), true);

  part("A product removed between two runs does not skip the next one (Claude 4 3Kc's MEDIUM on d2df5637dd)");
  // Claude 4 3Kc's scenario: old keys of sizes 3, 60 and 3 in id order, a run cut at the start of the big one, then the
  // first product removed. The kept index would then name the third product and the big one's keys would never get
  // their lines, yet the store would be marked done.
  const moved = await oldKeysStore("fill-moved@example.com", "fillmoved", [0, 0, 0]);
  const order = [...moved.ids].sort();
  [3, 60, 3].forEach((n, p) => {
    for (let i = 0; i < n; i += 1) {
      redis.run(["HSET", `nl:keys:${moved.store.statsId}:${order[p]}:info`, `MOVK-${p}-${String(i).padStart(4, "0")}-ZZZZ`, JSON.stringify({ r: `cs_test_${`m${p}x${i}`.padStart(24, "y")}`, e: `moved${p}b${i}@example.com`, at: 1_790_000_000 })]);
    }
  });
  is("a 25-command run stops at the start of the big product", await fillHolderLines(moved.store, Date.now() + 60_000, 25), false);
  await removeProduct("fill-moved@example.com", order[0]);
  const shrunk = (await storeForEmail("fill-moved@example.com"))!;
  const left = shrunk.catalog.items.map((item) => item.id);
  is("the first product is gone from the catalog", left.includes(order[0]), false);
  let movedRuns = 0;
  while (!(await fillHolderLines(shrunk, Date.now() + 60_000)) && movedRuns < 20) movedRuns += 1;
  is("the store ends done", await holderFillDone(shrunk), true);
  is("and no key of a product still listed is left without its line", (await keysWithoutHolderLine(shrunk, left)).length, 0);
  is("so a buyer of the big product has their old key in their copy", (await keysOf(shrunk, left, "moved1b42@example.com")).map((k) => k.key), ["MOVK-1-0042-ZZZZ"]);

  part("A reply no writer writes cannot hold the fill open for good (Claude 6 i51q's MEDIUM on cdafb13ff9)");
  // i51q's scenario: 60 old keys, and one buyer's list holding "2" for one of them. Every run met it and threw, the place
  // never moved, so the store was asked every run for good and the company's mark could never be set.
  const odd = await oldKeysStore("fill-odd@example.com", "fillodd", [60]);
  redis.run(["HSET", `nl:keys:${odd.store.statsId}:who:${keyHolderDigest("fillodd0b5@example.com")}`, `${odd.ids[0]}\tOLDK-0-0005-ZZZZ`, "2"]);
  const outcomes: string[] = [];
  let most2 = 0;
  for (let run = 0; run < FILL_MAX_TRIES + 2; run += 1) {
    const r = await metered(() => fillHolderLines(odd.store, Date.now() + 60_000).then((v) => String(v), () => "threw"));
    most2 = Math.max(most2, r.commands);
    outcomes.push(r.value);
  }
  is(`it throws ${FILL_MAX_TRIES - 1} times, then the store needs no more runs`, outcomes, [...Array(FILL_MAX_TRIES - 1).fill("threw"), "true", "true", "true"]);
  is("every one of those runs stays within the cap", most2 <= FILL_RUN_COMMANDS, true);
  is("the store is marked whole", redis.run(["HGET", `nl:keys:${odd.store.statsId}:whofill`, "done"]), HOLDER_FILL_WHOLE);
  is("which is not done: the copy keeps main's read", await holderFillDone(odd.store), false);
  is("so a buyer's old key is still in their copy", (await keysOf(odd.store, odd.ids, "fillodd0b7@example.com")).map((k) => k.key), ["OLDK-0-0007-ZZZZ"]);

  part("A catalog that changes on every run cannot hold the fill open for good either");
  const busy = await oldKeysStore("fill-busy@example.com", "fillbusy", [0, 0]);
  const busyOrder = [...busy.ids].sort();
  [3, 60].forEach((n, p) => {
    for (let i = 0; i < n; i += 1) redis.run(["HSET", `nl:keys:${busy.store.statsId}:${busyOrder[p]}:info`, `BUSY-${p}-${String(i).padStart(4, "0")}-ZZZZ`, JSON.stringify({ r: `cs_test_${`b${p}x${i}`.padStart(24, "y")}`, e: `busy${p}b${i}@example.com`, at: 1_790_000_000 })]);
  });
  let busyEnded = false;
  let busyRuns = 0;
  while (!busyEnded && busyRuns < 20) {
    // Each run stops at the start of the big product, then a product is added before the next one.
    busyEnded = await fillHolderLines((await storeForEmail("fill-busy@example.com"))!, Date.now() + 60_000, 25);
    await addProduct("fill-busy@example.com", `Busy extra ${busyRuns}`, "", "9", null);
    busyRuns += 1;
  }
  is(`the store ends after ${FILL_MAX_TRIES} restarts at the most`, busyEnded && busyRuns <= FILL_MAX_TRIES + 1, true);
  is("marked whole, so its copy keeps main's read", [redis.run(["HGET", `nl:keys:${busy.store.statsId}:whofill`, "done"]), await holderFillDone(busy.store)], [HOLDER_FILL_WHOLE, false]);
  done();
}

void main();
