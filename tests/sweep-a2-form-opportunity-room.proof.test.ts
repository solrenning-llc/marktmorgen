/**
 * Sweep A2 proof (CX-123 rules 24/30), synthetic only. lib/form-opportunity.ts createFormOpportunity:
 *   line 30: `readFormOpportunity(...).catch(() => null)` turns an unknown read into "no deal yet";
 *   line 33-34: an EVAL reply that is not the exact `[[1, ...]]` is taken as "not made".
 * Either way `giveData(room, [{ slot, bytes: 0, set: true }])` sets the deal's data-room slot to 0 while the deal
 * exists in Redis: the room no longer counts a record that is kept (a limit released on an unknown reply).
 */
import { createFormOpportunity, readFormOpportunity } from "@/lib/form-opportunity";
import { DEFAULT_STAGES } from "@/lib/crm-rules";
import { dealSlot } from "@/lib/crm";
import { dataKey } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const STATS = "sweepa2forms";
const room = dataKey(ROOM)!;
const draft = { id: "", title: "Application", email: "lead@example.com", note: "", cents: 0, stage: "lead00", nextAction: "", dueDate: "", assignee: "" } as never;
const slotOf = async (id: string) => (await redis.pipeline([["HGET", room, dealSlot(id)]]))[0];
const original = redis.pipeline.bind(redis);

async function main() {
  redis.clear();
  part("Healthy control: a second conversion of the same response leaves the existing deal's room as it was");
  const refA = "a".repeat(64);
  const first = await createFormOpportunity(STATS, refA, draft, DEFAULT_STAGES, ROOM);
  const idA = refA.slice(0, 10);
  const counted = await slotOf(idA);
  is("created, and its room counted", [first.state, typeof counted === "string" && Number(counted) > 0], ["created", true]);
  const again = await createFormOpportunity(STATS, refA, draft, DEFAULT_STAGES, ROOM);
  is("existing, room slot unchanged", [again.state, await slotOf(idA)], ["existing", counted]);

  part("DEFECT 1: the first read answers in an unknown shape (line 30 .catch(() => null) / wrong shape)");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "HGET" && String(commands[0][1]).startsWith("nl:crm:deals:")) return [];
    return original(commands);
  }) as typeof redis.pipeline;
  const unknownRead = await createFormOpportunity(STATS, refA, draft, DEFAULT_STAGES, ROOM);
  redis.pipeline = original;
  const after = await slotOf(idA);
  is("DEFECT: still answered 'existing' (the deal is kept)", unknownRead.state, "existing");
  is("DEFECT: the kept deal's data-room slot was zeroed (released) on an unknown read", [counted, after === null || Number(after) === 0], [counted, true]);
  is("the deal itself is still in Redis", (await readFormOpportunity(STATS, refA, DEFAULT_STAGES))?.id, idA);

  part("DEFECT 2: the create EVAL ran but its reply was lost (line 33-34 `made` false)");
  const refB = "b".repeat(64);
  const idB = refB.slice(0, 10);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const result = await original(commands);
    if (commands[0]?.[0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:form-opportunity:v1")) return [];
    return result;
  }) as typeof redis.pipeline;
  let threw = "";
  try { await createFormOpportunity(STATS, refB, draft, DEFAULT_STAGES, ROOM); } catch (error) { threw = (error as Error).message; }
  redis.pipeline = original;
  const retry = await createFormOpportunity(STATS, refB, draft, DEFAULT_STAGES, ROOM);
  const slotB = await slotOf(idB);
  is("first attempt unconfirmed, retry finds the deal", [threw, retry.state], ["Form opportunity write unconfirmed", "existing"]);
  is("DEFECT: the written deal is not counted in the room after the retry", slotB === null || Number(slotB) === 0, true);
  done();
}
main();
