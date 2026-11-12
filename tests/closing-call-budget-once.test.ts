/**
 * A closing's call budget is set once per ending, never replenished by a late start (Codex S's second monetary
 * review on #3309).
 *
 * startCallBudget (lib/closing-holds.ts) cleared the closing's work hash and set its "calls" with DEL + HSET through
 * the REST pipeline, which is not a transaction. Two overlapping closeOne runs that both read no holdFrom
 * (lib/plan-closing.ts) both start the budget: A's DEL lands and A pauses; B sets 5 calls and takes 1 (4 left); A's
 * late HSET puts "calls" back to 5. Whether A then throws or not, the write stays, and B can make 6 calls to the
 * creator's Stripe account from a 5-call allowance. Making DEL + HSET atomic alone would not help: a late atomic
 * reset still replenishes.
 *
 * Now the budget is owned by its ending: one script sets it only when the work hash is not already this ending's
 * ("of"), and answers 1 (set now) or 0 (already set for this ending, the balance and its cursors kept). A new ending
 * still clears the earlier one's cursors and set-aside calls. A key that is not a hash answers -1, and nothing is
 * deleted. Any reply but the exact 1 or 0 throws UnknownReplyError (CX-123 rule 24).
 *
 * Synthetic data only: the in-memory Redis (tests/redis-stub.ts), with pipelines paused or their replies swapped,
 * and a Stripe stand-in that answers nothing (no real service is reached).
 */
import { createHash } from "node:crypto";
import { startCallBudget, takeCalls, workKey } from "@/lib/closing-holds";
import { type Hands, closeOne } from "@/lib/plan-closing";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, setStripeAccount, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

/** Whether a pipeline is startCallBudget's for `folder`: the script on its work hash, or the DEL + HSET it sent before. */
const isBudget = (commands: Commands, folder: string): boolean => {
  const work = workKey(folder);
  const script = commands.length === 1 && commands[0]?.[0] === "EVAL" && String(commands[0]?.[1]).startsWith("-- marktmorgen:closing-call-budget:v1\n") && commands[0]?.[3] === work;
  const pair = commands.length === 2 && commands[0]?.[0] === "DEL" && commands[0]?.[1] === work && commands[1]?.[0] === "HSET" && commands[1]?.[1] === work;
  return script || pair;
};

/** A pause armed for the next budget pipeline of `folder`: before its command number `at`, or after its last. */
type Gate = { folder: string; at: number; reached: () => void; wait: Promise<void> };
let gate: Gate | null = null;
/** Replies swapped for the budget pipeline of `folder`: with `run`, its commands run first (the write landed, the reply was lost). */
let swap: { folder: string; reply: unknown; run: boolean } | null = null;

redis.pipeline = (async (commands: Commands) => {
  if (gate && isBudget(commands, gate.folder)) {
    const held = gate;
    gate = null;
    const out: unknown[] = [];
    for (let i = 0; i < commands.length; i += 1) {
      if (i === held.at) {
        held.reached();
        await held.wait;
      }
      out.push(...(await pipeline([commands[i]])));
    }
    if (held.at >= commands.length) {
      held.reached();
      await held.wait;
    }
    return out;
  }
  if (swap && isBudget(commands, swap.folder)) {
    if (swap.run) await pipeline(commands);
    return swap.reply as unknown[];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

// Stripe and the email sender: nothing is reached, every call is refused.
globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 })) as typeof fetch;

/** "UnknownReplyError" or "rejected" when the promise rejects, otherwise what it resolved to. */
async function outcome<T>(run: () => Promise<T>): Promise<T | "UnknownReplyError" | "rejected"> {
  try {
    return await run();
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : "rejected";
  }
}

async function field(folder: string, name: string): Promise<unknown> {
  const [value] = await pipeline([["HGET", workKey(folder), name]]);
  return value;
}

/** Runs A's budget start paused at `at`, B's start and one take in between, then lets A finish. */
async function overlap(folder: string, at: number, ending: number): Promise<{ a: unknown; b: unknown; took: boolean }> {
  let reached!: () => void;
  const atGate = new Promise<void>((resolve) => (reached = resolve));
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  gate = { folder, at, reached, wait };
  const a = outcome(() => startCallBudget(folder, 5, ending));
  await atGate;
  const b = await outcome(() => startCallBudget(folder, 5, ending));
  const took = await takeCalls(folder, 1);
  open();
  return { a: await a, b, took };
}

const ENDING = Date.UTC(2026, 10, 1, 12);
const NEXT_ENDING = Date.UTC(2026, 11, 3, 9);

async function main(): Promise<void> {
  redis.clear();

  part("Two overlapping starts of the same ending: a late start never puts back a call already taken");
  for (const [label, at] of [["A paused after its first command", 1], ["A wholly late, after B's start and take", 0]] as const) {
    const folder = `once-overlap-${at}`;
    const { a, b, took } = await overlap(folder, at, ENDING);
    is(`${label}: B's start resolved and B took one call`, [b, took], [undefined, true]);
    is(`${label}: A's start resolved or was refused as unknown, never another error`, a === undefined || a === "UnknownReplyError", true);
    is(`${label}: 4 of the 5 calls are left after A, never 5`, await field(folder, "calls"), "4");
    is(`${label}: only the 4 unspent calls can still be taken`, [await takeCalls(folder, 4), await takeCalls(folder, 1)], [true, false]);
  }

  part("The same ending started twice: the balance and the work done are kept");
  {
    const folder = "once-same";
    is("first start: resolves", await outcome(() => startCallBudget(folder, 6, ENDING)), undefined);
    is("first start: the budget is the calls asked for, owned by its ending", [await field(folder, "calls"), await field(folder, "of")], ["6", String(ENDING)]);
    is("two calls taken", await takeCalls(folder, 2), true);
    await pipeline([["HSET", workKey(folder), "hc", JSON.stringify({ h: 1, p: "page_2" }), "f:sub_keep01", "1", "rcalls", 3]]);
    is("second start of the same ending: resolves", await outcome(() => startCallBudget(folder, 6, ENDING)), undefined);
    is("second start of the same ending: the balance is kept, never set back to 6", await field(folder, "calls"), "4");
    is("second start of the same ending: its cursor, members to retry and set-aside calls are kept", [await field(folder, "hc"), await field(folder, "f:sub_keep01"), await field(folder, "rcalls")], [JSON.stringify({ h: 1, p: "page_2" }), "1", "3"]);
    is("second start of the same ending: a reply of 0 is read as already set", await outcome(async () => {
      swap = { folder, reply: [0], run: false };
      try {
        return await startCallBudget(folder, 6, ENDING);
      } finally {
        swap = null;
      }
    }), undefined);
  }

  part("A new ending starts its own budget and clears the earlier one's work");
  {
    const folder = "once-same";
    is("a new ending: resolves", await outcome(() => startCallBudget(folder, 9, NEXT_ENDING)), undefined);
    is("a new ending: the budget is its own calls, owned by it", [await field(folder, "calls"), await field(folder, "of")], ["9", String(NEXT_ENDING)]);
    is("a new ending: the earlier cursor, members to retry and set-aside calls are cleared", [await field(folder, "hc"), await field(folder, "f:sub_keep01"), await field(folder, "rcalls")], [null, null, null]);
    is("a new ending, 0 calls: the budget is 0, never absent", [await outcome(() => startCallBudget("once-zero", 0, ENDING)), await field("once-zero", "calls"), await takeCalls("once-zero", 1)], [undefined, "0", false]);
  }

  part("A work key that is not a hash: refused, and nothing deleted");
  for (const [type, write] of [["text", ["SET", workKey("once-type-text"), "kept"]], ["a list", ["RPUSH", workKey("once-type-list"), "kept"]]] as const) {
    const folder = `once-type-${type === "text" ? "text" : "list"}`;
    await pipeline([[...write]]);
    is(`${type} there: refused as unknown`, await outcome(() => startCallBudget(folder, 5, ENDING)), "UnknownReplyError");
    const [kind] = await pipeline([["TYPE", workKey(folder)]]);
    is(`${type} there: the key is left as it was`, kind, type === "text" ? "string" : "list");
  }

  part("Any reply but the exact 1 or 0 is refused as unknown");
  const BAD: [string, unknown][] = [
    ["-1 (not a hash)", [-1]],
    ["2", [2]],
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
      const folder = `once-shape-${run ? "landed" : "lost"}`;
      await pipeline([["DEL", workKey(folder)]]);
      swap = { folder, reply, run };
      is(`reply ${label} (${run ? "the write landed" : "the write did not land"}): refused as unknown`, await outcome(() => startCallBudget(folder, 5, ENDING)), "UnknownReplyError");
      swap = null;
    }
  }

  part("closeOne sets the budget for the ending it closes");
  {
    const email = "oncecl@example.com";
    await claimHandle(email, "oncecl", "Oncecl Shop", "");
    await setSubscription(email, { customerId: "cus_oncecl0001", subscriptionId: "sub_onceclplan01", active: true, tier: "creator", cycle: "month", trialEnds: 0 });
    await setStripeAccount(email, "acct_once01", true);
    await setSubscription(email, { active: false });
    const store = (await storeForEmail(email))!;
    const folder = await storeFolder(storeRef(store));
    const endedAt = Date.parse(store.planEndedAt);
    const at = endedAt + 60_000;
    const realNow = Date.now.bind(Date);
    const hands: Hands = { measure: async () => 0, list: async () => [], remove: async () => {} };
    Date.now = () => at;
    try {
      await outcome(() => closeOne(email, at, hands, Number.POSITIVE_INFINITY));
    } finally {
      Date.now = realNow;
    }
    const stateKey = `nl:plan:closing:${createHash("sha256").update(email).digest("hex").slice(0, 40)}`;
    const [raw] = await pipeline([["GET", stateKey]]);
    is("closeOne: holdFrom is written", typeof raw === "string" && typeof (JSON.parse(raw) as { holdFrom?: unknown }).holdFrom === "number", true);
    is("closeOne: the budget is owned by the plan's ending", await field(folder, "of"), String(endedAt));
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
