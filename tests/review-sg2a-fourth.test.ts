/**
 * Independent review of PR #2560 at 7a641d245 (delta 0361d624a..7a641d245).
 * Each section is a scenario the delta says cannot happen; each fails at that head.
 */
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, storeForEmail } from "@/lib/store";
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

  await section("J: a list passed over is pruned later by the sid and stats id only, so a member named by another id stays", async () => {
    later();
    const jo = await closing("jolist");
    const joStore = (await storeForEmail(jo))!;
    is("the store has a list id of its own", [typeof joStore.listId, joStore.listId !== joStore.statsId], ["string", true]);
    // A step of its sequence due for a contact, in the company's queue: named by its list id, with the contact's address.
    const member = `${joStore.listId}|${joStore.handle}|flowjo01|0|contact@example.com`;
    await real([["ZADD", "nl:mail:flowq", 4102444800, member]]);
    const odd = failing((c) => c[0] === "TYPE" && c[1] === "nl:mail:flowq", () => "not-a-kind", 1_000_000);
    await days(2);
    const erased = (await closingState(jo)).erased !== undefined;
    odd.times = odd.used;
    // The queue reads again; the pruning of what it owes runs once a gap.
    await days(3);
    const left = (await real([["ZSCORE", "nl:mail:flowq", member]]))[0];
    const owed = (await real([["HLEN", "nl:closed:prune"]]))[0];
    console.log(`  closing says erased ${erased}; its contact's step still in nl:mail:flowq after the queue reads again: ${left !== null}; rows owed left ${owed}`);
    is("never 'erased' while a contact's address of it stays in a company list for ever", erased && left !== null, false);
  });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
