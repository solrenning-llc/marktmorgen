/**
 * #4267 (Codex L, hidden #4083): an attempt claimed before a person's erasure settles after it (lib/flows.ts settles every
 * in-flight step with settleAttempts) and recreates the erased run record, its history and its index entry, holding
 * the plain address; the "uncertain" outcome does it without any EXPIRE. Synthetic only (in-memory Redis stand-in).
 */
import { forgetWorkflowPerson } from "@/lib/flows";
import { claimAttempts, openRuns, personOf, settleAttempts } from "@/lib/flow-runs";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const listId = "zz4083-list";
const store = { listId, statsId: null, mail: { fromName: "Sample", address: "Sample address" }, subscriptionActive: true, tier: "pro", trialEnds: 0, name: "Sample", handle: "sample", catalog: { items: [] } } as unknown as Store;
const flow = { id: "5555555555555555", name: "Welcome", trigger: "joined", productId: null, active: true, createdAt: 1, steps: [{ id: "cccccccccccccccc", delayHours: 0, subject: "Hello", body: "Sample" }] };
const email = "erased-learner@example.com";
const person = personOf(email);
const runKey = `nl:wf:run:${flow.id}:${person}`;
const logKey = `nl:wf:log:${flow.id}:${person}`;
const indexKey = `nl:wf:runs:${flow.id}`;

async function main(): Promise<void> {
  for (const state of ["uncertain", "confirmed"] as const) {
    part(`an in-flight step settles as ${state} after the person's erasure`);
    redis.clear();
    await redis.pipeline([["SET", `nl:mail:flows:${listId}`, JSON.stringify([flow])]]);
    await openRuns(flow.id, [email]);
    const claimed = await claimAttempts(flow.id, [email], 0, flow.steps[0].id, "email");
    is("the step's attempt was claimed before the erasure", claimed.claimed, [email]);
    // The person's erasure completes while the provider call is in flight.
    await forgetWorkflowPerson(store, email);
    is("(control) the erasure removed the run", redis.run(["EXISTS", runKey]), 0);
    // The provider answers; lib/flows.ts writes the outcome.
    await settleAttempts(listId, flow.id, 0, flow.steps[0].id, "email", [{ email, state, note: "Sent.", to: -1 }]);
    is("after completed erasure, no run record holds the address", redis.run(["HGET", runKey, "email"]), null);
    is("after completed erasure, no run history exists", redis.run(["EXISTS", logKey]), 0);
    is("after completed erasure, the person is not in the run index", redis.run(["ZSCORE", indexKey, person]), null);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
