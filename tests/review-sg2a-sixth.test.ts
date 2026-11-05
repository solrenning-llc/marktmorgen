/**
 * Independent review of PR #2560 at 1a0982fff (delta fe13f03f2..1a0982fff).
 * Each section is a scenario the delta says cannot happen; each fails at that head.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle } from "@/lib/store";
import { finishClosed } from "@/lib/plan-closing";
import { UNREAD_TRIES, WALK_GAP_MS, closedDataNow, eraseClosed, markDue } from "@/lib/closed-store-data";

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

  await section("M: a list given up on, passed over again by a later walk and then read: the old stores' members stay, and are no longer said", async () => {
    later();
    const mo = await closing("moold");
    await real([["ZADD", "nl:pause:due", 4102444800, mo]]);
    const odd = failing((c) => c[0] === "TYPE" && c[1] === "nl:pause:due", () => "not-a-kind", 1_000_000);
    // Its walk passes the list over, and every gap's pruning fails until the list is given up on.
    await days(UNREAD_TRIES + 3);
    const given = await closedDataNow();
    console.log(`  given up: unreadKept ${given?.unreadKept}, owedKept ${given?.owedKept}`);
    // A later store closes while the list still cannot be read: its walk passes it over again; then the list reads.
    await closing("monew");
    await days(1);
    odd.times = odd.used;
    await days(3);
    const after = await closedDataNow();
    const member = (await real([["ZSCORE", "nl:pause:due", mo]]))[0];
    console.log(`  after the list reads: old store's member still in it ${member !== null}; owedKept ${after?.owedKept}, unread ${after?.unread}`);
    is("an old store's member left in a company list is pruned, or still said in the owner's line", member === null || (after?.owedKept ?? 0) > 0, true);
  });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
