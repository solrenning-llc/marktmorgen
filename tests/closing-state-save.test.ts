/**
 * A store's closing state is written only over the state the run read (residual 1 of the closing start follow-up,
 * after Codex G's G112 on #3299 and Codex S's review of #3309).
 *
 * closeOne (lib/plan-closing.ts) reads a store's closing state once, at its top, and saved every step with a plain
 * SET of that snapshot. A run that read the state before another run advanced it could still save its stale
 * snapshot over the newer one:
 *
 *   - a run paused on an older ending whose snapshot already had holdFrom never reaches the start (which refuses an
 *     older ending since CLOSING_START v2): it held the members' charges for the older ending (HELD_INDEX scored
 *     with it) and saved the older ending's state over the newer ending's;
 *   - two runs on the same ending that both read no holdFrom: the late one's start answers 0 (kept), and it then
 *     saved its own holdFrom over the faster run's state, losing the faster run's `hold`, and held the charges again;
 *   - a store whose plan ended before KEEP_NOTHING_FROM: the late run's "it fits" save put back an older `fit`.
 *
 * Now every save in closeOne goes through one script, CLOSING_STATE_SAVE (`-- marktmorgen:closing-state-save:v1`),
 * which writes only over exactly the state this run read or last wrote (1), answers 0 when another run wrote it
 * since and -1 for a key of another type, writing nothing on either. On 0, closeOne stops for this store with a held
 * result ("another run advanced this store's closing") and writes nothing more; the next day reads it afresh. A run
 * that does not start the closing first checks that the state is still the one it read, before it acts on it. Any
 * reply but the exact 1 or 0 throws UnknownReplyError (CX-123 rule 24).
 *
 * Synthetic data only: the in-memory Redis (tests/redis-stub.ts), a measure stand-in that pauses, and a Stripe and
 * email stand-in that answers nothing (no real service is reached).
 */
import { createHash } from "node:crypto";
import { HELD_INDEX, workKey } from "@/lib/closing-holds";
import * as closing from "@/lib/plan-closing";
import { type Hands, closeOne } from "@/lib/plan-closing";
import { KEEP_NOTHING_FROM } from "@/lib/plan-closing-rules";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

const stateKey = (key: string) => `nl:plan:closing:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;

/** A save of `key`'s closing state: the one script, whatever its version. */
const isSave = (commands: Commands, key: string): boolean =>
  commands.length === 1 && commands[0]?.[0] === "EVAL" && String(commands[0]?.[1]).startsWith("-- marktmorgen:closing-state-save:") && commands[0]?.[3] === stateKey(key);

/** Replies swapped for the saves of `key`: with `run`, the script runs first (the write landed, the reply was lost). */
let swap: { key: string; reply: unknown; run: boolean } | null = null;
/** Every command list sent while `watched` is set, to see what a run wrote. */
let watched: Commands[] | null = null;
redis.pipeline = (async (commands: Commands) => {
  watched?.push(commands);
  if (swap && isSave(commands, swap.key)) {
    if (swap.run) await pipeline(commands);
    return swap.reply as unknown[];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

// Stripe and the email sender: nothing is reached, every call is refused.
globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 })) as typeof fetch;

/** "UnknownReplyError" or "rejected" when it throws, otherwise what it resolved to. */
async function outcome<T>(run: () => Promise<T>): Promise<T | "UnknownReplyError" | "rejected"> {
  try {
    return await run();
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : "rejected";
  }
}
/** A closeOne result, as its state and its note. */
const shape = (out: unknown): unknown => (out !== null && typeof out === "object" ? { state: (out as { state: string }).state, note: (out as { note?: string }).note } : out);

const get = async (command: (string | number)[]): Promise<unknown> => (await pipeline([command]))[0];
async function stateOf(key: string): Promise<Record<string, unknown>> {
  const raw = await get(["GET", stateKey(key)]);
  return typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
}
/** The commands a run sent that write a store's closing state (SET, DEL or the save script). */
const stateWrites = (commands: Commands[], key: string): number =>
  commands.filter((list) => list.some((c) => (c[0] === "SET" || c[0] === "DEL") && c[1] === stateKey(key)) || isSave(list, key)).length;
/** The commands a run sent that write the closing's hold line or its work (ZADD, ZREM, HSET, HDEL, DEL, EVAL on them). */
const holdWrites = (commands: Commands[], folder: string, ref: string): number =>
  commands.filter((list) => list.some((c) => (c[0] === "ZADD" && c[1] === HELD_INDEX && c.includes(ref)) || (["HSET", "HDEL", "HINCRBY", "DEL"].includes(String(c[0])) && c[1] === workKey(folder)))).length;

/** The committed script, run as closeOne runs it, on one key. */
const save = (key: string, mode: string, expected: string, next: string): Promise<unknown> =>
  outcome(() => get(["EVAL", String((closing as unknown as { CLOSING_STATE_SAVE?: string }).CLOSING_STATE_SAVE), 1, key, mode, expected, next]));

/** A store on a paid plan that has just ended, with no Stripe account (its members' hold has nothing to reach). */
async function endedStore(handle: string, at = Date.now()): Promise<{ email: string; folder: string; ref: string; endedAt: number }> {
  const real = Date.now;
  Date.now = () => at;
  try {
    const email = `${handle}@example.com`;
    await claimHandle(email, handle, `${handle[0].toUpperCase()}${handle.slice(1)} Shop`, "");
    await setSubscription(email, { customerId: `cus_${handle}0001`, subscriptionId: `sub_${handle}plan01`, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
    await setSubscription(email, { active: false });
    const store = (await storeForEmail(email))!;
    return { email, folder: await storeFolder(storeRef(store)), ref: storeRef(store), endedAt: Date.parse(store.planEndedAt) };
  } finally {
    Date.now = real;
  }
}

/** Hands whose measure stops until `open` is called; `reached` resolves once a run is inside it. */
function pausing(): { hands: Hands; reached: Promise<void>; open: () => void } {
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { hands: { ...hands, measure: async () => { reach(); await wait; return 0; } }, reached, open };
}

const hands: Hands = { measure: async () => 0, list: async () => [], remove: async () => {} };
const realNow = Date.now.bind(Date);
const DAY = 86_400_000;
const ADVANCED = "another run advanced this store's closing";

async function main(): Promise<void> {
  redis.clear();

  part("A run paused on an older ending, its snapshot with holdFrom: the newer ending's state and hold stay");
  {
    const { email, folder, ref, endedAt } = await endedStore("casolder");
    // An earlier day started the older ending's closing; its members' hold did not finish then.
    await pipeline([["SET", stateKey(email), JSON.stringify({ of: endedAt, holdFrom: endedAt + 1_000 })]]);
    const startClosing = (closing as unknown as { startClosing: (f: string, e: number, c: number, n: number) => Promise<unknown> }).startClosing;
    is("the older ending's closing was started", await startClosing(folder, 10, 16, endedAt), "started");
    const at = endedAt + 60_000;
    Date.now = () => at;
    try {
      const paused = pausing();
      const b = outcome(() => closeOne(email, at, paused.hands, Number.POSITIVE_INFINITY));
      await paused.reached;
      // The plan runs again and ends again: a newer ending, which A starts and holds through the real closeOne.
      const newerAt = at + 60_000;
      Date.now = () => newerAt;
      await setSubscription(email, { active: true });
      await setSubscription(email, { active: false });
      const newer = Date.parse((await storeForEmail(email))!.planEndedAt);
      is("a newer ending was made through the subscription writes", newer > endedAt, true);
      await outcome(() => closeOne(email, newerAt + 60_000, hands, Number.POSITIVE_INFINITY));
      const before = await stateOf(email);
      is("A started and held the newer ending: its state", [before.of, before.holdFrom, before.hold], [newer, newerAt + 60_000, newerAt + 60_000]);
      is("A held the newer ending: the hold line is scored with it", Number(await get(["ZSCORE", HELD_INDEX, ref])), newer);

      watched = [];
      paused.open();
      const bOut = await b;
      const sent = watched;
      watched = null;
      is("B, on the older ending, is held: another run advanced the closing", shape(bOut), { state: "held", note: ADVANCED });
      is("after B: the state is the newer ending's, unchanged", await stateOf(email), before);
      is("after B: the hold line is still scored with the newer ending", Number(await get(["ZSCORE", HELD_INDEX, ref])), newer);
      is("after B: the work is still the newer ending's", await get(["HGET", workKey(folder), "of"]), String(newer));
      is("B wrote nothing to the closing state", stateWrites(sent, email), 0);
      is("B wrote nothing to the hold line or the work", holdWrites(sent, folder, ref), 0);
    } finally {
      Date.now = realNow;
    }
  }

  part("Two runs on the same ending, both read no holdFrom: the late start is kept (0) and saves nothing over the faster run");
  {
    const { email, folder, ref, endedAt } = await endedStore("cassame");
    const at = endedAt + 60_000;
    Date.now = () => at;
    try {
      const paused = pausing();
      const b = outcome(() => closeOne(email, at, paused.hands, Number.POSITIVE_INFINITY));
      await paused.reached;
      const aAt = at + 1_000;
      Date.now = () => aAt;
      const aOut = await outcome(() => closeOne(email, aAt, hands, Number.POSITIVE_INFINITY));
      const before = await stateOf(email);
      is("A started and held the closing: its state", [before.of, before.holdFrom, before.hold], [endedAt, aAt, aAt]);
      is("A is held only for the creator's notice", (aOut as { state?: string }).state, "held");

      watched = [];
      paused.open();
      const bOut = await b;
      const sent = watched;
      watched = null;
      is("B is held: another run advanced the closing", shape(bOut), { state: "held", note: ADVANCED });
      is("after B: A's state is unchanged (its holdFrom and its hold)", await stateOf(email), before);
      is("after B: the work is the same ending's", await get(["HGET", workKey(folder), "of"]), String(endedAt));
      is("B held no charges again (nothing written to the hold line or the work)", holdWrites(sent, folder, ref), 0);
      is("B's start was kept, then its one save refused: one attempt, nothing written", sent.filter((list) => isSave(list, email)).length, 1);

      Date.now = () => aAt + DAY;
      const next = await outcome(() => closeOne(email, aAt + DAY, hands, Number.POSITIVE_INFINITY));
      is("the next day goes on from A's state", [(next as { state?: string }).state, await stateOf(email)], ["held", before]);
    } finally {
      Date.now = realNow;
    }
  }

  part("A store that keeps its room (ended before KEEP_NOTHING_FROM): a late \"it fits\" puts back no older mark");
  {
    const { email, endedAt } = await endedStore("casfits", KEEP_NOTHING_FROM - 30 * DAY);
    is("its plan ended before KEEP_NOTHING_FROM", endedAt < KEEP_NOTHING_FROM, true);
    const at = endedAt + DAY;
    Date.now = () => at;
    try {
      const paused = pausing();
      const b = outcome(() => closeOne(email, at, paused.hands, Number.POSITIVE_INFINITY));
      await paused.reached;
      const aAt = at + 1_000;
      Date.now = () => aAt;
      is("A: it fits", shape(await outcome(() => closeOne(email, aAt, hands, Number.POSITIVE_INFINITY))), { state: "fits", note: undefined });
      const before = await stateOf(email);
      is("A's state", before, { of: endedAt, fit: aAt });

      watched = [];
      paused.open();
      const bOut = await b;
      const sent = watched;
      watched = null;
      is("B is held: another run advanced the closing", shape(bOut), { state: "held", note: ADVANCED });
      is("after B: A's state is unchanged", await stateOf(email), before);
      is("B's one save was refused, nothing else written to the state", [sent.filter((list) => isSave(list, email)).length, stateWrites(sent, email)], [1, 1]);
    } finally {
      Date.now = realNow;
    }
  }

  part("Healthy: one run saves every step as before, and the next day goes on");
  {
    const { email, ref, endedAt } = await endedStore("cashealthy");
    const at = endedAt + 60_000;
    Date.now = () => at;
    try {
      const first = await outcome(() => closeOne(email, at, hands, Number.POSITIVE_INFINITY));
      is("the first day: held only for the creator's notice", (first as { state?: string }).state, "held");
      is("the first day: holdFrom and hold saved", await stateOf(email), { of: endedAt, holdFrom: at, hold: at });
      is("the first day: the hold line is scored with the ending", Number(await get(["ZSCORE", HELD_INDEX, ref])), endedAt);
      is("the state has no expiry, as a plain SET left it", await get(["TTL", stateKey(email)]), -1);
      Date.now = () => at + DAY;
      const second = await outcome(() => closeOne(email, at + DAY, hands, Number.POSITIVE_INFINITY));
      is("the next day: the same result", shape(second), shape(first));
      is("the next day: the state goes on unchanged", await stateOf(email), { of: endedAt, holdFrom: at, hold: at });
    } finally {
      Date.now = realNow;
    }
    const fits = await endedStore("cashealthyfits", KEEP_NOTHING_FROM - 30 * DAY);
    const fitAt = fits.endedAt + DAY;
    Date.now = () => fitAt;
    try {
      is("a store that keeps its room: it fits", shape(await outcome(() => closeOne(fits.email, fitAt, hands, Number.POSITIVE_INFINITY))), { state: "fits", note: undefined });
      is("a store that keeps its room: its fit saved", await stateOf(fits.email), { of: fits.endedAt, fit: fitAt });
    } finally {
      Date.now = realNow;
    }
  }

  part("The script: written only over the state read");
  {
    const key = "nl:plan:closing:cas-script";
    const A = JSON.stringify({ of: 1, holdFrom: 2 });
    const B = JSON.stringify({ of: 1, holdFrom: 2, hold: 3 });
    is("nothing read, nothing there: written (1)", [await save(key, "none", "", A), await get(["GET", key])], [1, A]);
    is("nothing read, something there now: 0, nothing written", [await save(key, "none", "", B), await get(["GET", key])], [0, A]);
    is("read A, A there: written (1)", [await save(key, "is", A, B), await get(["GET", key])], [1, B]);
    is("read A, B there now: 0, nothing written", [await save(key, "is", A, A), await get(["GET", key])], [0, B]);
    await pipeline([["DEL", key]]);
    is("read A, deleted since: 0, nothing written", [await save(key, "is", A, B), await get(["GET", key])], [0, null]);
    await pipeline([["SET", key, A, "EX", 3600]]);
    is("a plain SET: the expiry goes, as before", [await save(key, "is", A, B), await get(["TTL", key])], [1, -1]);
    await pipeline([["DEL", key], ["HSET", key, "of", "1"]]);
    is("a hash there: -1, nothing written", [await save(key, "none", "", A), await get(["TYPE", key])], [-1, "hash"]);
    await pipeline([["DEL", key], ["RPUSH", key, A]]);
    is("a list there: -1, nothing written", [await save(key, "is", A, B), await get(["TYPE", key]), await get(["LRANGE", key, 0, -1])], [-1, "list", [A]]);
    await pipeline([["DEL", key], ["SET", key, A]]);
    is("a mode that is neither: -1, nothing written", [await save(key, "maybe", A, B), await get(["GET", key])], [-1, A]);
  }

  part("closeOne reads the save's reply exactly");
  {
    const replies: [string, unknown, boolean, unknown][] = [
      ["0", [0], false, { state: "held", note: ADVANCED }],
      ["-1", [-1], false, "UnknownReplyError"],
      ["\"1\"", ["1"], true, "UnknownReplyError"],
      ["\"OK\"", ["OK"], true, "UnknownReplyError"],
      ["null", [null], true, "UnknownReplyError"],
      ["[1]", [[1]], true, "UnknownReplyError"],
      ["2", [2], true, "UnknownReplyError"],
      ["1 and 1", [1, 1], true, "UnknownReplyError"],
      ["no reply", [], true, "UnknownReplyError"],
    ];
    for (const [label, reply, run, want] of replies) {
      const { email, endedAt } = await endedStore(`casreply${replies.findIndex((r) => r[0] === label)}`);
      const at = endedAt + 60_000;
      Date.now = () => at;
      try {
        swap = { key: email, reply, run };
        watched = [];
        const out = await outcome(() => closeOne(email, at, hands, Number.POSITIVE_INFINITY));
        const sent = watched;
        watched = null;
        swap = null;
        is(`a reply of ${label}: ${typeof want === "string" ? "refused as unknown" : "held"}`, typeof out === "string" ? out : shape(out), want);
        is(`a reply of ${label}: no other save after it`, sent.filter((list) => isSave(list, email)).length, 1);
      } finally {
        swap = null;
        watched = null;
        Date.now = realNow;
      }
    }
    const { email, endedAt } = await endedStore("casreplyok");
    const at = endedAt + 60_000;
    Date.now = () => at;
    try {
      swap = { key: email, reply: [1], run: true };
      const out = await outcome(() => closeOne(email, at, hands, Number.POSITIVE_INFINITY));
      swap = null;
      is("a reply of 1: every step saved, as with no swap", [(out as { state?: string }).state, await stateOf(email)], ["held", { of: endedAt, holdFrom: at, hold: at }]);
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
