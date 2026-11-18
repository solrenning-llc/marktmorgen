/**
 * A closing's start never goes back to an older ending (Codex G's G112 on #3299, residual "G3299-EPOCH").
 *
 * CLOSING_START (lib/plan-closing.ts) started a closing once an ending, but it compared the work hash's "of" with
 * the run's ending only for equality. In Codex G's schedule, B enters closeOne, reads the store and the state, and
 * pauses while measuring the store. The plan runs again and ends again, so the store has a newer ending; A starts
 * that newer ending's closing, which spends its email credit and its calls to Stripe and marks a buyer as told. B
 * then resumes with its snapshot of the older ending, and its start reset everything: the credit went back to its
 * full amount, the told mark was gone, the calls came back, and the work hash and the state were the older ending's
 * again. Buyers could be emailed twice and past the cap, and members' charges held twice past the call budget.
 *
 * Now the script compares the endings as numbers: the same ending answers 0 (everything kept, as before), a newer
 * ending already started answers 2 and writes nothing, an older or missing one is replaced (1), and an "of" that is
 * not a whole number of ms answers -1 and writes nothing. startClosing reads 0, 1 and 2 exactly; on 2, closeOne
 * stops for this store with a held result and saves nothing, so the stale snapshot never reaches the state.
 *
 * Synthetic data only: the in-memory Redis (tests/redis-stub.ts), a measure stand-in that pauses, and a Stripe and
 * email stand-in that answers nothing (no real service is reached).
 */
import { createHash } from "node:crypto";
import { EMAILS_PER_BUYER_PER_ENDING, buyerNoticeCap } from "@/lib/closing-buyers-rules";
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

/** The closing's start for `folder`: the one script on its three keys, whatever its version. */
const isStart = (commands: Commands, folder: string): boolean =>
  commands.length === 1 && commands[0]?.[0] === "EVAL" && String(commands[0]?.[1]).startsWith("-- marktmorgen:closing-start:") && commands[0]?.[5] === workKey(folder);

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

/** The function under test, read by name so this file builds whatever it returns. */
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
const BUYER = "buyer@example.com";
/** Everything a closing's start may touch: credit left, a told mark, calls left, the ending its work is for, its cursor. */
async function held(folder: string): Promise<unknown[]> {
  return [await get(["GET", creditKey(folder)]), await get(["HGET", toldKey(folder), BUYER]), await get(["HGET", workKey(folder), "calls"]), await get(["HGET", workKey(folder), "of"]), await get(["HGET", workKey(folder), "hc"])];
}
/** The committed script, run as closeOne runs it, on `folder`'s three keys. */
const run = (folder: string, emails: number, calls: number, ending: string): Promise<unknown> =>
  get(["EVAL", closing.CLOSING_START, 3, toldKey(folder), creditKey(folder), workKey(folder), emails, calls, ending]);

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
  await setStripeAccount(email, `acct_older${String(made).padStart(2, "0")}`, true);
  await setSubscription(email, { active: false });
  const store = (await storeForEmail(email))!;
  const folder = await storeFolder(storeRef(store));
  return { email, folder, endedAt: Date.parse(store.planEndedAt), cap: buyerNoticeCap(store.tier, true) };
}

const hands: Hands = { measure: async () => 0, list: async () => [], remove: async () => {} };
const realNow = Date.now.bind(Date);
const OLD = Date.UTC(2026, 10, 1, 12);
const NEW = OLD + 120_000;
const NEWER = Date.UTC(2026, 11, 3, 9);
const CURSOR = "{\"h\":1,\"p\":\"page_2\"}";

async function main(): Promise<void> {
  redis.clear();

  part("Codex G's schedule: B pauses on an older ending, A starts the newer one and spends; B puts nothing back");
  {
    const { email, folder, endedAt, cap } = await endedStore("olderg");
    const allowance = cap * EMAILS_PER_BUYER_PER_ENDING;
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
      // B keeps its snapshot of the older ending. The plan runs again and ends again: a newer, legitimate ending.
      const newerAt = at + 60_000;
      Date.now = () => newerAt;
      await setSubscription(email, { active: true });
      await setSubscription(email, { active: false });
      const newerEnding = Date.parse((await storeForEmail(email))!.planEndedAt);
      is("a newer ending was made through the subscription writes", newerEnding > endedAt, true);
      await outcome(() => closeOne(email, newerAt + 60_000, hands, Number.POSITIVE_INFINITY));
      const aState = await stateOf(email);
      is("A started the newer ending: the state is its own, with holdFrom", [aState.of, aState.holdFrom], [newerEnding, newerAt + 60_000]);
      is("A started the newer ending: its full credit", await get(["GET", creditKey(folder)]), String(allowance));
      is("the newer ending's closing takes its whole credit, and one more is refused", [await takeCredit(folder, allowance), await takeCredit(folder, 1)], [true, false]);
      const calls = Number(await get(["HGET", workKey(folder), "calls"]));
      is("the newer ending's closing takes its whole call budget", await takeCalls(folder, calls), true);
      await pipeline([["HSET", toldKey(folder), BUYER, String(newerEnding)]]);
      const before = await stateOf(email);

      open();
      const bOut = await b;
      is("B, on the older ending, is held and says a newer ending started", bOut !== null && typeof bOut === "object" ? { state: (bOut as { state: string }).state, note: (bOut as { note?: string }).note } : bOut, { state: "held", note: "a newer ending of this store already started" });
      is("after B: the credit stays spent", await get(["GET", creditKey(folder)]), "0");
      is("after B: the buyer told stays marked", await get(["HGET", toldKey(folder), BUYER]), String(newerEnding));
      is("after B: one more email is still refused", await takeCredit(folder, 1), false);
      is("after B: the work is still the newer ending's", await get(["HGET", workKey(folder), "of"]), String(newerEnding));
      is("after B: the calls stay spent", await get(["HGET", workKey(folder), "calls"]), "0");
      is("after B: the state is the newer ending's, unchanged", await stateOf(email), before);
    } finally {
      Date.now = realNow;
    }
  }

  part("The script: the endings compared as numbers");
  {
    const folder = "older-script";
    is("no work yet: started (1)", await run(folder, 10, 16, String(NEW)), 1);
    await takeCredit(folder, 4);
    await takeCalls(folder, 5);
    await pipeline([["HSET", toldKey(folder), BUYER, String(NEW)], ["HSET", workKey(folder), "hc", CURSOR]]);
    const spent = ["6", String(NEW), "11", String(NEW), CURSOR];
    is("spent: credit, mark, calls, ending and cursor", await held(folder), spent);
    is("the same ending: answers 0 (started already)", await run(folder, 10, 16, String(NEW)), 0);
    is("the same ending: everything kept", await held(folder), spent);
    is("an older ending: answers 2 (a newer ending already started)", await run(folder, 10, 16, String(OLD)), 2);
    is("an older ending: nothing written", await held(folder), spent);
    is("an older ending by 1 ms: answers 2", await run(folder, 10, 16, String(NEW - 1)), 2);
    is("an older ending by 1 ms: nothing written", await held(folder), spent);
    is("an ending of 0 under a newer one: answers 2", await run(folder, 10, 16, "0"), 2);
    is("a newer ending: answers 1 (started now)", await run(folder, 12, 24, String(NEWER)), 1);
    is("a newer ending: its own credit and budget, the earlier mark and cursor gone", await held(folder), ["12", null, "24", String(NEWER), null]);
    is("an ending of 0 written down, a later one: started (1)", [await run("older-zero", 1, 2, "0"), await run("older-zero", 3, 4, String(OLD)), await get(["HGET", workKey("older-zero"), "of"])], [1, 1, String(OLD)]);
  }

  part("The script: an \"of\" that is not a whole number of ms is refused, and nothing written");
  const NOT_MS = ["abc", "", "1e12", "0123", " 12", "12 ", "12.5", "-5", "+5", "0x10", "1234567890123456", "inf", "nan"];
  for (const of of NOT_MS) {
    const folder = `older-of-${NOT_MS.indexOf(of)}`;
    await pipeline([["SET", creditKey(folder), "6"], ["HSET", toldKey(folder), BUYER, "1"], ["HSET", workKey(folder), "calls", "11", "of", of, "hc", CURSOR]]);
    const before = [await get(["GET", creditKey(folder)]), await get(["HGET", toldKey(folder), BUYER]), await get(["HGET", workKey(folder), "calls"]), await get(["HGET", workKey(folder), "of"]), await get(["HGET", workKey(folder), "hc"])];
    is(`"of" ${JSON.stringify(of)}: answers -1`, await run(folder, 10, 16, String(NEW)), -1);
    is(`"of" ${JSON.stringify(of)}: nothing written`, await held(folder), before);
    is(`"of" ${JSON.stringify(of)}: startClosing refuses it as unknown`, await outcome(() => startClosing(folder, 10, 16, NEW)), "UnknownReplyError");
  }

  part("startClosing reads 0, 1 and 2 exactly");
  {
    const folder = "older-reads";
    is("no work yet: started", await outcome(() => startClosing(folder, 10, 16, NEW)), "started");
    is("the same ending: kept", await outcome(() => startClosing(folder, 10, 16, NEW)), "kept");
    is("an older ending: newer", await outcome(() => startClosing(folder, 10, 16, OLD)), "newer");
    is("an older ending: nothing written", await held(folder), ["10", null, "16", String(NEW), null]);
    swap = { folder, reply: [2], run: false };
    is("a reply of 2: newer", await outcome(() => startClosing(folder, 10, 16, NEW)), "newer");
    for (const [label, reply] of [["\"2\"", ["2"]], ["3", [3]], ["-2", [-2]], ["2.5", [2.5]], ["[2]", [[2]]], ["2 and 2", [2, 2]]] as [string, unknown][]) {
      swap = { folder, reply, run: false };
      is(`a reply of ${label}: refused as unknown`, await outcome(() => startClosing(folder, 10, 16, NEW)), "UnknownReplyError");
    }
    swap = null;
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
