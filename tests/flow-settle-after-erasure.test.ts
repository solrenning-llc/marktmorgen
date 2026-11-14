/**
 * #4267 (Codex L #4083): an attempt claimed before a person's erasure settles after it (lib/flows.ts settles every
 * in-flight step with settleAttempts). The settle must write only over the run that still holds the attempt it
 * claimed: an erased run is not recreated with the plain address, its history or its index and held entries, for
 * any outcome. A settle over a live run keeps working, and an uncertain settle never leaves a key without expiry.
 * Synthetic only (in-memory Redis stand-in).
 */
import { forgetWorkflowPerson } from "@/lib/flows";
import { claimAttempts, openRuns, personOf, settleAttempts } from "@/lib/flow-runs";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const listId = "zz4267-list";
const store = { listId, statsId: null, mail: { fromName: "Sample", address: "Sample address" }, subscriptionActive: true, tier: "pro", trialEnds: 0, name: "Sample", handle: "sample", catalog: { items: [] } } as unknown as Store;
const flow = { id: "5555555555555555", name: "Welcome", trigger: "joined", productId: null, active: true, createdAt: 1, steps: [{ id: "cccccccccccccccc", delayHours: 0, subject: "Hello", body: "Sample" }] };
const email = "erased-learner@example.com";
const person = personOf(email);
const runKey = `nl:wf:run:${flow.id}:${person}`;
const logKey = `nl:wf:log:${flow.id}:${person}`;
const indexKey = `nl:wf:runs:${flow.id}`;
const heldKey = `nl:wf:held:${listId}`;
const states = ["uncertain", "confirmed", "failed", "deferred"] as const;

async function start(): Promise<void> {
  redis.clear();
  await redis.pipeline([["SET", `nl:mail:flows:${listId}`, JSON.stringify([flow])]]);
  await openRuns(flow.id, [email]);
  const claimed = await claimAttempts(flow.id, [email], 0, flow.steps[0].id, "email");
  is("the step's attempt was claimed", claimed.claimed, [email]);
}

async function main(): Promise<void> {
  for (const state of states) {
    part(`an in-flight step settles as ${state} after the person's erasure`);
    await start();
    await forgetWorkflowPerson(store, email);
    is("(control) the erasure removed the run", redis.run(["EXISTS", runKey]), 0);
    await settleAttempts(listId, flow.id, 0, flow.steps[0].id, "email", [{ email, state, note: "Sent.", to: -1 }]);
    is("no run record exists again", redis.run(["EXISTS", runKey]), 0);
    is("no run history exists again", redis.run(["EXISTS", logKey]), 0);
    is("the person is not back in the run index", redis.run(["ZSCORE", indexKey, person]), null);
    is("the run is not on the held list", redis.run(["ZSCORE", heldKey, `${flow.id}|${person}`]), null);
  }

  part("a step settled over a run that no longer holds the claimed attempt writes nothing");
  await start();
  await redis.pipeline([["HDEL", runKey, "open"]]);
  await settleAttempts(listId, flow.id, 0, flow.steps[0].id, "email", [{ email, state: "confirmed", note: "Sent.", to: -1 }]);
  is("the run's status is not overwritten", redis.run(["HGET", runKey, "status"]), "running");

  for (const state of states) {
    part(`(control) a live run settles as ${state}`);
    await start();
    await settleAttempts(listId, flow.id, 0, flow.steps[0].id, "email", [{ email, state, note: "Sent.", to: -1 }]);
    is("the run keeps the address", redis.run(["HGET", runKey, "email"]), email);
    is("the run's status", redis.run(["HGET", runKey, "status"]), state === "uncertain" ? "held" : state === "deferred" ? "waiting" : state === "failed" ? "failed" : "done");
    is("the attempt stays open only when uncertain", redis.run(["HEXISTS", runKey, "open"]), state === "uncertain" ? 1 : 0);
    is("the person stays in the run index", redis.run(["ZSCORE", indexKey, person]) !== null, true);
    is("held only when uncertain", redis.run(["ZSCORE", heldKey, `${flow.id}|${person}`]) !== null, state === "uncertain");
    is("the run record keeps an expiry", Number(redis.run(["TTL", runKey])) > 0, true);
    is("the run history keeps an expiry", Number(redis.run(["TTL", logKey])) > 0, true);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
