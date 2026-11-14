/**
 * A closing's start (told marks, email credit, call budget) is owned by its ending, once (Codex S's review
 * 5820667208 on #3309; Codex G's review 5820723226 on #3299).
 *
 * closeOne (lib/plan-closing.ts) started a closing with three writes, each through the REST pipeline, which is not a
 * transaction: forgetTold (DEL of the addresses told), startClosingCredit (a plain SET of the email credit) and
 * startCallBudget. Two overlapping runs that both read no holdFrom both started it. In Codex G's schedule, B reads
 * the state and pauses before measuring the store; A starts the closing, writes holdFrom, and the closing then takes
 * credit and marks the buyers it told; B resumes and starts it again. The credit went back to its full amount and
 * the told marks were gone, so buyers could be emailed twice and more emails sent than the cap allows.
 *
 * Now one script, CLOSING_START (`-- marktmorgen:closing-start:v1`, now v2), does the three writes atomically, and only when
 * the work hash is not already this ending's ("of"): 1 when started now, 0 when already started for this ending
 * (credit, marks, budget and cursors kept), -1 when a key is of another type (nothing written). Any reply but the
 * exact 1 or 0 throws UnknownReplyError (CX-123 rule 24), so closeOne writes no holdFrom. Since v2 a reply of 2 means
 * a newer ending started already (tests/closing-start-older-ending.test.ts).
 *
 * Synthetic data only: the in-memory Redis (tests/redis-stub.ts), with pipelines swapped, a measure stand-in that
 * pauses, and a Stripe and email stand-in that answers nothing (no real service is reached).
 */
import { createHash } from "node:crypto";
import { EMAILS_PER_BUYER_PER_ENDING, STRIPE_CALLS_PER_MEMBER, buyerNoticeCap } from "@/lib/closing-buyers-rules";
import { toldKey } from "@/lib/closing-buyers";
import { creditKey, takeCredit } from "@/lib/closing-credit";
import { takeCalls, workKey } from "@/lib/closing-holds";
import * as closing from "@/lib/plan-closing";
import { type Hands, closeOne } from "@/lib/plan-closing";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, setStripeAccount, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

/** The closing's start for `folder`: the one script on its three keys. */
const isStart = (commands: Commands, folder: string): boolean =>
  commands.length === 1 && commands[0]?.[0] === "EVAL" && String(commands[0]?.[1]).startsWith("-- marktmorgen:closing-start:v2\n") && commands[0]?.[5] === workKey(folder);

/** Replies swapped for the start of `folder`: with `run`, the script runs first (the write landed, the reply was lost). */
let swap: { folder: string; reply: unknown; run: boolean } | null = null;
redis.pipeline = (async (commands: Commands) => {
  if (swap && isStart(commands, swap.folder)) {
    if (swap.run) await pipeline(commands);
    return swap.reply as unknown[];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

// Stripe and the email sender: nothing is reached, every call is refused.
globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 })) as typeof fetch;

/** The function under test, read by name so this file builds before it exists. */
const startClosing = (folder: string, emails: number, calls: number, ending: number): Promise<unknown> =>
  (closing as unknown as { startClosing: (folder: string, emails: number, calls: number, ending: number) => Promise<unknown> }).startClosing(folder, emails, calls, ending);

/** "UnknownReplyError" or "rejected" when the promise rejects, otherwise what it resolved to. */
async function outcome<T>(run: () => Promise<T>): Promise<T | "UnknownReplyError" | "rejected"> {
  try {
    return await run();
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : "rejected";
  }
}

const get = async (command: (string | number)[]): Promise<unknown> => (await pipeline([command]))[0];
/** What the closing of `folder` holds: credit left, a told mark, calls left, the ending its work is for. */
async function held(folder: string, email = "buyer@example.com"): Promise<unknown[]> {
  return [await get(["GET", creditKey(folder)]), await get(["HGET", toldKey(folder), email]), await get(["HGET", workKey(folder), "calls"]), await get(["HGET", workKey(folder), "of"])];
}

const stateKey = (key: string) => `nl:plan:closing:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
async function stateOf(key: string): Promise<Record<string, unknown>> {
  const raw = await get(["GET", stateKey(key)]);
  return typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

let made = 0;
/** A store on a paid plan that has just ended, connected to its own Stripe account. */
async function endedStore(handle: string): Promise<{ email: string; folder: string; endedAt: number; cap: number }> {
  made += 1;
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, `${handle[0].toUpperCase()}${handle.slice(1)} Shop`, "");
  await setSubscription(email, { customerId: `cus_${handle}0001`, subscriptionId: `sub_${handle}plan01`, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await setStripeAccount(email, `acct_start${String(made).padStart(2, "0")}`, true);
  await setSubscription(email, { active: false });
  const store = (await storeForEmail(email))!;
  const folder = await storeFolder(storeRef(store));
  return { email, folder, endedAt: Date.parse(store.planEndedAt), cap: buyerNoticeCap(store.tier, true) };
}

const hands: Hands = { measure: async () => 0, list: async () => [], remove: async () => {} };
const realNow = Date.now.bind(Date);
const ENDING = Date.UTC(2026, 10, 1, 12);
const NEXT_ENDING = Date.UTC(2026, 11, 3, 9);
const BUYER = "buyer@example.com";

async function main(): Promise<void> {
  redis.clear();

  part("Codex G's schedule: B pauses after reading the state, A starts the closing and it spends; B's start puts nothing back");
  {
    const { email, folder, endedAt, cap } = await endedStore("startg");
    const emails = cap * EMAILS_PER_BUYER_PER_ENDING;
    const calls = cap * STRIPE_CALLS_PER_MEMBER;
    const at = endedAt + 60_000;
    Date.now = () => at;
    try {
      let reached!: () => void;
      const atMeasure = new Promise<void>((resolve) => (reached = resolve));
      let open!: () => void;
      const wait = new Promise<void>((resolve) => (open = resolve));
      const pausedHands: Hands = { ...hands, measure: async () => { reached(); await wait; return 0; } };
      const b = outcome(() => closeOne(email, at, pausedHands, Number.POSITIVE_INFINITY));
      await atMeasure;
      is("B read the state before A: no holdFrom yet", (await stateOf(email)).holdFrom, undefined);
      await outcome(() => closeOne(email, at, hands, Number.POSITIVE_INFINITY));
      is("A started the closing: holdFrom written, full credit and calls", [(await stateOf(email)).holdFrom, await get(["GET", creditKey(folder)]), await get(["HGET", workKey(folder), "calls"])], [at, String(emails), String(calls)]);
      // The closing spends: three emails, a buyer marked as told, two calls.
      is("the closing takes 3 emails and 2 calls", [await takeCredit(folder, 3), await takeCalls(folder, 2)], [true, true]);
      await pipeline([["HSET", toldKey(folder), BUYER, String(endedAt)]]);
      open();
      const bOut = await b;
      is("B's run resolved or was held, never another error", bOut === "UnknownReplyError" || (typeof bOut === "object" && bOut !== null), true);
      is("after B: the credit stays spent, the told mark stays, the calls stay spent", await held(folder), [String(emails - 3), String(endedAt), String(calls - 2), String(endedAt)]);
    } finally {
      Date.now = realNow;
    }
  }

  part("The same ending started twice: credit, told marks, budget and cursors are kept");
  {
    const folder = "start-same";
    is("first start: resolves as started", await outcome(() => startClosing(folder, 10, 16, ENDING)), "started");
    is("first start: credit, no marks, budget, owned by its ending", await held(folder), ["10", null, "16", String(ENDING)]);
    await takeCredit(folder, 4);
    await takeCalls(folder, 5);
    await pipeline([["HSET", toldKey(folder), BUYER, String(ENDING)], ["HSET", workKey(folder), "hc", "{\"h\":1,\"p\":\"page_2\"}", "rcalls", 3]]);
    is("second start of the same ending: resolves as kept", await outcome(() => startClosing(folder, 10, 16, ENDING)), "kept");
    is("second start of the same ending: nothing set back", await held(folder), ["6", String(ENDING), "11", String(ENDING)]);
    is("second start of the same ending: its cursor and set-aside calls kept", [await get(["HGET", workKey(folder), "hc"]), await get(["HGET", workKey(folder), "rcalls"])], ["{\"h\":1,\"p\":\"page_2\"}", "3"]);
    swap = { folder, reply: [0], run: false };
    is("a reply of 0 is read as started already", await outcome(() => startClosing(folder, 10, 16, ENDING)), "kept");
    swap = null;

    part("A new ending resets all three");
    is("a new ending: resolves as started", await outcome(() => startClosing(folder, 12, 24, NEXT_ENDING)), "started");
    is("a new ending: its own credit and budget, the earlier marks gone", await held(folder), ["12", null, "24", String(NEXT_ENDING)]);
    is("a new ending: the earlier cursor and set-aside calls are cleared", [await get(["HGET", workKey(folder), "hc"]), await get(["HGET", workKey(folder), "rcalls"])], [null, null]);
    is("a new ending, 0 emails and 0 calls: both 0, never absent", [await outcome(() => startClosing("start-zero", 0, 0, ENDING)), await get(["GET", creditKey("start-zero")]), await get(["HGET", workKey("start-zero"), "calls"]), await takeCredit("start-zero", 1), await takeCalls("start-zero", 1)], ["started", "0", "0", false, false]);
  }

  part("A key of another type: refused, and nothing written");
  const WRONG: [string, (folder: string) => (string | number)[]][] = [
    ["the told marks are text", (folder) => ["SET", toldKey(folder), "x"]],
    ["the told marks are a list", (folder) => ["RPUSH", toldKey(folder), "x"]],
    ["the credit is a hash", (folder) => ["HSET", creditKey(folder), "x", "1"]],
    ["the credit is a list", (folder) => ["RPUSH", creditKey(folder), "x"]],
    ["the work is text", (folder) => ["SET", workKey(folder), "x"]],
    ["the work is a list", (folder) => ["RPUSH", workKey(folder), "x"]],
  ];
  for (const [label, write] of WRONG) {
    const folder = `start-type-${label.replace(/\W+/g, "-")}`;
    await pipeline([write(folder)]);
    const before = [await get(["TYPE", toldKey(folder)]), await get(["TYPE", creditKey(folder)]), await get(["TYPE", workKey(folder)])];
    is(`${label}: refused as unknown`, await outcome(() => startClosing(folder, 10, 16, ENDING)), "UnknownReplyError");
    is(`${label}: the three keys are left as they were`, [await get(["TYPE", toldKey(folder)]), await get(["TYPE", creditKey(folder)]), await get(["TYPE", workKey(folder)])], before);
  }

  part("Any reply but the exact 1 or 0 is refused as unknown");
  const BAD: [string, unknown][] = [
    ["-1 (another type)", [-1]],
    ["3", [3]],
    ["\"2\"", ["2"]],
    ["\"1\"", ["1"]],
    ["\"0\"", ["0"]],
    ["\"OK\"", ["OK"]],
    ["null", [null]],
    ["undefined", [undefined]],
    ["true", [true]],
    ["a list", [[1]]],
    ["an object", [{ result: 1 }]],
    ["no reply at all", []],
    ["an extra, unasked-for reply", [1, 1]],
    ["a reply that is not a list", { result: [1] }],
  ];
  for (const [label, reply] of BAD) {
    for (const run of [false, true]) {
      const folder = `start-shape-${run ? "landed" : "lost"}`;
      await pipeline([["DEL", toldKey(folder), creditKey(folder), workKey(folder)]]);
      swap = { folder, reply, run };
      is(`reply ${label} (${run ? "the write landed" : "the write did not land"}): refused as unknown`, await outcome(() => startClosing(folder, 10, 16, ENDING)), "UnknownReplyError");
      swap = null;
    }
  }
  is("an ending that is not a whole number of ms: refused before any write", [await outcome(() => startClosing("start-nan", 10, 16, Number.NaN)), await get(["EXISTS", workKey("start-nan")])], ["rejected", 0]);

  part("closeOne: holdFrom is never written on a start that was not confirmed, and is the next day");
  {
    const { email, folder, endedAt, cap } = await endedStore("startc");
    const at = endedAt + 60_000;
    Date.now = () => at;
    try {
      swap = { folder, reply: [null], run: false };
      is("closeOne, the start answered null: the day fails as unknown", await outcome(() => closeOne(email, at, hands, Number.POSITIVE_INFINITY)), "UnknownReplyError");
      swap = null;
      is("closeOne, the start answered null: holdFrom is not written, nothing set", [(await stateOf(email)).holdFrom, ...(await held(folder))], [undefined, null, null, null, null]);
      const next = at + 86_400_000;
      Date.now = () => next;
      await outcome(() => closeOne(email, next, hands, Number.POSITIVE_INFINITY));
      is("closeOne, the next day: holdFrom written, the closing started for its ending", [(await stateOf(email)).holdFrom, ...(await held(folder))], [next, String(cap * EMAILS_PER_BUYER_PER_ENDING), null, String(cap * STRIPE_CALLS_PER_MEMBER), String(endedAt)]);
    } finally {
      swap = null;
      Date.now = realNow;
    }
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
