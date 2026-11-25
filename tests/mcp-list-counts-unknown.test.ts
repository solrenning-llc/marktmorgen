/**
 * Issue #4079 (Codex C2): the MCP get_emails tool read the list's counts through listCounts (lib/contacts.ts), which
 * turned any reply it could not read (a lost reply, a reply of another shape, a pipeline answering fewer replies)
 * into 0 with `Number(reply) || 0`, so a store with people on its list was told `people: 0, can_be_emailed: 0`, as if
 * the list were empty. Now get_emails reads them exactly (listCountsExact, CX-123 rule 24): HLEN a whole number from
 * zero up, each counter nil (none yet) or the text of a whole number; anything else says the counts as null, with
 * counts_unavailable true, never 0, as a sequence's counts already are.
 *
 * Synthetic store, list and Redis only.
 */
import { emailsTool } from "@/lib/mcp-tools";
import { upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

const OWNER = "list-counts@example.com";
// The pipeline that reads the list's counts: an HLEN of the list and the GETs of its two counters.
const isCounts = (commands: (string | number)[][]) => commands.length === 3 && commands[0][0] === "HLEN" && commands[1][0] === "GET" && commands[2][0] === "GET";

const realPipeline = redis.pipeline;
let twist: ((replies: unknown[]) => unknown) | null = null;
redis.pipeline = async (commands: (string | number)[][]) => {
  if (twist && isCounts(commands)) {
    const replies = await realPipeline(commands);
    return twist(replies) as unknown[];
  }
  return realPipeline(commands);
};

const meter = { charge: async () => null, hold: async () => async () => null };
type ListAnswer = { people: number | null; agreed_to_hear: number | null; left: number | null; can_be_emailed: number | null; counts_unavailable?: boolean };

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "listcounts", "List Counts", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ListCounts01", subscriptionId: "sub_ListCounts01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "List Counts", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  await upsertContact(list, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await upsertContact(list, "ben@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);

  const listOf = async () => ((await emailsTool(store, meter)) as { list?: ListAnswer }).list;

  part("Control: the counts as they are");
  twist = null;
  is("two people, both can be emailed", await listOf(), { people: 2, agreed_to_hear: 2, left: 0, can_be_emailed: 2, counts_unavailable: false });

  part("A reply that cannot be read: null with counts_unavailable, never 0");
  for (const [label, change] of [
    ["HLEN lost (null)", (r: unknown[]) => [null, r[1], r[2]]],
    ["HLEN as text", (r: unknown[]) => ["2", r[1], r[2]]],
    ["the agreed counter not a number", (r: unknown[]) => [r[0], "many", r[2]]],
    ["the agreed counter as a list", (r: unknown[]) => [r[0], ["2"], r[2]]],
    ["the left counter a fraction", (r: unknown[]) => [r[0], r[1], "0.5"]],
    ["one reply missing", (r: unknown[]) => [r[0], r[1]]],
  ] as [string, (r: unknown[]) => unknown][]) {
    twist = change;
    is(`${label}: unavailable`, await listOf(), { people: null, agreed_to_hear: null, left: null, can_be_emailed: null, counts_unavailable: true });
  }
  twist = () => {
    throw new Error("connection reset");
  };
  is("a pipeline that throws: unavailable", await listOf(), { people: null, agreed_to_hear: null, left: null, can_be_emailed: null, counts_unavailable: true });

  part("What the counters may really hold reads as before");
  twist = (r) => [r[0], null, null];
  is("counters never written (nil): 0 agreed, 0 left, readable", await listOf(), { people: 2, agreed_to_hear: 0, left: 0, can_be_emailed: 0, counts_unavailable: false });
  twist = (r) => [r[0], r[1], "-1"];
  is("a left counter a DECR took below 0 is read as 0 left", await listOf(), { people: 2, agreed_to_hear: 2, left: 0, can_be_emailed: 2, counts_unavailable: false });
  twist = null;

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
