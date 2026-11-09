/**
 * Use past what a plan covers, put on the creator's next invoice.
 *
 * Three things were charged by use here: lesson video watched past a plan's
 * hours (lib/watch-rules.ts), visits to a store past a plan's visits
 * (lib/traffic-rules.ts), and orders past a plan's orders
 * (lib/order-rules.ts). Since 17 October 2026 visits and orders are not:
 * their meters owe nothing and keep only the record that a creator was
 * written to (lib/traffic-billing.ts, lib/orders-billing.ts). Since
 * 31 October 2026 (232 [CA1] unit 3) video owes nothing either
 * (lib/watch-billing.ts): no meter puts used service on an invoice. Each keeps its own count (lib/watch.ts,
 * lib/traffic.ts) and has its own price; this is the part they share, the
 * daily job's part (app/api/cron/usage): for every store past what its plan
 * covers it works out what the month has come to, takes away what was
 * already put on an invoice, and adds the difference as one line on the
 * store's own subscription (lib/billing.ts, addToNextInvoice). Stripe
 * charges it with the plan, to the card the plan is paid with. Nobody has to
 * notice, and nobody is cut off.
 *
 * Each thing charged this way is a Meter, and keeps its records under its
 * own name:
 *
 *   nl:<name>:billed:<folder>:<month>   cents of that month already on an invoice
 *   nl:<name>:adding:<folder>:<month>   a line being added, until it is known to be there
 *   nl:<name>:told:<folder>:<month>     the creator was written to about that month
 *   nl:watch:monthly:<subscription>     a yearly plan was set to bill added lines monthly
 *
 * Never twice. What is being added is written down before Stripe is asked,
 * with a mark that goes on the line itself. If the answer never comes back,
 * the next run looks for the mark before it adds anything: found, the line
 * is counted as billed; not found, the same request is made again under the
 * same key, which Stripe will not carry out a second time.
 *
 * While a month is running a line is added only once it is worth a dollar,
 * so an invoice does not fill with one-cent lines. When the month is over
 * whatever is left is added, down to the cent.
 */
import { addToNextInvoice, billAddedLinesMonthly, findInvoiceLine, isBillingConfigured } from "@/lib/billing";
import { monthKey, storeKeysOf } from "@/lib/delivery";
import { randomInt } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { releaseLock } from "@/lib/redis-lock";
import { repliesFor } from "@/lib/redis-reply";
import { type Store, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { SMALLEST_LINE_CENTS, canBeCharged, monthBefore } from "@/lib/watch-rules";

/** One thing a store is charged for by use. */
export type Meter = {
  /** The word its records and the marks on its lines begin with: "watch", "visits". */
  name: string;
  /** How much of it a store used in a month, in its own unit. */
  measured: (folder: string, month: string) => Promise<number>;
  /**
   * What that comes to past what the plan covers, in cents. The store is
   * handed over when it is known, for a thing a larger plan covers more of.
   */
  owed: (amount: number, store: Store | null) => number;
  /** Whether what is owed depends on the store's plan, so the store is read before anything is worked out. */
  byPlan: boolean;
  /** At or under this much, no store on any plan owes anything. */
  covered: number;
  /** The line as the creator reads it on the invoice. */
  describe: (month: string, amount: number, store: Store | null) => string;
  /** The stores that used any of it in a month. */
  folders: (month: string) => Promise<string[]>;
};

const billedKey = (meter: Meter, folder: string, month: string) => `nl:${meter.name}:billed:${folder}:${month}`;
const addingKey = (meter: Meter, folder: string, month: string) => `nl:${meter.name}:adding:${folder}:${month}`;
const toldKey = (meter: Meter, folder: string, month: string) => `nl:${meter.name}:told:${folder}:${month}`;
const monthlyKey = (subscriptionId: string) => `nl:watch:monthly:${subscriptionId}`;

const KEEP_SECONDS = 400 * 24 * 60 * 60;
/** The first days of a month in which the month before is still settled, so a day Stripe could not be reached is made up. */
const SETTLE_DAYS = 5;

/**
 * `amount` is what the line says was used, kept so a second try sends word
 * for word what the first did. (`seconds` is the same thing under the name
 * it had when video was the only thing charged this way.)
 */
type Adding = { from: number; to: number; at: number; amount: number; line: string; customerId: string; subscriptionId: string };

function parseAdding(raw: unknown): Adding | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<Adding> & { seconds?: unknown };
    if (typeof value.from !== "number" || typeof value.to !== "number" || !(value.to > value.from) || value.from < 0) return null;
    if (typeof value.customerId !== "string" || typeof value.subscriptionId !== "string" || typeof value.at !== "number") return null;
    const used = typeof value.amount === "number" ? value.amount : typeof value.seconds === "number" ? value.seconds : 0;
    return {
      from: value.from,
      to: value.to,
      at: value.at,
      amount: used > 0 ? used : 0,
      line: typeof value.line === "string" ? value.line : "",
      customerId: value.customerId,
      subscriptionId: value.subscriptionId,
    };
  } catch {
    return null;
  }
}

export type Settled = {
  folder: string;
  month: string;
  /** How much the store used that month, in the meter's unit. */
  amount: number;
  /** What the month has come to in all, in cents, and what this run put on an invoice. */
  owed: number;
  added: number;
  /**
   *   nothing   inside what the plan covers, or all of it already billed
   *   waiting   past it by less than a line is worth while the month runs
   *   billed    a line was added
   *   no_plan   the store has no plan that can be charged (it is paused instead)
   *   no_store  nobody is known to own the folder
   *   failed    Stripe could not be asked; it is tried again tomorrow
   */
  state: "nothing" | "waiting" | "billed" | "no_plan" | "no_store" | "failed";
  store: Store | null;
};

const mark = (meter: Meter, folder: string, month: string, from: number) => `${meter.name}:${folder}:${month}:${from}`;

/** Adds one line, or finds that it is there already. True when the line is on the subscription. */
async function carryOut(meter: Meter, folder: string, month: string, adding: Adding): Promise<boolean> {
  try {
    const sign = mark(meter, folder, month, adding.from);
    // A request made before may have gone through without our hearing of it.
    if (await findInvoiceLine(adding.customerId, sign, Math.floor(adding.at / 1000) - 60, { subscriptionId: adding.subscriptionId, cents: adding.to - adding.from })) return true;
    await addToNextInvoice({
      customerId: adding.customerId,
      subscriptionId: adding.subscriptionId,
      cents: adding.to - adding.from,
      description: adding.line || meter.describe(month, adding.amount, null),
      mark: sign,
      idempotencyKey: `nl-${sign}:${adding.to}`,
    });
    return true;
  } catch (error) {
    console.error(`adding ${meter.name} to an invoice failed`, error);
    return false;
  }
}

/**
 * A once-only mark (CX-123 rule 24), the same rule as lib/claim-mark.ts
 * (#2714), kept here until that file is on this branch: SET NX with a value
 * no other attempt writes. "OK", one reply for the one command, is ours and
 * nil is taken. Any other answer, or none, is read back: our own value
 * there means the write landed and the mark is ours; another value, taken;
 * anything else is unknown, and nothing is written or sent on it. The
 * common path is one command, as before.
 */
type Marked = "ours" | "taken" | "unknown";

/** The time in milliseconds and a random part, so no two attempts write the same value. */
function markValue(now = Date.now()): string {
  return `${now}.${String(randomInt(1_000_000_000)).padStart(9, "0")}`;
}

async function takeMark(key: string, value: string): Promise<Marked> {
  let reply: unknown[] | null;
  try {
    reply = repliesFor(await redisPipeline([["SET", key, value, "NX", "EX", KEEP_SECONDS]]), 1);
  } catch {
    reply = null;
  }
  if (reply?.[0] === "OK") return "ours";
  if (reply && reply[0] === null) return "taken";
  // Answered in another shape, or not at all: the write may have landed.
  try {
    const held = repliesFor(await redisPipeline([["GET", key]]), 1);
    if (!held) return "unknown";
    if (held[0] === value) return "ours";
    return typeof held[0] === "string" ? "taken" : "unknown";
  } catch {
    return "unknown";
  }
}

/** The store a folder belongs to; null when nobody is known to own it, or the store is gone. */
export async function storeOf(folder: string): Promise<Store | null> {
  const [key] = await storeKeysOf([folder]);
  if (!key) return null;
  const store = await storeForEmail(key);
  // The folder is worked out from the store's key: one that does not come
  // back to this folder is not the store this use belongs to.
  if (!store || (await storeFolder(storeRef(store))) !== folder) return null;
  return store;
}

/**
 * A plan paid by the year makes one invoice a year. Its added lines are
 * billed by the month instead, set once for the subscription.
 */
async function monthlyFor(store: Store | null, subscriptionId: string): Promise<void> {
  if (store?.cycle !== "year" || store.subscriptionId !== subscriptionId) return;
  const key = monthlyKey(subscriptionId);
  const value = markValue();
  // Only a mark known to be ours asks Stripe: taken or unknown, nothing is written this time.
  if ((await takeMark(key, value)) !== "ours") return;
  await billAddedLinesMonthly(subscriptionId).catch(async (error) => {
    console.error("could not set a yearly plan to bill added lines monthly", error);
    // Tried again with the next line. Until then the line waits for the yearly invoice, and is still billed.
    // Let go only while it still holds our value, so another run's mark is never deleted (lib/redis-lock.ts).
    await releaseLock({ key, token: value, ttlSeconds: KEEP_SECONDS });
  });
}

/**
 * Settles one store's month for one meter. `final` when the month is over:
 * whatever is left is billed, however small.
 */
export async function settleUsage(meter: Meter, folder: string, month: string, final: boolean, now = Date.now()): Promise<Settled> {
  const amount = await meter.measured(folder, month);
  // Where the plan decides what is covered, the store is read first.
  let store: Store | null = null;
  let read = false;
  if (meter.byPlan && isRedisConfigured()) {
    store = await storeOf(folder);
    read = true;
  }
  const owed = meter.owed(amount, store);
  const out: Settled = { folder, month, amount, owed, added: 0, state: "nothing", store };
  if (!isRedisConfigured()) return out;

  const [billedRaw, addingRaw] = await redisPipeline([
    ["GET", billedKey(meter, folder, month)],
    ["GET", addingKey(meter, folder, month)],
  ]);
  let billed = Number(billedRaw) > 0 ? Math.floor(Number(billedRaw)) : 0;
  let unfinished = parseAdding(addingRaw);
  if (unfinished && unfinished.from !== billed) {
    // Written down for a figure that has since moved on: it was carried out.
    await redisPipeline([["DEL", addingKey(meter, folder, month)]]);
    unfinished = null;
  }
  if (unfinished && unfinished.to > owed) {
    // Written down for more than the meter owes now: never finished, so
    // nothing past what is owed reaches an invoice. Since 31 October 2026
    // every meter owes nothing (232 [CA1] unit 3), so a line begun before
    // then is dropped here instead of being charged after use.
    await redisPipeline([["DEL", addingKey(meter, folder, month)]]);
    unfinished = null;
  }
  if (!unfinished) {
    if (owed - billed <= 0) return out;
    if (!final && owed - billed < SMALLEST_LINE_CENTS) return { ...out, state: "waiting" };
  }

  if (!read) store = await storeOf(folder);
  out.store = store;

  // A line that was being added when the last run ended: finished first,
  // for the customer it was begun for.
  if (unfinished) {
    if (!isBillingConfigured() || !(await carryOut(meter, folder, month, unfinished))) return { ...out, state: "failed" };
    billed = unfinished.to;
    out.added += unfinished.to - unfinished.from;
    out.state = "billed";
    await redisPipeline([
      ["SET", billedKey(meter, folder, month), billed, "EX", KEEP_SECONDS],
      ["DEL", addingKey(meter, folder, month)],
    ]);
    await monthlyFor(store, unfinished.subscriptionId);
  }

  const due = owed - billed;
  if (due <= 0 || (!final && due < SMALLEST_LINE_CENTS)) return out;
  if (!store) return { ...out, state: "no_store" };
  if (!canBeCharged(store, now / 1000) || !store.stripeCustomerId || !store.subscriptionId) return { ...out, state: "no_plan" };
  if (!isBillingConfigured()) return { ...out, state: "failed" };

  const adding: Adding = {
    from: billed,
    to: owed,
    at: now,
    amount,
    line: meter.describe(month, amount, store),
    customerId: store.stripeCustomerId,
    subscriptionId: store.subscriptionId,
  };
  await redisPipeline([["SET", addingKey(meter, folder, month), JSON.stringify(adding), "EX", KEEP_SECONDS]]);
  if (!(await carryOut(meter, folder, month, adding))) return { ...out, state: "failed" };
  await redisPipeline([
    ["SET", billedKey(meter, folder, month), owed, "EX", KEEP_SECONDS],
    ["DEL", addingKey(meter, folder, month)],
  ]);
  out.added += due;
  await monthlyFor(store, store.subscriptionId);
  return { ...out, state: "billed" };
}

/**
 * The daily run for one meter: this month for every store that used any of
 * it, and the month before while it is still being closed.
 */
export async function settleAllUsage(meter: Meter, now = Date.now()): Promise<Settled[]> {
  if (!isRedisConfigured()) return [];
  const today = new Date(now);
  const month = monthKey(today);
  const results: Settled[] = [];
  const runs: [string, boolean][] = [[month, false]];
  if (today.getUTCDate() <= SETTLE_DAYS) runs.unshift([monthBefore(month), true]);
  for (const [which, final] of runs) {
    for (const folder of await meter.folders(which)) {
      try {
        // A store inside what every plan covers has nothing to settle, and is not asked about further.
        // A figure that cannot be read (it throws: audit SG2, CX-123 rule 24) leaves only this store
        // for the next run, logged below; the others go on.
        if ((await meter.measured(folder, which)) <= meter.covered) continue;
        results.push(await settleUsage(meter, folder, which, final, now));
      } catch (error) {
        console.error(`settling a store's ${meter.name} failed`, error);
      }
    }
  }
  return results;
}

/**
 * Whether the creator still has to be written to about this month: true the
 * first time it is asked for a store, a month and a meter, and never again.
 */
export async function firstWordOf(meter: Meter, folder: string, month: string): Promise<boolean> {
  // Taken or unknown, nobody is written to this run (CX-123 rule 24).
  return (await takeMark(toldKey(meter, folder, month), markValue())) === "ours";
}
