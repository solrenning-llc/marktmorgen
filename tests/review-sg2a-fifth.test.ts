/**
 * Independent review of PR #2560 at fe13f03f2 (delta 7a641d245..fe13f03f2).
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

  await section("K: its owner opens a store again under the same key; the closed store's folder is the new store's, and the walk deletes by it", async () => {
    later();
    const kay = await closing("kayold");
    const folder = await storeFolder(kay);
    const orders = `nl:orders:n:${folder}:2026-11`;
    // Its record is gone (its first step ran); as its walk begins, its owner opens a store again under the same key (EC1)
    // and takes an order: the new store's count of orders this month, named by its folder (the key's hash, the same).
    failing((c) => c[0] === "HSET" && c[1] === "nl:closed:walk" && c.includes("phase") && c.includes("walk"), async (c) => {
      await claimHandle(kay, "kaynew", "kay new studio", "");
      await real([["SET", orders, "5"]]);
      return (await real([c]))[0];
    });
    await days(1);
    const now = await storeForEmail(kay);
    const count = (await real([["GET", orders]]))[0];
    console.log(`  store under the key ${now?.handle ?? "none"}, its folder ${now ? (await storeFolder(kay)) === folder : "-"}, its orders this month ${count ?? "deleted"}`);
    is("the new store's records named by its folder are untouched by the closed store's walk", [now?.handle, count], ["kaynew", "5"]);
  });

  await section("L: the list's rows are written and its 'unread' mark is not: what is owed is kept for ever, never pruned nor counted", async () => {
    later();
    const lou = await closing("louprune");
    await real([["ZADD", "nl:pause:due", 4102444800, "someone-else@example.com"]]);
    const odd = failing((c) => c[0] === "TYPE" && c[1] === "nl:pause:due", () => "not-a-kind", 1_000_000);
    // The second command of the pipeline that keeps what is owed: the walk's "unread:<list>" mark, timing out.
    // By the run that reads the page again, the list reads (a list that failed for a while and then answers).
    failing((c) => c[0] === "HSET" && c[1] === "nl:closed:walk" && String(c[2]).startsWith("unread:"), () => {
      odd.times = odd.used;
      throw new Error("Redis request timed out");
    });
    await days(2);
    odd.times = odd.used;
    await days(4);
    const owed = (await real([["HGETALL", "nl:closed:prune"]]))[0] as string[];
    const unread = ((await real([["HGETALL", "nl:closed:walk"]]))[0] as string[]).filter((f, i) => i % 2 === 0 && f.startsWith("unread:"));
    console.log(`  closing says erased ${(await closingState(lou)).erased !== undefined}; nl:closed:prune fields left: ${owed.filter((_, i) => i % 2 === 0).join(", ") || "none"}; unread marks: ${unread.length}`);
    is("nothing is left owed in nl:closed:prune with no list mark to prune or count it", owed.length === 0 || unread.length > 0, true);
  });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
