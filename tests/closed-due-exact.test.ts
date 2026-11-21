/**
 * A closing store's place in line for the walk that erases closed stores is confirmed only by Redis's exact answer
 * (rule 24/30; #4221, Codex U): markDue (lib/closed-store-data.ts) never read the reply of its ZADD NX, and its three
 * callers in lib/plan-closing.ts then saved `due` on the store's closing state. Every later pass sees `due` and skips
 * markDue, so a store whose write was not applied stayed out of the erasure queue for good while its state said it
 * was queued: its records, and what keeping them costs, were never erased.
 *
 * Now only the integer 0 or 1 confirms the write. Any other reply is resolved by an exact read-back of the store's
 * score; when that does not show it in line either, markDue throws UnknownReplyError, `due` is not saved, and the
 * next run tries again.
 *
 * Synthetic stores, in-memory Redis.
 */
import { createHash } from "node:crypto";
import { DUE_KEY, markDue } from "@/lib/closed-store-data";
import { UnknownReplyError } from "@/lib/redis-reply";
import { type Hands, closeOne } from "@/lib/plan-closing";
import { ENDED_INDEX } from "@/lib/plan-standing";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const stateKey = (key: string) => `nl:plan:closing:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
const hands = { measure: async () => 10 ** 12 } as unknown as Hands;

/** How the line's write is answered: as Redis does, with a reply Redis never gives (not applied, or applied), and its read-back. */
let zadd: "redis" | "lost" | "applied-unconfirmed" = "redis";
let zscoreUnreadable = false;
let scoreReply: { value: unknown } | undefined;
let zadds = 0;
const realPipeline = redis.pipeline;
redis.pipeline = async (commands: (string | number)[][]) => {
  if (commands.length === 1 && commands[0][0] === "ZADD" && commands[0][1] === DUE_KEY) {
    zadds += 1;
    if (zadd === "lost") return [null];
    if (zadd === "applied-unconfirmed") {
      await realPipeline(commands);
      return [{ ok: 1 }];
    }
  }
  if (scoreReply && commands.length === 1 && commands[0][0] === "ZSCORE" && commands[0][1] === DUE_KEY) return [scoreReply.value];
  if (zscoreUnreadable && commands.length === 1 && commands[0][0] === "ZSCORE" && commands[0][1] === DUE_KEY) return ["not a score"];
  return realPipeline(commands);
};

async function threw(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "resolved";
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `threw: ${(error as Error).message}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const score = (ref: string) => redis.run(["ZSCORE", DUE_KEY, ref]);

  part("markDue: only Redis's exact answer confirms a store in line for the walk");
  zadd = "lost";
  is("a reply Redis never gives, the write not applied: it says so (unknown), never 'in line'", await threw(() => markDue("lost@example.com", 1_000)), "UnknownReplyError");
  is("and the store is not in line", score("lost@example.com"), null);
  zadd = "applied-unconfirmed";
  is("a reply Redis never gives, the write applied: the exact read-back confirms it", await threw(() => markDue("applied@example.com", 2_000)), "resolved");
  is("and the store is in line", score("applied@example.com"), "2000");
  zadd = "lost";
  zscoreUnreadable = true;
  is("a read-back that does not read is unknown too", await threw(() => markDue("unread@example.com", 3_000)), "UnknownReplyError");
  zscoreUnreadable = false;
  zadd = "redis";
  is("control: Redis's own answer confirms it", await threw(() => markDue("healthy@example.com", 4_000)), "resolved");
  is("control: in line", score("healthy@example.com"), "4000");
  is("control: already in line (ZADD NX answers 0) is in line, its first time kept", [await threw(() => markDue("healthy@example.com", 5_000)), score("healthy@example.com")], ["resolved", "4000"]);

  part("a foreign score must not confirm an unapplied write");
  zadd = "lost";
  for (const [i, value] of ["0x7d0", "0b11111010000", "0o3720", " 2000 ", "\t2000\n"].entries()) {
    const ref = `foreign-score-${i}@example.test`;
    scoreReply = { value };
    is("foreign score is unknown: " + JSON.stringify(value), await threw(() => markDue(ref, 2_000)), "UnknownReplyError");
    scoreReply = undefined;
    is("the real queue still has no member", score(ref), null);
  }
  zadd = "applied-unconfirmed";
  scoreReply = { value: "2e3" };
  is("control: decimal scientific text can confirm an existing member", await threw(() => markDue("decimal-score@example.test", 2_000)), "resolved");
  scoreReply = undefined;
  is("control: it is really in line", score("decimal-score@example.test"), "2000");

  part("closeOne: a closed store whose line write is not confirmed does not save `due`, and the next run puts it in line");
  const A = "closed-due@example.com";
  await claimHandle(A, "closeddue", "Closed Due", "");
  await ensureStatsId(A);
  await ensureStoreId(A);
  await setSubscription(A, { active: true, customerId: "cus_closeddue01", subscriptionId: "sub_closeddue01", tier: "creator" });
  const ended = await setSubscription(A, { active: false });
  const endedAt = Date.parse(ended?.planEndedAt ?? "");
  if (!Number.isFinite(endedAt) || !(await storeForEmail(A))) throw new Error("setup: no ended plan");
  redis.run(["ZADD", ENDED_INDEX, endedAt, A]);
  // Its closing day is behind it: everything it keeps was removed, and only its place in the walk's line is left.
  redis.run(["SET", stateKey(A), JSON.stringify({ of: endedAt, removed: endedAt + 1 })]);
  const dueOf = () => (JSON.parse(String(redis.run(["GET", stateKey(A)]))) as { due?: number }).due;

  zadd = "lost";
  zadds = 0;
  // The write is absent and its read-back is a foreign numeric-looking string.
  scoreReply = { value: "0x7d0" };
  const first = await threw(() => closeOne(A, Date.now(), hands));
  scoreReply = undefined;
  is("the line's write was asked once", zadds, 1);
  is("not confirmed: the pass does not finish as 'removed' (the walk holds it)", first, "UnknownReplyError");
  is("its state does not say `due`", dueOf(), undefined);
  is("and it is not in line", score(A), null);

  zadd = "redis";
  zadds = 0;
  const retry = await closeOne(A, Date.now(), hands);
  is("the next run asks again and puts it in line", [zadds, retry.state, score(A) !== null], [1, "removed", true]);
  is("only now its state says `due`", typeof dueOf(), "number");
  done();
}

void main();
