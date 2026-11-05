/**
 * Independent review of PR #2560 at 0361d624a (delta 2c1c084a3..0361d624a).
 * Each section is a scenario the delta says cannot happen; each fails at that head.
 */
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, storeForEmail } from "@/lib/store";
import { finishClosed } from "@/lib/plan-closing";
import { WALK_GAP_MS, closedDataLine, closedDataNow, eraseClosed, markDue } from "@/lib/closed-store-data";

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

  await section("I: a company list passed over keeps a finished store's address for ever", async () => {
    later();
    const ida = await closing("idaunread");
    // Its pause's place in the company's list of breaks: named by its key, its owner's address.
    await real([["ZADD", "nl:pause:due", 4102444800, ida]]);
    const odd = failing((c) => c[0] === "TYPE" && c[1] === "nl:pause:due", () => "not-a-kind", 1_000_000);
    await days(2);
    const erased = (await closingState(ida)).erased !== undefined;
    odd.times = odd.used;
    // The list reads again: later walks run for other stores.
    await closing("idaother");
    await days(3);
    const member = (await real([["ZSCORE", "nl:pause:due", ida]]))[0];
    console.log(`  closing says erased ${erased}; its address still in nl:pause:due after the list reads again: ${member !== null}`);
    is("never 'erased' while its address stays in a company list for ever", erased && member !== null, false);
  });

  await section("H: a store whose record cannot be deleted is kept for ever, with a person's record, said only in a log", async () => {
    later();
    const hal = await closing("halstuck");
    const halStore = (await storeForEmail(hal))!;
    const leads = `nl:store:leads:${halStore.statsId}`;
    await real([["HSET", leads, "buyer@example.com", JSON.stringify({ e: "buyer@example.com", t: "tok2" })]]);
    failing((c) => c[0] === "DEL" && String(c[1]).startsWith("nl:store:owner:"), () => {
      throw new Error("Redis request timed out");
    }, 1_000_000);
    let last = { stuck: 0 } as { stuck?: number };
    for (let i = 0; i < 12; i += 1) {
      later();
      last = await quietly(() => run().catch(() => ({ stuck: -1 })));
      for (let j = 0; j < 5; j += 1) last = await quietly(() => run().catch(() => ({ stuck: -1 })));
    }
    const kept = (await real([["EXISTS", leads]]))[0];
    console.log(`  after 12 gaps: record ${(await storeForEmail(hal))?.handle ?? "gone"}, a buyer's address kept ${kept === 1}, said as stuck ${last.stuck}`);
    // Whether such a store is let go is the owner's policy, still open (third review, 2): until then it is kept, and
    // said in the owner's report line, not only in a log.
    const line = closedDataLine(await closedDataNow());
    is("a person's record of a closed store kept is said in the owner's report line, not only in a log", kept === 1 && (last.stuck ?? 0) > 0 ? line.includes("sem novas caminhadas") : true, true);
  });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
