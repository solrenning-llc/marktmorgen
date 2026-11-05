/**
 * Independent review of PR #2560 at 2937c6e03 (delta 4c3e1ab53..2937c6e03).
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

  await section("O: a list given up on that reads again, with no walk passing it over, is pruned and let go", async () => {
    later();
    const ola = await closing("olakept");
    const oli = await closing("olikept");
    await real([["ZADD", "nl:pause:due", 4102444800, ola], ["ZADD", "nl:pause:due", 4102444800, oli], ["ZADD", "nl:pause:due", 4102444800, "someone-else@example.com"]]);
    const odd = failing((c) => c[0] === "TYPE" && c[1] === "nl:pause:due", () => "not-a-kind", 1_000_000);
    await days(UNREAD_TRIES + 3);
    const given = await closedDataNow();
    odd.times = odd.used;
    await days(3);
    const after = await closedDataNow();
    const members = [(await real([["ZSCORE", "nl:pause:due", ola]]))[0], (await real([["ZSCORE", "nl:pause:due", oli]]))[0], (await real([["ZSCORE", "nl:pause:due", "someone-else@example.com"]]))[0]];
    const keptLeft = (await real([["HLEN", "nl:closed:kept"]]))[0];
    console.log(`  given up: owedKept ${given?.owedKept}; after it reads: owedKept ${after?.owedKept}, unread ${after?.unread}, kept rows ${keptLeft}; members ${members.map((m) => (m === null ? "gone" : "kept")).join(", ")}`);
    is("both closed stores' members pruned, the other store's kept, nothing left owed", [members[0], members[1], members[2] !== null, after?.owedKept, keptLeft], [null, null, true, 0, 0]);
  });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
