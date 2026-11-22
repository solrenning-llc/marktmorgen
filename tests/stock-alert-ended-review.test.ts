/**
 * Claude 2 main's review of #5124 (7082555356), each finding held:
 *
 *   M1: a back-in-stock ask's worst commands, every call inside every script counted, fit inside the public requests
 *       it takes (STOCK_ALERT_ASK_UNITS more than the route's own), each priced at a later page's commands.
 *   M2: a store whose data room is full of ended places frees itself: the ended places go, and their room comes back,
 *       before the new place's room is taken.
 *   L1: a confirmed place that has ended is gone: asking again makes a new unconfirmed place, never a confirmed one.
 *   L2: a place written before ends were kept (no `x`) is read, never makes its list unknown; it ends by the old rule.
 *
 * Synthetic data; no provider is called.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import * as alerts from "@/lib/stock-alerts";
import { askStockAlert, confirmStockAlert, confirmedForRestock, stockAlertAddresses } from "@/lib/stock-alerts";

/** How many public requests an ask takes besides the route's own (0 where the code takes none). */
const STOCK_ALERT_ASK_UNITS = Number((alerts as Record<string, unknown>).STOCK_ALERT_ASK_UNITS ?? 0);
import { MAX_STOCK_ALERTS } from "@/lib/stock-alert-rules";
import { CONFIRM_SECONDS, WAIT_SECONDS } from "@/lib/waitlist-rules";
import { dataUsed } from "@/lib/store-data";
import { COMMANDS } from "./traffic-cost";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400_000;

/** The value, or "unknown" when it throws: a list that cannot be read is a failed check, not a stopped run. */
async function safely<T>(run: () => Promise<T>): Promise<T | "unknown"> {
  try {
    return await run();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("owner@example.com", "lantern", "Lantern Goods", "");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  const made = await addProduct("owner@example.com", "Signed Print", "", "40", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail("owner@example.com"))!;
  const sid = store.statsId!;
  const pid = made.product.id;
  const key = `nl:sa:${sid}:${pid}`;
  const pay = async () => true;
  const ask = (email: string, now?: number) => askStockAlert({ store, productId: pid, email, left: 0, now, pay });
  const realNow = Date.now;
  const at = async <T>(ms: number, run: () => Promise<T>): Promise<T> => {
    Date.now = () => ms;
    try {
      return await run();
    } finally {
      Date.now = realNow;
    }
  };

  part("L2: a place written before ends were kept is read, and ends by the old rule");
  {
    const now = Math.floor(realNow() / 1000);
    redis.run(["HSET", key, "old@example.com", JSON.stringify({ at: now - 10, ok: now - 5, t: "c".repeat(48) })]);
    is("its list still reads", await safely(async () => (await stockAlertAddresses(store, pid)).map((a) => [a.email, a.confirmed])), [["old@example.com", true]]);
    is("and it is still on the restock list, its year not over", await safely(() => confirmedForRestock(store, pid)), ["old@example.com"]);
    redis.run(["HSET", key, "older@example.com", JSON.stringify({ at: now - 400 * 86_400, ok: now - 390 * 86_400, t: "d".repeat(48) })]);
    is("one confirmed more than a year ago has ended", await safely(async () => (await stockAlertAddresses(store, pid)).find((a) => a.email === "older@example.com")?.confirmed), false);
    redis.run(["DEL", key, `${key}:x`]);
  }

  part("L1: a confirmed place that has ended is not revived by asking again");
  {
    const now = Math.floor(realNow() / 1000);
    // kai@ confirmed a year and two days ago: its place ended two days ago, and its line in the index says so.
    const ended = now - 2 * 86_400;
    redis.run(["HSET", key, "kai@example.com", JSON.stringify({ at: ended - WAIT_SECONDS, ok: ended - WAIT_SECONDS, t: "f".repeat(48), x: ended })]);
    redis.run(["ZADD", `${key}:x`, ended, "kai@example.com"]);
    redis.run(["EXPIRE", key, WAIT_SECONDS]);
    is("it is not confirmed any more", await safely(async () => (await stockAlertAddresses(store, pid)).find((a) => a.email === "kai@example.com")?.confirmed), false);
    const again = await ask("kai@example.com");
    is("asked again: a new place, with a new link to leave", [again.ok, again.ok && again.leave !== "f".repeat(48)], [true, true]);
    is("and it waits for a new confirmation", await safely(async () => (await stockAlertAddresses(store, pid)).find((a) => a.email === "kai@example.com")?.confirmed), false);
    redis.run(["DEL", key, `${key}:x`]);
  }

  part("M2: a data room full of ended places frees itself before the new place's room is taken");
  {
    const start = realNow() - (CONFIRM_SECONDS * 1000 + DAY);
    let asked = 0;
    for (let i = 0; i < MAX_STOCK_ALERTS; i += 1) {
      const r = await at(start, () => ask(`p${i}@example.com`, start));
      if (!r.ok) break;
      asked += 1;
    }
    is("the room filled before the list did", asked < MAX_STOCK_ALERTS && asked > 0, true);
    const usedFull = (await dataUsed(store))?.used ?? Number.NaN;
    const fresh = await ask("fresh@example.com");
    is("a new address is taken once ended places make room", fresh.ok, true);
    is("ended places went, and their room came back", ((await dataUsed(store))?.used ?? Number.NaN) < usedFull, true);
    redis.run(["DEL", key, `${key}:x`]);
  }

  part("M1: an ask's worst commands fit in the public requests it takes");
  {
    // A store of its own: the one above has its room full on purpose.
    await claimHandle("other@example.com", "harbor", "Harbor Goods", "");
    await ensureStatsId("other@example.com");
    await ensureListId("other@example.com");
    const made2 = await addProduct("other@example.com", "Print Two", "", "40", null);
    if (!made2.ok) throw new Error("no product");
    const store2 = (await storeForEmail("other@example.com"))!;
    const pid2 = made2.product.id;
    const key = `nl:sa:${store2.statsId}:${pid2}`;
    const ask = (email: string, now?: number) => askStockAlert({ store: store2, productId: pid2, email, left: 0, now, pay });
    // The worst ask: a list at its ceiling, with ended places to drop first.
    const start = realNow() - (CONFIRM_SECONDS * 1000 + DAY);
    // Its own place has ended too, so it drops that one besides the others it may.
    for (const who of ["late@example.com", ...Array.from({ length: 12 }, (_, i) => `gone${i}@example.com`)]) await at(start, () => ask(who, start));
    const fill: string[] = [];
    const live = JSON.stringify({ at: 1, ok: 1, t: "e".repeat(48), x: Math.floor(realNow() / 1000) + 30 * 86_400 });
    for (let i = (redis.run(["HLEN", key]) as number); i < MAX_STOCK_ALERTS; i += 1) fill.push(`held${i}@example.com`, live);
    if (fill.length) redis.run(["HSET", key, ...fill]);
    let commands = 0;
    const run = redis.run.bind(redis);
    redis.run = ((c: (string | number)[]) => {
      commands += 1;
      return run(c);
    }) as typeof redis.run;
    let worst: Awaited<ReturnType<typeof ask>>;
    try {
      worst = await ask("late@example.com");
    } finally {
      redis.run = run;
    }
    is("the worst ask is taken (an ended place made room)", worst.ok, true);
    const paid = (1 + STOCK_ALERT_ASK_UNITS) * (COMMANDS.laterPage + COMMANDS.laterCount);
    is(`its ${commands} commands fit in the ${1 + STOCK_ALERT_ASK_UNITS} public requests it is paid by (${paid})`, commands <= paid, true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
