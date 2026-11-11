/**
 * 623 [SZ7], unit 2: a product's back-in-stock list, kept. An address asks
 * on a sold-out limited product, counts once it confirmed through its own
 * inbox, can leave at any time, is read for the restock email and deleted
 * after it; every key ends by itself, and its room is taken from the
 * store's data room before it is written. Deleting a person takes them off
 * every list, and the copy of their data shows where they were. No route,
 * page or email yet: those are the next unit.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import {
  ALERT_TOKEN,
  askStockAlert,
  clearStockAlerts,
  confirmStockAlert,
  confirmedForRestock,
  forgetStockAlertPerson,
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
  is("the list ends by itself", redis.run(["TTL", listKey]) as number > WAIT_SECONDS - 5, true);
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

  done();
}

main();
