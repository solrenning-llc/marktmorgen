/**
 * A sequence's counts in the MCP get_emails tool, read exactly (CX-123 rule
 * 24: unknown is never zero). What is checked, with real sequences saved by
 * saveFlow and the real emailsTool:
 *
 *   - get_emails reads the tallies with the studio's own strict reader
 *     (readFlowStatsStrict, lib/flow-stats.ts), so one rule says what a tally
 *     reply may be (Claude 4 on #3176): an even list, each field once, whole
 *     numbers from zero up; a reading that throws, a reply of another shape (a
 *     number, a string, an odd list, a value that is not a whole number) or a
 *     pipeline that answers fewer replies throws, never a zero. A whole number
 *     given as a number and a field it does not count are read as that rule
 *     reads them;
 *   - get_emails then says each sequence's started, emails_sent and
 *     reached_the_end as null with counts_unavailable true, never 0;
 *   - a sequence nobody has started yet (no hash: an empty list) is a real 0,
 *     and real tallies come out as they are, with counts_unavailable false.
 */
import { emailsTool } from "@/lib/mcp-tools";
import { enroll, readFlows, saveFlow } from "@/lib/flows";
import { readFlowStatsStrict } from "@/lib/flow-stats";
import { upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

const OWNER = "tallies@example.com";
const isStats = (command: (string | number)[]) => command[0] === "HGETALL" && String(command[1]).startsWith("nl:mail:flowstats:");

// Changes the answer of the pipeline that reads the sequences' tallies, and only that one.
const realPipeline = redis.pipeline;
let twist: ((replies: unknown[]) => unknown) | null = null;
redis.pipeline = async (commands: (string | number)[][]) => {
  const replies = await realPipeline(commands);
  return twist && commands.length && commands.every(isStats) ? (twist(replies) as unknown[]) : replies;
};

const meter = { charge: async () => null, hold: async () => async () => null };
type Sequence = { name: string; started: number | null; emails_sent: number | null; reached_the_end: number | null; counts_unavailable?: boolean };

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "tallies", "Tallies Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Tallies0001", subscriptionId: "sub_Tallies0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Tallies Kitchen", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const welcome = await saveFlow(store, { name: "Welcome", trigger: "joined", active: true, steps: [{ delayHours: 0, subject: "Welcome", body: "Hello." }] }, { activate: true });
  const quiet = await saveFlow(store, { name: "Quiet", trigger: "joined", active: false, steps: [{ delayHours: 0, subject: "Later", body: "Hi." }] });
  if (!welcome.ok || !quiet.ok) throw new Error("the sequences were not saved");
  store = (await storeForEmail(OWNER))!;
  const flows = await readFlows(list);
  const [welcomeId, quietId] = [flows[0].id, flows[1].id];
  await upsertContact(list, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "ana@example.com", { joined: true });
  await redisPipeline([["HINCRBY", `nl:mail:flowstats:${welcomeId}`, "sent", 4], ["HINCRBY", `nl:mail:flowstats:${welcomeId}`, "reached", 2]]);

  const sequences = async () => {
    const answer = (await emailsTool(store, meter)) as { sequences?: Sequence[] };
    return (answer.sequences ?? []).map((s) => [s.name, s.started, s.emails_sent, s.reached_the_end, s.counts_unavailable]);
  };
  const throws = async () => {
    try {
      await readFlowStatsStrict(flows);
      return "read";
    } catch (error) {
      return error instanceof Error && error.message === "connection reset" ? error.message : "unknown";
    }
  };

  part("Control: real tallies, and a sequence nobody started yet");
  twist = null;
  const read = await readFlowStatsStrict(flows);
  is("real tallies as they are", [read.get(welcomeId)?.started, read.get(welcomeId)?.sent, read.get(welcomeId)?.reached], [1, 4, 2]);
  is("no hash at all (an empty list) is a real zero", [read.get(quietId)?.started, read.get(quietId)?.sent, read.get(quietId)?.reached], [0, 0, 0]);
  is("get_emails shows them, counts_unavailable false", await sequences(), [["Welcome", 1, 4, 2, false], ["Quiet", 0, 0, 0, false]]);

  part("The reading failed");
  twist = () => {
    throw new Error("connection reset");
  };
  is("the reader does not answer zeros", await throws(), "connection reset");
  const unknown = [["Welcome", null, null, null, true], ["Quiet", null, null, null, true]];
  is("get_emails says null and counts_unavailable, never 0", await sequences(), unknown);

  part("A reply of another shape is unknown");
  const shapes: [string, unknown][] = [
    ["a number", 5],
    ["a string", "started"],
    ["null", null],
    ["an odd list", ["started", "1", "sent"]],
    ["a value that is not a number", ["started", "many"]],
    ["an empty value", ["started", ""]],
    ["a negative value", ["started", "-1"]],
    ["a fraction", ["started", "1.5"]],
    ["a number past the safe range", ["started", "9007199254740993"]],
    ["a field that is not a string", [7, "1"]],
    ["a field twice", ["started", "1", "started", "2"]],
  ];
  for (const [what, reply] of shapes) {
    twist = (replies) => [reply, ...replies.slice(1)];
    is(`${what}: the reader throws`, await throws(), "unknown");
    is(`${what}: get_emails says null`, await sequences(), unknown);
  }

  part("The pipeline answered fewer replies");
  twist = (replies) => replies.slice(0, 1);
  is("the reader throws", await throws(), "unknown");
  is("get_emails says null", await sequences(), unknown);
  twist = () => ({ 0: [], 1: [] });
  is("a reply list that is not a list is unknown", await throws(), "unknown");

  part("One rule with the studio's Email page (Claude 4 on #3176)");
  twist = (replies) => [["started", 3], ...replies.slice(1)];
  is("a whole number given as a number is read as it is", await sequences(), [["Welcome", 3, 0, 0, false], ["Quiet", 0, 0, 0, false]]);
  twist = (replies) => [["started", "1", "extra", "x"], ...replies.slice(1)];
  is("a field the tallies do not count is left out, as the studio reads it", await sequences(), [["Welcome", 1, 0, 0, false], ["Quiet", 0, 0, 0, false]]);

  part("Back to normal");
  twist = null;
  is("real tallies again", await sequences(), [["Welcome", 1, 4, 2, false], ["Quiet", 0, 0, 0, false]]);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
