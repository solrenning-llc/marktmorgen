/**
 * A paying store whose billing window is unknown (its period not readable)
 * must not count a paid order in the calendar month: the admission
 * (lib/order-admission.ts) reads the store's billing window and would never
 * see it, so the window the order was admitted in, read again once known,
 * would be one order short and admit one past the plan's figure. The order
 * is held and counted in the window once it is known (rule 30; Claude 3's
 * note on #3105). A store with no plan keeps the calendar month.
 */
import { type Admission, admitOrders } from "@/lib/order-admission";
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

  part("Moving the held orders is one step: no admission lands between its parts (Claude 4 on #3150)");
  await setSubscription(OWNER, { active: true, period });
  const again = (await storeForEmail(OWNER))!;
  const pendingKey = `nl:orders:pending:${folder}`, windowKey = `nl:orders:n:${folder}:${billing}`, openKey = `nl:orders:open:${folder}`;
  const plain = redis.pipeline;
  const read = async (key: string) => Number((await plain([["GET", key]]))[0] ?? 0);
  const held = async () => {
    const pairs = (await plain([["HGETALL", openKey]]))[0] as string[];
    let sum = 0;
    for (let i = 1; i < pairs.length; i += 2) sum += Number(pairs[i]);
    return sum;
  };
  // Two orders held while the window was unknown; the window two short of the figure: the held orders fill it.
  const reset = () => plain([["SET", pendingKey, 2], ["SET", windowKey, limit - 2], ["DEL", openKey, `${openKey}:b`]]);
  const admit = (store: typeof again) => admitOrders(store, 1, now).catch((): Admission => ({ ok: false, reason: "unavailable" }));
  await reset();
  let trips = 0;
  redis.pipeline = async (commands) => { trips += 1; return plain(commands); };
  is("set up: the held orders alone fill the figure", await admit(again), { ok: false, reason: "paused" });
  redis.pipeline = plain;
  is("set up: an admission makes several round trips", trips >= 2, true);
  const breaches: string[] = [];
  for (let at = 1; at <= trips; at += 1) {
    await reset();
    let call = 0;
    let racer: Admission | null = null;
    const hooked = async (commands: (string | number)[][]): Promise<unknown[]> => {
      call += 1;
      if (call === at) {
        // A second checkout's admission runs whole before this round trip.
        redis.pipeline = plain;
        racer = await admit(again);
        redis.pipeline = hooked;
      }
      return plain(commands);
    };
    redis.pipeline = hooked;
    const first = await admit(again);
    redis.pipeline = plain;
    const total = (await read(windowKey)) + (await held());
    const second = racer as Admission | null;
    if (first.ok || second?.ok || total > limit || (await read(pendingKey)) !== 0) {
      breaches.push(`before trip ${at}: first ${JSON.stringify(first)}, racing ${JSON.stringify(second)}, counted and open ${total}`);
    }
  }
  is("no admission past the figure, whichever round trip a second one lands before", breaches, []);

  part("A failure while moving the held orders never loses them (Claude 4 on #3150)");
  const losses: string[] = [];
  for (const lost of ["before it runs", "after it ran"] as const) {
    for (let at = 1; at <= trips; at += 1) {
      await reset();
      let call = 0;
      // The connection is lost at this round trip (its reply never arrives) and stays lost.
      redis.pipeline = async (commands) => {
        call += 1;
        if (call < at) return plain(commands);
        if (call === at && lost === "after it ran") await plain(commands);
        throw new Error("connection lost");
      };
      const answer = await admit(again);
      redis.pipeline = plain;
      const kept = (await read(pendingKey)) + (await read(windowKey));
      if (answer.ok || kept !== limit) losses.push(`lost ${lost} at trip ${at}: ${JSON.stringify(answer)}, held and counted ${kept} of ${limit}`);
    }
  }
  is("the held orders are always either still held or in the window, never in neither", losses, []);
  await reset();
  is("once Redis answers again, they are moved and fill the figure", await admit(again), { ok: false, reason: "paused" });
  is("all of them in the window", await read(windowKey), limit);
  is("none left held", await read(pendingKey), 0);

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
