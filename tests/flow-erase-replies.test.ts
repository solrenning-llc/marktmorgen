import { FlowWriteUnconfirmed, forgetStoreWorkflows, forgetWorkflowPerson, readFlows, removeFlow } from "@/lib/flows";
import { openRuns, personOf } from "@/lib/flow-runs";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// A workflow's erasure is confirmed reply by reply (Codex M on #3083, proof tests/m-3083-erasure-reply.proof.ts in
// docs/codex-m-checkpoint-2026-11-06.md): erase() checked only that the pipeline answered a list of the right length,
// so a list of nulls (nothing dispatched) passed as an erasure, removeFlow took the workflow off the list and the
// people's addresses stayed in runs nothing can find again. Every DEL and ZREM answers a count, a whole number from
// zero up (countOf); anything else throws FlowWriteUnconfirmed, so the workflow stays listed and paused (CX-123 rule
// 24). Rule 30: a person's erasure and the store's deletion go through the same erase().
const listId = "m-remove-proof-list";
const listKey = "nl:mail:flows:" + listId;
const store = { listId, statsId: null, mail: { fromName: "Sample", address: "Sample address" }, subscriptionActive: true, tier: "pro", trialEnds: 0, name: "Sample", handle: "sample", catalog: { items: [] } } as unknown as Store;
const flow = { id: "5555555555555555", name: "Welcome", trigger: "joined", productId: null, active: true, createdAt: 1, steps: [{ id: "cccccccccccccccc", delayHours: 0, subject: "Hello", body: "Sample" }] };
const email = "person@example.com";
const runKey = `nl:wf:run:${flow.id}:${personOf(email)}`;
const original = redis.pipeline;

async function seed(): Promise<void> {
  redis.clear();
  await original.call(redis, [["SET", listKey, JSON.stringify([flow])]]);
  await openRuns(flow.id, [email]);
}

/** Answers the erase pipeline (the one that DELs the real run) with `answer`, dispatching nothing; counts it. */
function eraseAnswers(answer: (commands: (string | number)[][]) => unknown): { count: number } {
  const seen = { count: 0 };
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "DEL" && c[1] === runKey)) {
      seen.count += 1;
      return answer(commands);
    }
    return original.call(redis, commands);
  }) as typeof redis.pipeline;
  return seen;
}

async function attempt(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  } finally {
    redis.pipeline = original;
  }
}

const answers: [string, (commands: (string | number)[][]) => unknown][] = [
  ["nulls of the right length (Codex M's case)", (commands) => commands.map(() => null)],
  ["text counts", (commands) => commands.map(() => "1")],
  ["negative counts", (commands) => commands.map(() => -1)],
  ["fractions", (commands) => commands.map(() => 0.5)],
  ["one null among counts", (commands) => commands.map((_, i) => (i === 0 ? null : 1))],
];

async function main() {
  part("Removing a workflow: right-length replies that are not counts do not confirm the erasure");
  for (const [label, answer] of answers) {
    await seed();
    const seen = eraseAnswers(answer);
    const error = await attempt(() => removeFlow(store, flow.id));
    is(`${label}: the erase was intercepted once`, seen.count, 1);
    is(`${label}: removal throws FlowWriteUnconfirmed`, error instanceof FlowWriteUnconfirmed, true);
    const listed = (await readFlows(listId)).find((f) => f.id === flow.id);
    is(`${label}: the workflow stays listed`, Boolean(listed), true);
    is(`${label}: and paused`, listed?.active, false);
    await forgetWorkflowPerson(store, email);
    is(`${label}: a later person erasure still removes the run's address`, (await original.call(redis, [["HGET", runKey, "email"]]))[0], null);
  }

  part("Rule 30: a person's erasure and the store's deletion read the same replies");
  for (const [label, answer] of answers) {
    await seed();
    eraseAnswers(answer);
    is(`${label}: forgetWorkflowPerson throws FlowWriteUnconfirmed`, (await attempt(() => forgetWorkflowPerson(store, email))) instanceof FlowWriteUnconfirmed, true);
    await seed();
    eraseAnswers(answer);
    is(`${label}: forgetStoreWorkflows throws FlowWriteUnconfirmed`, (await attempt(() => forgetStoreWorkflows(store))) instanceof FlowWriteUnconfirmed, true);
  }

  part("Healthy controls");
  await seed();
  is("normal removal still succeeds", (await removeFlow(store, flow.id)).ok, true);
  is("normal removal removes the workflow", (await readFlows(listId)).length, 0);
  is("normal removal erases its run", (await original.call(redis, [["EXISTS", runKey]]))[0], 0);
  await seed();
  is("normal person erasure", (await forgetWorkflowPerson(store, email)).flows, 1);
  is("normal person erasure removes the run's address", (await original.call(redis, [["HGET", runKey, "email"]]))[0], null);
  await seed();
  await forgetStoreWorkflows(store);
  is("normal store deletion removes the workflows", (await original.call(redis, [["EXISTS", listKey]]))[0], 0);
  is("normal store deletion erases the run", (await original.call(redis, [["EXISTS", runKey]]))[0], 0);
  done();
}

void main();
