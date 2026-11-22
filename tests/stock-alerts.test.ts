/**
 * 623 [SZ7], unit 2: a product's back-in-stock list, kept. An address asks
 * on a sold-out limited product, counts once it confirmed through its own
 * inbox, can leave at any time, is read for the restock email and deleted
 * after it; every key ends by itself, and its room is taken from the
 * store's data room before it is written. Deleting a person takes them off
 * every list, and the copy of their data shows where they were. No route,
 * page or email yet: those are the next unit.
 */
import { createHash } from "node:crypto";
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import {
  ALERT_TOKEN,
  askStockAlert,
  clearStockAlerts,
  confirmStockAlert,
  confirmedForRestock,
  forgetStockAlertPerson,
  stillWaiting,
  stockAlertAddresses,
  leaveStockAlert,
  stockAlertsOf,
} from "@/lib/stock-alerts";
import { MAX_STOCK_ALERTS } from "@/lib/stock-alert-rules";
import { CONFIRM_SECONDS, WAIT_SECONDS } from "@/lib/waitlist-rules";
import { ERASERS } from "@/lib/person-erasure";
import { COPY_PLAN } from "@/lib/person-copy";
import { PERSON_DATA } from "@/lib/person-data";
import { UnknownReplyError } from "@/lib/redis-reply";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** Answers `reply` to one command on one key, as a database that answered something else would. */
function answer(command: string, key: string, reply: unknown): () => void {
  const run = redis.run.bind(redis);
  redis.run = (c: (string | number)[]) => (String(c[0]).toUpperCase() === command && c[1] === key ? reply : run(c));
  return () => {
    redis.run = run;
  };
}

async function rejects(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "resolved";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : String(error);
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("owner@example.com", "lantern", "Lantern Goods", "");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  const made = await addProduct("owner@example.com", "Signed Print", "", "40", null);
  const other = await addProduct("owner@example.com", "Second Print", "", "40", null);
  if (!made.ok || !other.ok) throw new Error("no product");
  const store = (await storeForEmail("owner@example.com"))!;
  const sid = store.statsId!;
  const pid = made.product.id;
  const pid2 = other.product.id;
  const ask = (email: string, left: unknown = 0, productId = pid) => askStockAlert({ store, productId, email, left });

  part("Only a sold-out limited product takes an address");
  is("units left: buy it instead", await ask("dana@example.com", 3), { ok: false, reason: "closed" });
  is("not limited", await ask("dana@example.com", null), { ok: false, reason: "closed" });
  is("units left that cannot be read", await ask("dana@example.com", Number.NaN), { ok: false, reason: "unknown" });
  is("not an address", await ask("dana at example"), { ok: false, reason: "email" });

  part("An address asks, and counts only once it confirmed");
  const dana = await ask("  Dana@Example.com ");
  is("asked", dana.ok, true);
  if (!dana.ok) throw new Error("not asked");
  is("two different links, each 48 hex characters", [ALERT_TOKEN.test(dana.confirm), ALERT_TOKEN.test(dana.leave), dana.confirm !== dana.leave, dana.again], [true, true, true, false]);
  is("nobody to email before the confirmation", await confirmedForRestock(store, pid), []);
  const listKey = `nl:sa:${sid}:${pid}`;
  // Each place ends on its own (Codex X6 on #3616): an unconfirmed one with its confirm link, so the list too.
  const firstTtl = redis.run(["TTL", listKey]) as number;
  is("the list ends by itself, with its only place's confirm link", firstTtl > CONFIRM_SECONDS - 5 && firstTtl <= CONFIRM_SECONDS, true);
  const tokenKeys = redis.keys().filter((k) => k.startsWith("nl:sa:t:"));
  is("both links are kept, each ending by itself", [tokenKeys.length, ...tokenKeys.map((k) => (redis.run(["TTL", k]) as number) > 0)], [2, true, true]);
  const ttls = tokenKeys.map((k) => redis.run(["TTL", k]) as number).sort((a, b) => a - b);
  is("the confirm link for a week, the leave link as long as the list", [ttls[0] <= CONFIRM_SECONDS, ttls[1] > CONFIRM_SECONDS && ttls[1] <= WAIT_SECONDS], [true, true]);
  is("the leave link cannot confirm", await confirmStockAlert(dana.leave, store), { ok: false });
  is("a made-up link confirms nothing", await confirmStockAlert("0".repeat(48), store), { ok: false });
  const elsewhere = { ...store, statsId: "f".repeat(32) };
  is("another store's page confirms nothing", await confirmStockAlert(dana.confirm, elsewhere), { ok: false });
  is("confirmed", await confirmStockAlert(dana.confirm, store), { ok: true, productId: pid });
  is("now on the restock list, normalised", await confirmedForRestock(store, pid), ["dana@example.com"]);
  is("a confirmed place lasts a year, and the list with it", (redis.run(["TTL", listKey]) as number) > WAIT_SECONDS - 5, true);
  is("pressing again changes nothing", await confirmStockAlert(dana.confirm, store), { ok: true, productId: pid });

  part("Asking again keeps one place");
  const again = await ask("dana@example.com");
  is("asked again: the same place, a new confirm link, the same leave link", [again.ok, again.ok && again.again, again.ok && again.leave === dana.leave], [true, true, true]);
  is("still one address, still confirmed", [redis.run(["HLEN", listKey]), await confirmedForRestock(store, pid)], [1, ["dana@example.com"]]);

  part("Leaving");
  const roomBefore = (await dataUsed(store))?.used ?? Number.NaN;
  const lee = await ask("lee@example.com");
  const roomTaken = (await dataUsed(store))?.used ?? Number.NaN;
  is("a new place takes room in the store's data room before it is written", roomTaken > roomBefore, true);
  if (!lee.ok) throw new Error("not asked");
  await confirmStockAlert(lee.confirm, store);
  is("both confirmed", (await confirmedForRestock(store, pid)).sort(), ["dana@example.com", "lee@example.com"]);
  is("the confirm link cannot take anyone off", await leaveStockAlert(lee.confirm, store), false);
  is("the leave link does", await leaveStockAlert(lee.leave, store), true);
  is("and its place's room comes back (its spent confirm link's ends with its month)", ((await dataUsed(store))?.used ?? Number.NaN) < roomTaken, true);
  is("off the list, and the link is spent", [await confirmedForRestock(store, pid), await leaveStockAlert(lee.leave, store)], [["dana@example.com"], false]);

  part("After the restock email, the addresses it went to are deleted with their links");
  const kim = await ask("kim@example.com");
  if (!kim.ok) throw new Error("not asked");
  is("one cleared, one still waiting to confirm", await clearStockAlerts(store, pid, ["dana@example.com"]), 1);
  is("dana is gone, kim still waits", [redis.run(["HEXISTS", listKey, "dana@example.com"]), redis.run(["HEXISTS", listKey, "kim@example.com"])], [0, 1]);
  is("dana's leave link is gone too", await leaveStockAlert(dana.leave, store), false);

  part("The ceiling");
  redis.clear();
  await claimHandle("owner@example.com", "lantern", "Lantern Goods", "");
  await ensureStatsId("owner@example.com");
  const full = (await storeForEmail("owner@example.com"))!;
  const fullPid = (await addProduct("owner@example.com", "Signed Print", "", "40", null));
  if (!fullPid.ok) throw new Error("no product");
  const fullKey = `nl:sa:${full.statsId}:${fullPid.product.id}`;
  const fields: string[] = [];
  for (let i = 0; i < MAX_STOCK_ALERTS; i++) fields.push(`p${i}@example.com`, "{}");
  redis.run(["HSET", fullKey, ...fields]);
  is("a full list takes no new address", await askStockAlert({ store: full, productId: fullPid.product.id, email: "new@example.com", left: 0 }), { ok: false, reason: "full" });
  redis.run(["DEL", fullKey]);
  let undo = answer("HLEN", fullKey, "many");
  is("a list whose size cannot be read takes nobody", await askStockAlert({ store: full, productId: fullPid.product.id, email: "new@example.com", left: 0 }), { ok: false, reason: "unknown" });
  undo();
  undo = answer("HGETALL", fullKey, null);
  is("and is never read as empty for a restock", await rejects(() => confirmedForRestock(full, fullPid.product.id)), "unknown");
  undo();
  redis.run(["HSET", fullKey, "bad@example.com", "{not json"]);
  is("a place that cannot be read is unknown, never skipped", await rejects(() => confirmedForRestock(full, fullPid.product.id)), "unknown");

  part("A person's data: deleted with them, and shown in their copy");
  redis.clear();
  await claimHandle("owner@example.com", "lantern", "Lantern Goods", "");
  await ensureStatsId("owner@example.com");
  const s3 = (await storeForEmail("owner@example.com"))!;
  const a = await addProduct("owner@example.com", "Signed Print", "", "40", null);
  const b = await addProduct("owner@example.com", "Second Print", "", "40", null);
  if (!a.ok || !b.ok) throw new Error("no product");
  const first = await askStockAlert({ store: s3, productId: a.product.id, email: "ada@example.com", left: 0 });
  await askStockAlert({ store: s3, productId: b.product.id, email: "ada@example.com", left: 0 });
  await askStockAlert({ store: s3, productId: a.product.id, email: "bo@example.com", left: 0 });
  if (!first.ok) throw new Error("not asked");
  await confirmStockAlert(first.confirm, s3);
  const places = await stockAlertsOf(s3.statsId, [a.product.id, b.product.id], "ADA@example.com");
  is("the copy shows each place, never the secret in its links", [places.length, places.map((p) => p.product).sort(), places.every((p) => !("t" in p) && p.asked > 0), places.filter((p) => p.confirmed > 0).length], [2, [a.product.id, b.product.id].sort(), true, 1]);
  is("forgetting takes them off every list of the store", await forgetStockAlertPerson(s3.statsId, [a.product.id, b.product.id], "ada@example.com"), 2);
  is("and nobody else", [await stockAlertsOf(s3.statsId, [a.product.id, b.product.id], "ada@example.com"), redis.run(["HEXISTS", `nl:sa:${s3.statsId}:${a.product.id}`, "bo@example.com"])], [[], 1]);
  is("the erasure runs it, the copy reads it, the register says so", [
    ERASERS.some((e) => e.module === "lib/stock-alerts.ts"),
    COPY_PLAN["lib/stock-alerts.ts"]?.how,
    PERSON_DATA.filter((d) => d.file === "lib/stock-alerts.ts").map((d) => d.how),
  ], [true, "copied", ["erased"]]);

  part("A leave is done only when its delete is known (Claude 1 on #3616)");
  const aKey = `nl:sa:${s3.statsId}:${a.product.id}`;
  const cy = await askStockAlert({ store: s3, productId: a.product.id, email: "cy@example.com", left: 0 });
  if (!cy.ok) throw new Error("not asked");
  await confirmStockAlert(cy.confirm, s3);
  const cyRoom = (await dataUsed(s3))?.used ?? Number.NaN;
  for (const bent of ["garbled", null, -1, 2, 1.5, "1"]) {
    const back = answer("HDEL", aKey, bent);
    is(`the place's delete answered ${JSON.stringify(bent)}: unknown, never "you left"`, await rejects(() => leaveStockAlert(cy.leave, s3)), "unknown");
    back();
  }
  is("and the address is still on the restock list, its room still taken", [(await confirmedForRestock(s3, a.product.id)).includes("cy@example.com"), (await dataUsed(s3))?.used], [true, cyRoom]);
  const del = redis.run.bind(redis);
  redis.run = (c: (string | number)[]) => (String(c[0]).toUpperCase() === "DEL" && String(c[1]).startsWith("nl:sa:t:") ? "garbled" : del(c));
  is("the link's delete answered in another shape: unknown", await rejects(() => leaveStockAlert(cy.leave, s3)), "unknown");
  redis.run = del;
  is("the place went for sure: off the list, and the same link, pressed again, says done", [(await confirmedForRestock(s3, a.product.id)).includes("cy@example.com"), await leaveStockAlert(cy.leave, s3)], [false, true]);
  const cy2 = await askStockAlert({ store: s3, productId: a.product.id, email: "cy@example.com", left: 0 });
  is("control: asked again, its leave link works and says done", [cy2.ok, cy2.ok && (await leaveStockAlert(cy2.leave, s3)), (await confirmedForRestock(s3, a.product.id)).includes("cy@example.com")], [true, true, false]);
  void pid2;

  part("A leave link whose kept value does not read is unknown, never 'no link' (Codex G on #3616)");
  const dy = await askStockAlert({ store: s3, productId: a.product.id, email: "dy@example.com", left: 0 });
  if (!dy.ok) throw new Error("not asked");
  await confirmStockAlert(dy.confirm, s3);
  const dyLink = `nl:sa:t:${createHash("sha256").update(dy.leave).digest("hex")}`;
  for (const bent of ["{}", "{not json", 42]) {
    const back = answer("GET", dyLink, bent);
    is(`the link answered ${JSON.stringify(bent)}: unknown, never "no link"`, await rejects(() => leaveStockAlert(dy.leave, s3)), "unknown");
    back();
  }
  is("and the address is still on the restock list", (await confirmedForRestock(s3, a.product.id)).includes("dy@example.com"), true);
  is("control: the link read again leaves", [await leaveStockAlert(dy.leave, s3), (await confirmedForRestock(s3, a.product.id)).includes("dy@example.com")], [true, false]);
  part("Leaving between a confirmation's read and its write: the place stays gone (Codex G on #3616)");
  {
    const rae = await ask("rae@example.com");
    if (!rae.ok) throw new Error("not asked");
    const real = redis.pipeline.bind(redis);
    let left = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      // The confirmation's write arrives: the buyer's leave has just finished first.
      const writes = commands.some((c) => (c[0] === "HSET" && c[1] === listKey && c[2] === "rae@example.com") || (c[0] === "EVAL" && commands.length >= 1 && String(c[1]).includes("stock-alert-confirm")));
      if (writes && !left) {
        left = true;
        redis.run(["HDEL", listKey, "rae@example.com"]);
      }
      return real(commands);
    }) as typeof redis.pipeline;
    try {
      is("the confirmation does not bring the place back", await confirmStockAlert(rae.confirm, store), { ok: false });
    } finally {
      redis.pipeline = real;
    }
    is("the leave happened in between", left, true);
    is("the address is not on the list", redis.run(["HEXISTS", listKey, "rae@example.com"]), 0);
    is("and nobody new to email", (await confirmedForRestock(store, pid)).includes("rae@example.com"), false);
  }

  part("Two new addresses at once for the last place: the list never goes past its ceiling (Codex G on #3616)");
  {
    const lastKey = `nl:sa:${sid}:${pid2}`;
    redis.run(["DEL", lastKey]);
    for (let i = 0; i < MAX_STOCK_ALERTS - 1; i += 1) redis.run(["HSET", lastKey, `held${i}@example.com`, JSON.stringify({ at: 1, ok: 1, t: "a".repeat(48) })]);
    const real = redis.pipeline.bind(redis);
    // Both read the list's size before either writes: a barrier on the read.
    let waiting = 0;
    let release: () => void = () => {};
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((c) => c[0] === "HLEN" && c[1] === lastKey)) {
        const reply = await real(commands);
        waiting += 1;
        if (waiting === 2) release();
        await bothRead;
        return reply;
      }
      return real(commands);
    }) as typeof redis.pipeline;
    let results: Awaited<ReturnType<typeof askStockAlert>>[] = [];
    try {
      results = await Promise.all([ask("sam@example.com", 0, pid2), ask("tia@example.com", 0, pid2)]);
    } finally {
      redis.pipeline = real;
    }
    is("one gets the last place", results.filter((r) => r.ok).length, 1);
    is("the other is told the list is full", results.filter((r) => !r.ok).map((r) => !r.ok && r.reason), ["full"]);
    is("the list holds exactly its ceiling", redis.run(["HLEN", lastKey]), MAX_STOCK_ALERTS);
  }

  part("A place nobody confirmed stops counting after its confirm link ends, and an ask lengthens only its own place (Codex X6 on #3616)");
  {
    const deadKey = `nl:sa:${sid}:${pid2}`;
    redis.run(["DEL", deadKey]);
    const DAY = 86_400_000;
    // One address asked and confirmed 300 days ago: its place, and so the list, have 65 days left.
    const old = await askStockAlert({ store, productId: pid2, email: "old@example.com", left: 0 });
    if (!old.ok) throw new Error("not asked");
    is("the old place confirmed", await confirmStockAlert(old.confirm, store), { ok: true, productId: pid2 });
    const kept = JSON.parse(redis.run(["HGET", deadKey, "old@example.com"]) as string) as Record<string, number>;
    const oldEnds = Math.floor(Date.now() / 1000) + 65 * 86_400;
    redis.run(["HSET", deadKey, "old@example.com", JSON.stringify({ ...kept, at: kept.at - 300 * 86_400, ok: kept.ok - 300 * 86_400, ...("x" in kept ? { x: oldEnds } : {}) })]);
    if (redis.run(["TYPE", `${deadKey}:x`]) === "zset") redis.run(["ZADD", `${deadKey}:x`, oldEnds, "old@example.com"]);
    for (const k of [deadKey, `${deadKey}:x`]) if (redis.run(["EXISTS", k]) === 1) redis.run(["EXPIRE", k, 65 * 86_400]);
    // One address asked 8 days ago and never confirmed: its confirm link is spent, so its place no longer counts.
    const stale = await askStockAlert({ store, productId: pid2, email: "stale@example.com", left: 0, now: Date.now() - 8 * DAY });
    if (!stale.ok) throw new Error("not asked");
    const held = JSON.stringify({ at: 1, ok: 1, t: "a".repeat(48), x: Math.floor(Date.now() / 1000) + 30 * 86_400 });
    for (let i = 0; i < MAX_STOCK_ALERTS - 2; i += 1) redis.run(["HSET", deadKey, `held${i}@example.com`, held]);
    is("the list is at its ceiling with the stale place", redis.run(["HLEN", deadKey]), MAX_STOCK_ALERTS);
    const roomBefore = (await dataUsed(store))?.used ?? Number.NaN;
    const fresh = await askStockAlert({ store, productId: pid2, email: "fresh@example.com", left: 0 });
    is("a new address takes the place the stale one held", fresh.ok, true);
    is("the stale place is gone, the new one is there", [redis.run(["HEXISTS", deadKey, "stale@example.com"]), redis.run(["HEXISTS", deadKey, "fresh@example.com"]), redis.run(["HLEN", deadKey])], [0, 1, MAX_STOCK_ALERTS]);
    is("the stale place's leave link went with it", await leaveStockAlert(stale.leave, store), false);
    const roomAfter = (await dataUsed(store))?.used ?? Number.NaN;
    is("its room came back: the store holds no more than before, besides the new place's confirm link", roomAfter - roomBefore < 400, true);
    const left = redis.run(["TTL", deadKey]) as number;
    is("the new ask did not lengthen the list past the old place's own end (65 days), let alone a year", left <= 65 * 86_400 + 5 && left > 64 * 86_400, true);
    is("the old place is still on the restock list", (await confirmedForRestock(store, pid2)).includes("old@example.com"), true);
  }

  part("A confirmed place that has ended is not waiting any more, for the restock job's readers too");
  {
    const endKey = `nl:sa:${sid}:${pid}`;
    redis.run(["DEL", endKey, `${endKey}:x`]);
    const gone = await askStockAlert({ store, productId: pid, email: "gone@example.com", left: 0 });
    const live = await askStockAlert({ store, productId: pid, email: "live@example.com", left: 0 });
    if (!gone.ok || !live.ok) throw new Error("not asked");
    await confirmStockAlert(gone.confirm, store);
    await confirmStockAlert(live.confirm, store);
    // gone@ confirmed a year and a day ago: its place has ended.
    const kept = JSON.parse(redis.run(["HGET", endKey, "gone@example.com"]) as string) as Record<string, number>;
    redis.run(["HSET", endKey, "gone@example.com", JSON.stringify({ ...kept, x: Math.floor(Date.now() / 1000) - 86_400 })]);
    is("the restock job's list says only the live place is confirmed", (await stockAlertAddresses(store, pid)).map((a) => [a.email, a.confirmed]).sort(), [["gone@example.com", false], ["live@example.com", true]]);
    is("and just before an email, only the live place is still waiting", (await stillWaiting(store, pid, ["gone@example.com", "live@example.com"])).map((t) => t !== null), [false, true]);
  }

  done();
}

main();
