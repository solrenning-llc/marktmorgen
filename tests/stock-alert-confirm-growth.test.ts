/**
 * Claude 5 iYwjc's MEDIUM on #5124 (7111094547): a back-in-stock place is charged at its asked size (`ok: 0`), and
 * confirming it rewrites it with `ok` set to a time (and a new end of the same length), which can cross a data step,
 * but the growth was not counted; every give-back (leave, clear, an ended place) then returned the grown size, so each
 * ask, confirm and leave cycle left the store's data room counting less than it holds. The confirmation now counts
 * the growth before its write (as countEntryGrowth does on the waitlist), so one cycle leaves the room where it was.
 *
 * Synthetic data; no provider is called.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { askStockAlert, confirmStockAlert, leaveStockAlert } from "@/lib/stock-alerts";
import { dataKey } from "@/lib/store-data";
import { COMMANDS } from "./traffic-cost";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("owner@example.com", "lantern", "Lantern Goods", "");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  const made = await addProduct("owner@example.com", "Signed Print", "", "40", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail("owner@example.com"))!;
  const pid = made.product.id;
  const pay = async () => true;
  // The product's own slot in the store's data room (`sa:<product>`): what a place takes there, its growth counted and
  // its give-back. The confirm link's room is counted apart, in the month it expires, and is not compared here.
  const used = async () => Number(redis.run(["HGET", dataKey(store)!, `sa:${pid}`]) ?? 0);

  part("One ask, confirm and leave leaves the product's slot in the data room where it was");
  // A place kept beside it, so the store's room is not empty.
  const kept = await askStockAlert({ store, productId: pid, email: "kept@example.com", left: 0, pay });
  if (!kept.ok) throw new Error("not asked");
  for (const email of ["dana@example.com", "bo@example.com", "a.long.address.for.steps@example.com"]) {
    const before = await used();
    const asked = await askStockAlert({ store, productId: pid, email, left: 0, pay });
    if (!asked.ok) throw new Error("not asked");
    is(`${email}: confirmed`, await confirmStockAlert(asked.confirm, store), { ok: true, productId: pid });
    is(`${email}: left`, await leaveStockAlert(asked.leave, store), true);
    is(`${email}: the slot counts what it did before, never less than is stored`, await used(), before);
  }

  part("The confirmation, its growth counted, still fits in the one public request it is paid by");
  {
    const asked = await askStockAlert({ store, productId: pid, email: "dana@example.com", left: 0, pay });
    if (!asked.ok) throw new Error("not asked");
    let commands = 0;
    const run = redis.run.bind(redis);
    redis.run = ((c: (string | number)[]) => {
      commands += 1;
      return run(c);
    }) as typeof redis.run;
    try {
      is("confirmed", await confirmStockAlert(asked.confirm, store), { ok: true, productId: pid });
    } finally {
      redis.run = run;
    }
    const paid = COMMANDS.laterPage + COMMANDS.laterCount;
    is(`its ${commands} commands, every call inside every script counted, fit in one public request (${paid})`, commands <= paid, true);
  }

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
