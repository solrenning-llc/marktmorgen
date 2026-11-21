/**
 * One order is counted exactly once (lib/orders.ts, countOrder), whatever
 * round trip fails (CX-123 rule 24; Claude 6's review of #3391).
 *
 * The order's mark (nl:orders:seen:) and the count it adds to (the window's
 * nl:orders:n:, or nl:orders:pending: while a paying store's window is
 * unknown) are written together or not at all. A round trip that never
 * reaches Redis, or whose reply is lost after Redis ran it, ends with the
 * order counted once: either countOrder settles it itself, or it answers
 * "unknown" and the next try counts it. It never answers false (nothing left
 * to count) while the order may still be uncounted, and it never counts an
 * order twice. A count that is not a whole number is never written over:
 * the order stays unmarked, so it is counted once the count is readable.
 */
import { countOrder, ordersIn } from "@/lib/orders";
import { allowanceWindow, calendarWindow } from "@/lib/allowance-window";
import { claimHandle, ensureStatsId, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const DAY = 86_400;

async function main(): Promise<void> {
  redis.clear();
  const realError = console.error;
  console.error = () => {};
  const now = Date.now();
  const calendar = calendarWindow(now).id;
  const plain = redis.pipeline.bind(redis);
  const read = async (key: string) => (await plain([["GET", key]]))[0];
  const ttl = async (key: string) => Number((await plain([["TTL", key]]))[0]);
  const touches = (commands: Commands) => commands.some((command) => command.some((part) => typeof part === "string" && part.startsWith("nl:orders:")));

  const OWNER = "orders-exact@example.com";
  await claimHandle(OWNER, "ordersexact", "Orders Exact", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const folder = await storeFolder(OWNER);
  const countKey = `nl:orders:n:${folder}:${calendar}`;
  let serial = 0;
  const reference = () => `checkout:cs_test_exact${String(serial += 1).padStart(6, "0")}`;

  part("Control: a healthy order is counted once, with its marks and keeps as before");
  is("set up: a store with no plan counts in the calendar month", allowanceWindow(store, now)?.id, calendar);
  const first = reference();
  is("the order is counted", await countOrder(store, first, 0, now), true);
  is("in the month's count", await ordersIn(folder, calendar), 1);
  is("the same order again counts nothing", await countOrder(store, first, 0, now), false);
  is("still one", await ordersIn(folder, calendar), 1);
  const seen = [...(redis as unknown as { data: Map<string, unknown> }).data.keys()].filter((key) => key.startsWith("nl:orders:seen:"));
  is("one mark, of the order", seen.length, 1);
  is("the mark is '1'", await read(seen[0]), "1");
  is("kept 45 days", Math.abs((await ttl(seen[0])) - 45 * DAY) <= 2, true);
  is("the count is kept 400 days", Math.abs((await ttl(countKey)) - 400 * DAY) <= 2, true);
  is("the month lists the store", ((await plain([["SMEMBERS", `nl:orders:folders:${calendar}`]]))[0] as string[]).includes(folder), true);
  is("and its folder's owner", await read(`nl:store:folder-owner:${folder}`), OWNER);
  const twice = reference();
  const both = await Promise.all([countOrder(store, twice, 0, now), countOrder(store, twice, 0, now)]);
  is("two at once: one counts it, the other counts nothing", [...both].sort(), [false, true]);
  is("counted once", await ordersIn(folder, calendar), 2);

  /**
   * Fails the at-th round trip that touches an order key, before it reaches
   * Redis or after Redis ran it (its reply lost), and only that one. Answers
   * what the order's count gained once countOrder answered, with one more try
   * when it answered "unknown" (or threw), and what a further try answers.
   */
  const sweep = async (target: typeof store, key: string, label: string) => {
    let trips = 0;
    redis.pipeline = async (commands: Commands) => { if (touches(commands)) trips += 1; return plain(commands); };
    await countOrder(target, reference(), 0, now);
    redis.pipeline = plain;
    is(`set up (${label}): an order takes at least one round trip`, trips >= 1, true);
    const wrong: string[] = [];
    for (const lost of ["before it reached Redis", "after Redis ran it"] as const) {
      for (let at = 1; at <= trips + 1; at += 1) {
        const ref = reference();
        const before = Number(await read(key) ?? 0);
        let call = 0;
        redis.pipeline = async (commands: Commands) => {
          if (!touches(commands)) return plain(commands);
          call += 1;
          if (call !== at) return plain(commands);
          if (lost === "after Redis ran it") await plain(commands);
          throw new Error("connection lost");
        };
        const answer = await countOrder(target, ref, 0, now).catch(() => "threw");
        redis.pipeline = plain;
        let retried: unknown = null;
        if (answer === "unknown" || answer === "threw") retried = await countOrder(target, ref, 0, now).catch(() => "threw");
        const again = await countOrder(target, ref, 0, now).catch(() => "threw");
        const gained = Number(await read(key) ?? 0) - before;
        if (gained !== 1 || again !== false || answer === "threw" || retried === "threw" || (answer === false && gained !== 1)) {
          wrong.push(`lost ${lost} at trip ${at}: answered ${JSON.stringify(answer)}, then ${JSON.stringify(retried)}, then ${JSON.stringify(again)}; counted ${gained}`);
        }
      }
    }
    is(`${label}: every order counted exactly once, whichever round trip fails`, wrong, []);
  };

  part("A round trip that fails, or whose reply is lost, never leaves the order uncounted or counts it twice");
  await sweep(store, countKey, "a known window");

  part("Redis that keeps failing: the answer is unknown, never 'nothing to count'");
  {
    const ref = reference();
    const before = Number(await read(countKey));
    redis.pipeline = async (commands: Commands) => {
      if (touches(commands)) throw new Error("connection lost");
      return plain(commands);
    };
    const answer = await countOrder(store, ref, 0, now).catch(() => "threw");
    redis.pipeline = plain;
    is("countOrder answers unknown", answer, "unknown");
    is("nothing was counted", Number(await read(countKey)) - before, 0);
    is("once Redis answers again, the order is counted", await countOrder(store, ref, 0, now), true);
    is("once", Number(await read(countKey)) - before, 1);
  }

  part("A count that is not a whole number is never written over, and the order stays to be counted");
  {
    const ref = reference();
    const kept = await read(countKey);
    await plain([["SET", countKey, "not-a-count"]]);
    const answer = await countOrder(store, ref, 0, now).catch(() => "threw");
    is("countOrder answers unknown", answer, "unknown");
    is("the count is left as it was", await read(countKey), "not-a-count");
    await plain([["SET", countKey, String(kept)], ["EXPIRE", countKey, 400 * DAY]]);
    is("once the count is readable again, the order is counted", await countOrder(store, ref, 0, now), true);
    is("once", Number(await read(countKey)), Number(kept) + 1);
  }

  part("A paying store whose window is unknown: its held orders follow the same rule");
  const PAYER = "orders-exact-paying@example.com";
  await claimHandle(PAYER, "ordersexactpaying", "Orders Exact Paying", "");
  await ensureStatsId(PAYER);
  await setSubscription(PAYER, { customerId: "cus_OrdExact001", subscriptionId: "sub_OrdExact001", active: true, tier: "creator", period: paidPeriod(now) });
  await setSubscription(PAYER, { active: true, period: null });
  const unknown = (await storeForEmail(PAYER))!;
  const payerFolder = await storeFolder(PAYER);
  const pendingKey = `nl:orders:pending:${payerFolder}`;
  is("set up: a paid store with no period has no window", allowanceWindow(unknown, now), null);
  is("an order is held", await countOrder(unknown, reference(), 0, now), true);
  is("one held", Number(await read(pendingKey)), 1);
  is("held 400 days", Math.abs((await ttl(pendingKey)) - 400 * DAY) <= 2, true);
  is("nothing in the calendar month", await ordersIn(payerFolder, calendar), 0);
  await sweep(unknown, pendingKey, "an unknown window");

  console.error = realError;
  done();
}

void main();
