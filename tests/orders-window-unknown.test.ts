/**
 * A paying store whose billing window is unknown (its period not readable)
 * must not count a paid order in the calendar month: the admission
 * (lib/order-admission.ts) reads the store's billing window and would never
 * see it, so the window the order was admitted in, read again once known,
 * would be one order short and admit one past the plan's figure. The order
 * is held and counted in the window once it is known (rule 30; Claude 3's
 * note on #3105). A store with no plan keeps the calendar month.
 */
import { admitOrders } from "@/lib/order-admission";
import { paidOrdersLimitFor } from "@/lib/order-rules";
import { countOrder, ordersIn, storeOrdersThisMonth } from "@/lib/orders";
import { allowanceWindow, calendarWindow } from "@/lib/allowance-window";
import { claimHandle, ensureStatsId, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  const realError = console.error;
  console.error = () => {};
  const now = Date.now();
  const calendar = calendarWindow(now).id;

  const OWNER = "orders-window@example.com";
  await claimHandle(OWNER, "orderswindow", "Orders Window", "");
  await ensureStatsId(OWNER);
  const period = paidPeriod(now);
  await setSubscription(OWNER, { customerId: "cus_OrdWin0001", subscriptionId: "sub_OrdWin0001", active: true, tier: "creator", period });
  const folder = await storeFolder(OWNER);
  const paying = (await storeForEmail(OWNER))!;
  const billing = allowanceWindow(paying, now)?.id ?? null;
  const limit = paidOrdersLimitFor(paying, now / 1000)!;

  part("Control: a paying store with a known billing window counts there");
  is("set up: billing window apart from the calendar month", typeof billing === "string" && billing !== calendar, true);
  is("an order is counted", await countOrder(paying, "checkout:cs_ordwin_1", 0, now), true);
  is("in the billing window", await ordersIn(folder, billing as string), 1);
  is("not in the calendar month", await ordersIn(folder, calendar), 0);
  is("the store's orders this month read the billing window", await storeOrdersThisMonth(paying, now), 1);

  part("Unknown billing window: the order is held, never counted in the calendar month");
  await setSubscription(OWNER, { active: true, period: null });
  const unknown = (await storeForEmail(OWNER))!;
  is("set up: a paid store with no period has no window", allowanceWindow(unknown, now), null);
  await countOrder(unknown, "checkout:cs_ordwin_2", 0, now);
  is("nothing counted in the calendar month", await ordersIn(folder, calendar), 0);
  is("the billing window is not touched while unknown", await ordersIn(folder, billing as string), 1);
  is("the same order again is not held twice", await countOrder(unknown, "checkout:cs_ordwin_2", 0, now), false);
  is("its orders this month are unknown, not the calendar month's", await storeOrdersThisMonth(unknown, now), null);
  is("the admission refuses while the window is unknown", await admitOrders(unknown, 1, now), { ok: false, reason: "unavailable" });

  part("Known again: the held order is in the window before anything is admitted");
  await setSubscription(OWNER, { active: true, period });
  const known = (await storeForEmail(OWNER))!;
  is("set up: the same billing window again", allowanceWindow(known, now)?.id, billing);
  // The window stands one short of the figure with the held order: one more is the last one.
  await redis.pipeline([["SET", `nl:orders:n:${folder}:${billing}`, limit - 2]]);
  is("the last place is admitted", (await admitOrders(known, 1, now)).ok, true);
  is("the held order was counted in the billing window by the admission", await ordersIn(folder, billing as string), limit - 1);
  is("no place past the figure (the held order counts)", await admitOrders(known, 1, now), { ok: false, reason: "paused" });
  is("nothing ever went to the calendar month", await ordersIn(folder, calendar), 0);

  part("A held order is also counted by the next counted order");
  await setSubscription(OWNER, { active: true, period: null });
  await countOrder((await storeForEmail(OWNER))!, "checkout:cs_ordwin_3", 0, now);
  await setSubscription(OWNER, { active: true, period });
  await redis.pipeline([["SET", `nl:orders:n:${folder}:${billing}`, 5]]);
  is("the next order counts itself and the held one", await countOrder((await storeForEmail(OWNER))!, "checkout:cs_ordwin_4", 0, now), true);
  is("the billing window has both", await ordersIn(folder, billing as string), 7);
  await countOrder((await storeForEmail(OWNER))!, "checkout:cs_ordwin_5", 0, now);
  is("held once: a later order adds only itself", await ordersIn(folder, billing as string), 8);

  part("Control: a store with no plan keeps the calendar month");
  const FREE = "orders-window-free@example.com";
  await claimHandle(FREE, "orderswindowfree", "Orders Window Free", "");
  await ensureStatsId(FREE);
  const free = (await storeForEmail(FREE))!;
  const freeFolder = await storeFolder(FREE);
  is("set up: its window is the calendar month", allowanceWindow(free, now)?.id, calendar);
  is("its order is counted", await countOrder(free, "free:ordwin-free-1", 0, now), true);
  is("in the calendar month", await ordersIn(freeFolder, calendar), 1);
  is("its orders this month read the calendar month", await storeOrdersThisMonth(free, now), 1);

  console.error = realError;
  done();
}

void main();
