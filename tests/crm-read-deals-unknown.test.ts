/**
 * Claude 3 (cloud A), CX-123 rule 24: the store's deals (HVALS) are "none"
 * only when Redis answered an empty list. A reply in another shape (not a
 * list, a list with something that is not a string, no reply, one too many)
 * is unknown, never a board with no deals: otherwise a workflow's deal step,
 * finding no open deal for the person, makes a second one beside the deal
 * they already have.
 *
 * Nothing real: the Redis stub, a stand-in email provider, synthetic stores.
 */
import { CrmDealReadUnavailable, readDeals, readStages, writeDeal } from "@/lib/crm";
import { upsertContact } from "@/lib/contacts";
import { enroll, saveFlow, sendDueSteps } from "@/lib/flows";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});

const OWNER = "deals-unknown@example.com";
const OPEN = "stgqa1";
const WON = "stgwn1";
const LOST = "stglo1";
const PIPES = [{ id: "sales0", name: "Coaching", stages: [{ id: OPEN, name: "Qualified", kind: "open" }, { id: WON, name: "Signed", kind: "won" }, { id: LOST, name: "Gone", kind: "lost" }] }];

/** The HVALS of the deals key answered by `reply` while set; everything else answers truthfully. */
let hvals: ((values: unknown) => unknown) | null = null;
let dealsKey = "";
const original = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const answers = await original(commands);
  return hvals ? answers.map((answer, i) => (commands[i][0] === "HVALS" && commands[i][1] === dealsKey ? hvals!(answer) : answer)) : answers;
}) as typeof redis.pipeline;

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    return `returned ${JSON.stringify(await run()).slice(0, 80)}`;
  } catch (error) {
    return error instanceof CrmDealReadUnavailable ? "CrmDealReadUnavailable" : (error as Error).name;
  }
}

const CROOKED: [string, (values: unknown) => unknown][] = [
  ["null", () => null],
  ["a string", () => "OK"],
  ["a number", () => 3],
  ["a list with a number in it", (values) => [...(values as unknown[]), 7]],
  ["a list with an object in it", (values) => [...(values as unknown[]), { id: "x" }]],
];

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_deals_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_deals_only_a_stand_in";
  await claimHandle(OWNER, "dealsunknown", "Deals Unknown", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_DealsUnknown01", subscriptionId: "sub_DealsUnknown01", active: true, tier: "scale", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Deals Unknown", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const sid = store.statsId!;
  const list = store.listId!;
  dealsKey = `nl:crm:deals:${sid}`;
  await original([["SET", `nl:crm:pipes:${sid}`, JSON.stringify(PIPES)]]);
  const stages = await readStages(sid);
  const anaDeals = async () => (await readDeals(sid, stages)).filter((d) => d.email === "ana@example.com").map((d) => [d.id, d.stage]);

  part("The read: an empty board only for an empty list");
  is("control: no deals yet", await readDeals(sid, stages), []);
  await writeDeal(sid, { id: "anadeal001", title: "Ana's", email: "ana@example.com", cents: 0, stage: OPEN, note: "", createdAt: 1, updatedAt: 1 }, ROOM);
  is("control: Ana's open deal reads", await anaDeals(), [["anadeal001", OPEN]]);
  for (const [what, reply] of CROOKED) {
    hvals = reply;
    is(`HVALS answered ${what}: unknown, never no deals`, await outcome(() => readDeals(sid, stages)), "CrmDealReadUnavailable");
    hvals = null;
  }

  part("A workflow's deal step never makes a second deal on an unknown board");
  const joined = await saveFlow(store, { name: "Joined: deal", trigger: "joined", active: true, steps: [{ delayHours: 0, subject: "", body: "", action: { do: "deal", stage: WON, title: "Joined" } }] }, { activate: true });
  is("setup: a sequence with a deal step", joined.ok, true);
  await upsertContact(list, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  store = (await storeForEmail(OWNER))!;
  await enroll(store, "ana@example.com", { joined: true });
  const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
  hvals = () => "OK";
  await run();
  hvals = null;
  is("while the board is unknown: Ana still has her one deal, untouched", await anaDeals(), [["anadeal001", OPEN]]);
  const [queued] = await original([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]);
  is("the step waits in the queue, not ended", (queued as string[]).length, 1);
  await original((queued as string[]).map((member) => ["ZADD", "nl:mail:flowq", 0, member]));
  await run();
  is("once the board reads: her open deal moves, no second one", await anaDeals(), [["anadeal001", WON]]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
