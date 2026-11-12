/**
 * CX-123 rule 24 in lib/[m-r]*.ts (Claude 6 sweep): a Redis reply that is not
 * in its exact shape is unknown, never "nothing there". Synthetic data only.
 *
 * - tasksKept (lib/person-agenda-read.ts): an HLEN that is not a whole count
 *   made the agenda say "no tasks" instead of "could not be read".
 *
 * How readDepth (lib/page-depth.ts) reads its HGETALL is left to #2571.
 */
import { agendaData, tasksKept } from "@/lib/person-agenda-read";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Pipe = typeof redis.pipeline;

/** Answers `reply` as the whole pipeline reply for the one command whose first key is `key`. */
function answering(key: string, reply: unknown): () => void {
  const pipe = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][1] === key) return reply as unknown[];
    return pipe(commands);
  }) as Pipe;
  return () => { redis.pipeline = pipe as Pipe; };
}

async function thrown(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "answered";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  part("tasksKept reads HLEN exactly");
  const tasks = "nl:crm:tasks:s-agenda";
  is("a confirmed empty hash is 0", await tasksKept("s-agenda"), 0);
  for (const [name, reply] of [
    ["no reply at all", []],
    ["a reply that is not a number", ["ERR"]],
    ["a numeric string", ["3"]],
    ["a negative count", [-1]],
    ["a fraction", [1.5]],
    ["two replies for one command", [2, 2]],
    ["not a list", { 0: 2 }],
  ] as const) {
    const undo = answering(tasks, reply);
    is(`${name} is unknown, never 0`, await thrown(() => tasksKept("s-agenda")), "unknown");
    undo();
  }
  {
    const undo = answering(tasks, [2]);
    is("a whole count is read as it is", await tasksKept("s-agenda"), 2);
    undo();
  }

  const owner = "sweep-agenda@example.test";
  await claimHandle(owner, "sweepagenda", "Sweep Agenda Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_sweep_ag", subscriptionId: "sub_sweep_ag", active: true, tier: "creator", period: paidPeriod() });
  const shop = (await storeForEmail(owner))!;
  {
    const undo = answering(`nl:crm:tasks:${shop.statsId}`, ["not-a-count"]);
    is("the agenda says it could not be read, never that there are no tasks", (await agendaData(shop, "2026-11-06")).state, "failed");
    undo();
  }

  done();
}

void main();
