/**
 * Independent review of PR #2560 at 4c3e1ab53 (delta 1a0982fff..4c3e1ab53).
 * Each section is a scenario the delta says cannot happen; each fails at that head.
 */
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, storeFolder, storeForEmail } from "@/lib/store";
import { finishClosed } from "@/lib/plan-closing";
import { WALK_GAP_MS, eraseClosed, markDue } from "@/lib/closed-store-data";

type Command = (string | number)[];
const real = redis.pipeline;
type Rule = { when: (command: Command) => boolean; answer: (command: Command) => unknown; times: number; used: number };
let rules: Rule[] = [];
redis.pipeline = async (commands: Command[]) => {
  const out: unknown[] = [];
  for (const command of commands) {
    const rule = rules.find((r) => r.used < r.times && r.when(command));
    if (rule) {
      rule.used += 1;
      out.push(await rule.answer(command));
    } else out.push((await real([command]))[0]);
  }
  return out;
};
function failing(when: Rule["when"], answer: Rule["answer"], times = 1): Rule {
  const rule = { when, answer, times, used: 0 };
  rules.push(rule);
  return rule;
}

const DAY = 86_400_000;
let clock = Date.UTC(2026, 10, 5);
const later = () => (clock += WALK_GAP_MS + DAY);
const run = () => eraseClosed(Date.now() + 30_000, finishClosed, clock);
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const before = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = before;
  }
}
async function closing(handle: string): Promise<string> {
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, `${handle} studio`, "");
  await markDue(email, clock);
  return email;
}
/** `days` gaps, each run until its walk is done; answers how many walks were started. */
async function days(n: number): Promise<number> {
  let walks = 0;
  for (let i = 0; i < n; i += 1) {
    later();
    let report = await quietly(() => run().catch(() => ({ done: false, started: false })));
    if (report.started) walks += 1;
    for (let j = 0; j < 5 && !report.done; j += 1) report = await quietly(() => run().catch(() => ({ done: false, started: false })));
  }
  return walks;
}
const closingState = async (ref: string) => JSON.parse(String((await real([["GET", `nl:plan:closing:${createHash("sha256").update(ref).digest("hex").slice(0, 40)}`]]))[0] ?? "{}")) as { erased?: number };

async function section(name: string, work: () => Promise<void>): Promise<void> {
  part(name);
  rules = [];
  try {
    await work();
  } catch (error) {
    is(`${name}: runs to its end`, String(error), "no error");
  }
}

async function main(): Promise<void> {
  redis.clear();

  await section("N: every store of a walk sits it out and a company list is passed over: the rows' HSET has no field, and the walk never ends", async () => {
    // As Redis answers it (HSET's arity is -4): an HSET with no field and value is an error, never a no-op.
    failing((c) => c[0] === "HSET" && c.length < 4, () => {
      throw new Error("Redis error: ERR wrong number of arguments for 'hset' command");
    }, 1_000_000);
    later();
    await real([["ZADD", "nl:pause:due", 4102444800, "someone-else@example.com"]]);
    const ned = await closing("nedout");
    // Its record's delete fails every time: it is never confirmed gone, so it sits every walk out.
    const nedOwner = `nl:store:owner:${createHash("sha256").update(`nimbus-store:${ned}`).digest("hex").slice(0, 40)}`;
    failing((c) => c[0] === "DEL" && c[1] === nedOwner, () => {
      throw new Error("Redis request timed out");
    }, 1_000_000);
    failing((c) => c[0] === "TYPE" && c[1] === "nl:pause:due", () => "not-a-kind", 1_000_000);
    await days(2);
    // The list stays unreadable (a list given up on stays so); a store that closes later, with nothing failing for it.
    const zoe = await closing("zoelater");
    await days(4);
    const phase = ((await real([["HGET", "nl:closed:walk", "phase"]]))[0]) as string | null;
    const zoeDone = (await closingState(zoe)).erased !== undefined;
    const hsetErrors = rules[0].used;
    console.log(`  HSETs with no field refused ${hsetErrors}; walk phase ${phase}; the later store finished ${zoeDone}; ${ned} record kept ${(await storeForEmail(ned)) !== null}`);
    is("a later store is still deleted and finished", zoeDone, true);
  });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
