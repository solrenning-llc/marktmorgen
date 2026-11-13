import { FlowWriteUnconfirmed, forgetWorkflowPerson, readFlows, removeFlow } from "@/lib/flows";
import { FlowRunUnavailable, openRuns, personOf } from "@/lib/flow-runs";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// Removing a workflow erases its runs (purgeFlow). When that erasure cannot be confirmed, the workflow must stay
// listed, so a later removal, a person's erasure request (forgetWorkflowPerson) or the store's deletion
// (forgetStoreWorkflows) still reaches its runs; it is never dropped from the list with the people's addresses left
// behind in runs that nothing can find again for 400 days (CX-123 rule 24, a person's data kept after erasure).
const listId = "remove-erasure-list";
const key = "nl:mail:flows:" + listId;
const store = { listId, statsId: null, mail: { fromName: "Sample", address: "Sample address" }, subscriptionActive: true, tier: "pro", trialEnds: 0, name: "Sample", handle: "sample", catalog: { items: [] } } as unknown as Store;
const flow = { id: "3333333333333333", name: "Welcome", trigger: "joined", productId: null, active: true, createdAt: 1, steps: [{ id: "bbbbbbbbbbbbbbbb", delayHours: 0, subject: "Hello", body: "Sample" }] };
const other = { ...flow, id: "4444444444444444", name: "Other", active: false };
const email = "person@example.com";
const runKey = `nl:wf:run:${flow.id}:${personOf(email)}`;
const indexKey = `nl:wf:runs:${flow.id}`;
const queued = `${listId}|sample|${flow.id}|0|${email}`;

async function seed(): Promise<void> {
  await redis.pipeline([["DEL", key, runKey, indexKey, `nl:wf:log:${flow.id}:${personOf(email)}`], ["ZREM", "nl:mail:flowq", queued]]);
  await redis.pipeline([["SET", key, JSON.stringify([flow, other])]]);
  await openRuns(flow.id, [email]);
  await redis.pipeline([["ZADD", "nl:mail:flowq", 1, queued]]);
}

async function main() {
  part("Removing a workflow whose runs cannot be erased");
  const original = redis.pipeline;
  for (const failure of ["throws", "garbled index", "garbled erase"] as const) {
    await seed();
    is(`${failure}: the run holds the address before`, (await original.call(redis, [["HGET", runKey, "email"]]))[0], email);
    redis.pipeline = async (commands) => {
      if (failure === "throws" && commands.some((c) => c[0] === "ZREVRANGE" && c[1] === indexKey)) throw new Error("storage unavailable");
      if (failure === "garbled index" && commands.some((c) => c[0] === "ZREVRANGE" && c[1] === indexKey)) return [{ unexpected: true }];
      if (failure === "garbled erase" && commands.some((c) => c[0] === "DEL" && c[1] === runKey)) return [];
      return original.call(redis, commands);
    };
    let error: unknown = null;
    try {
      await removeFlow(store, flow.id);
    } catch (caught) {
      error = caught;
    } finally {
      redis.pipeline = original;
    }
    is(`${failure}: the removal says it could not be confirmed`, error instanceof FlowRunUnavailable || error instanceof FlowWriteUnconfirmed, true);
    const listed = (await readFlows(listId)).find((f) => f.id === flow.id);
    is(`${failure}: the workflow stays listed, so its runs can still be reached`, Boolean(listed), true);
    is(`${failure}: and it is paused, so nobody new starts it and nothing more is sent`, listed?.active, false);
    is(`${failure}: the other workflow is left as it was`, (await readFlows(listId)).find((f) => f.id === other.id), other);
    // The person asks to be erased afterwards: their run of the workflow is found and erased.
    await forgetWorkflowPerson(store, email);
    is(`${failure}: a later erasure request erases the run's address`, (await original.call(redis, [["HGET", runKey, "email"]]))[0], null);
    is(`${failure}: and its queued step`, (await original.call(redis, [["ZSCORE", "nl:mail:flowq", queued]]))[0], null);
    // Tried again with the store answering: removed, and nothing of the people in it is kept.
    await openRuns(flow.id, [email]);
    const again = await removeFlow(store, flow.id);
    is(`${failure}: removing it again succeeds`, again.ok, true);
    is(`${failure}: the workflow is gone`, (await readFlows(listId)).some((f) => f.id === flow.id), false);
    is(`${failure}: its run is erased`, (await original.call(redis, [["EXISTS", runKey]]))[0], 0);
    is(`${failure}: its index is erased`, (await original.call(redis, [["EXISTS", indexKey]]))[0], 0);
  }

  part("Removing a workflow when everything answers");
  await seed();
  const removed = await removeFlow(store, flow.id);
  is("removal succeeds", removed.ok, true);
  is("only the other workflow is left", (await readFlows(listId)).map((f) => f.id), [other.id]);
  is("the run is erased", (await redis.pipeline([["EXISTS", runKey]]))[0], 0);
  is("the queued step is erased", (await redis.pipeline([["ZSCORE", "nl:mail:flowq", queued]]))[0], null);
  done();
}
void main();
