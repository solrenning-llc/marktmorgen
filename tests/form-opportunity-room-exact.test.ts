/**
 * A form answer turned into a deal takes the deal's room in the store's data
 * room before it is written (lib/form-opportunity.ts createFormOpportunity),
 * and gives it back only when the write answered, exactly, that the CRM is
 * full (CX-123 rule 24, audit R24 round 8, item 6). A write answered in
 * another shape may have landed, and a deal that already exists keeps its
 * room: a read before the write that fails refuses before the room is
 * touched (Codex Z on #3305), so the store's count is never made smaller
 * than what it keeps.
 */
import { createFormOpportunity } from "@/lib/form-opportunity";
import { DEFAULT_STAGES, MAX_DEALS, type Deal } from "@/lib/crm-rules";
import { readDeals } from "@/lib/crm";
import { dataUsed, type DataStore } from "@/lib/store-data";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const original: typeof redis.pipeline = redis.pipeline.bind(redis);
const isWrite = (command: (string | number)[]) => command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:form-opportunity:v1");
const isRead = (command: (string | number)[]) => command[0] === "HGET" && String(command[1]).startsWith("nl:crm:deals:");

let n = 0;
function fresh(): { statsId: string; ref: string; room: DataStore; draft: Deal } {
  n += 1;
  const ref = (n.toString(16).padStart(10, "0") + "ab".repeat(27)).slice(0, 64);
  const draft: Deal = { id: "", title: "Reviewed application", email: "lead@example.com", note: "Initial review", cents: 0, stage: "lead00", nextAction: "Review", dueDate: "2026-10-16", assignee: "owner@example.com", createdAt: 1800000000, updatedAt: 1800000000 } as Deal;
  return { statsId: `room-exact-${n}`, ref, room: { ...ROOM, sid: `room-exact-store-${n}` }, draft };
}
const used = async (room: DataStore) => (await dataUsed(room))?.used ?? -1;

async function create(statsId: string, ref: string, draft: Deal, room: DataStore): Promise<string> {
  try {
    return (await createFormOpportunity(statsId, ref, draft, DEFAULT_STAGES, room)).state;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw: ${(error as Error).message}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const quiet = console.error;

  part("Controls: created, existing and full keep their room as before");
  // What one such deal takes in the room, slot included: every deal below is the same size.
  let taken = -1;
  {
    const { statsId, ref, room, draft } = fresh();
    is("a new deal is created", await create(statsId, ref, draft, room), "created");
    taken = await used(room);
    is("its room is taken", taken > 0, true);
    is("asked again, it is the existing one", await create(statsId, ref, draft, room), "existing");
    is("and its room is unchanged", await used(room), taken);
    is("one deal kept", (await readDeals(statsId, DEFAULT_STAGES)).length, 1);
  }
  {
    const { statsId, ref, room, draft } = fresh();
    for (let i = 0; i < MAX_DEALS; i++) await original([["HSET", "nl:crm:deals:" + statsId, "fill" + i, "invalid"]]);
    is("a full CRM says full", await create(statsId, ref, draft, room), "full");
    is("and the room it took goes back", await used(room), 0);
  }

  part("A write answered in another shape keeps the room it took (it may have landed)");
  const shapes: [string, (record: string) => unknown][] = [
    ["code as text", (record) => [["1", record]]],
    ["code alone", () => [[1]]],
    ["a third slot", (record) => [[1, record, "x"]]],
    ["not a pair", () => [1]],
    ["two replies", (record) => [[1, record], [1, record]]],
    ["no reply", () => []],
    ["a plain OK", () => ["OK"]],
    ["the full code with a record", (record) => [[-1, record]]],
    ["code 2", (record) => [[2, record]]],
  ];
  for (const [label, shape] of shapes) {
    const { statsId, ref, room, draft } = fresh();
    redis.pipeline = (async (commands) => {
      const reply = await original(commands);
      if (commands.some(isWrite)) return shape(JSON.stringify({ ...draft, id: ref.slice(0, 10), formResponseRef: ref }));
      return reply;
    }) as typeof redis.pipeline;
    let state: string;
    try {
      state = await create(statsId, ref, draft, room);
    } finally {
      redis.pipeline = original;
    }
    is(`${label}: refused as unknown`, state, "unknown");
    is(`${label}: the deal landed, and its room is still counted`, [(await readDeals(statsId, DEFAULT_STAGES)).length, await used(room)], [1, taken]);
  }

  part("A read before the write that fails never zeroes the room of a deal that exists");
  {
    const { statsId, ref, room, draft } = fresh();
    is("the deal is created first", await create(statsId, ref, draft, room), "created");
    is("its room is taken", await used(room), taken);
    let failed = false;
    redis.pipeline = (async (commands) => {
      if (!failed && commands.some(isRead)) {
        failed = true;
        throw new Error("the database did not answer in time");
      }
      return original(commands);
    }) as typeof redis.pipeline;
    let state: string;
    try {
      state = await create(statsId, ref, draft, room);
    } finally {
      redis.pipeline = original;
    }
    is("the read failed, and it is refused before the room is touched", [failed, state], [true, "threw: the database did not answer in time"]);
    is("and its room is still counted", await used(room), taken);
  }
  {
    // Codex Z on #3305 (M2): the deal kept is larger than the draft sent again.
    const { statsId, ref, room, draft } = fresh();
    const larger = { ...draft, note: "x".repeat(500) } as Deal;
    is("a larger deal is created first", await create(statsId, ref, larger, room), "created");
    const before = await used(room);
    const id = ref.slice(0, 10);
    const [kept] = await original([["HGET", "nl:crm:deals:" + statsId, id]]);
    is("its room is more than a small draft's", before > taken, true);
    let failed = false;
    redis.pipeline = (async (commands) => {
      if (!failed && commands.some(isRead)) {
        failed = true;
        throw new Error("the database did not answer in time");
      }
      return original(commands);
    }) as typeof redis.pipeline;
    let state: string;
    try {
      state = await create(statsId, ref, { ...draft, note: "x" } as Deal, room);
    } finally {
      redis.pipeline = original;
    }
    const [still] = await original([["HGET", "nl:crm:deals:" + statsId, id]]);
    is("the read failed, and it is refused before the room is touched", [failed, state], [true, "threw: the database did not answer in time"]);
    is("the deal kept is unchanged", still, kept);
    is("and the larger deal's whole room is still counted", await used(room), before);
  }
  console.error = quiet;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
