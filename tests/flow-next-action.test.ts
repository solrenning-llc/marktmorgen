/**
 * A workflow step that sets the next action and its due date on the
 * person's open deal (635 [GL3]; added 2 November 2026), against the
 * in-memory Redis double, a stand-in email provider and synthetic stores
 * only: read strictly, kept and read back, run on the open deal only, never
 * making a deal, and said in words in the studio and on the map.
 */
import { readFileSync } from "node:fs";
import { MAX_STEP_NEXT_ACTION, MAX_STEP_NEXT_DAYS, readAction } from "@/lib/flow-rules";
import { parseFlowList } from "@/lib/flow-list";
import { enroll, readFlows, saveFlow, sendDueSteps } from "@/lib/flows";
import { upsertContact } from "@/lib/contacts";
import { readDeals, readStages, writeDeal } from "@/lib/crm";
import { stepWhat } from "@/components/workflow-tools";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return json({ id: "email_next" });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_next_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_next_only_a_stand_in";
  const OWNER = "next@example.com";
  await claimHandle(OWNER, "nextstep", "Next Step Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestNext000001", true);
  await setSubscription(OWNER, { customerId: "cus_Next00001", subscriptionId: "sub_Next00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Next Step Studio", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const list = store.listId!;
  const stages = await readStages(statsId);
  const open = stages.find((s) => s.kind === "open")!;
  const won = stages.find((s) => s.kind === "won")!;

  part("Read strictly");
  is("words and whole days from 0 to the most", [
    readAction({ do: "next", text: "  Call to   check in ", days: 3 }, () => false),
    readAction({ do: "next", text: "Call", days: "7" }, () => false),
    readAction({ do: "next", text: "Call", days: 0 }, () => false),
    readAction({ do: "next", text: "Call", days: MAX_STEP_NEXT_DAYS }, () => false),
  ], [{ do: "next", text: "Call to check in", days: 3 }, { do: "next", text: "Call", days: 7 }, { do: "next", text: "Call", days: 0 }, { do: "next", text: "Call", days: MAX_STEP_NEXT_DAYS }]);
  is("anything else refused", [
    readAction({ do: "next", text: " ", days: 3 }, () => false),
    readAction({ do: "next", text: "x".repeat(MAX_STEP_NEXT_ACTION + 1), days: 3 }, () => false),
    readAction({ do: "next", text: "Call", days: -1 }, () => false),
    readAction({ do: "next", text: "Call", days: 1.5 }, () => false),
    readAction({ do: "next", text: "Call", days: MAX_STEP_NEXT_DAYS + 1 }, () => false),
    readAction({ do: "next", text: "Call", days: "" }, () => false),
    readAction({ do: "next", text: "Call", days: " " }, () => false),
    readAction({ do: "next", text: "Call", days: "1e2" }, () => false),
  ], ["bad", "bad", "bad", "bad", "bad", "bad", "bad", "bad"]);
is("cleaned as the deals board cleans it", readAction({ do: "next", text: `Call${String.fromCharCode(1)}back`, days: 1 }, () => false), { do: "next", text: "Call back", days: 1 });

  part("Kept and read back");
  const saved = await saveFlow(store, { name: "Follow up", trigger: "joined", active: true, steps: [{ delayHours: 0, action: { do: "next", text: "Call to check in", days: 3 } }] }, { activate: true });
  is("saved with its step", saved.ok ? saved.flows[0].steps[0].action : saved, { do: "next", text: "Call to check in", days: 3 });
  is("the stored list reads it back", parseFlowList(await readFlows(list).then((flows) => JSON.parse(JSON.stringify(flows)))) !== null, true);
  const stored = (action: Record<string, unknown>) => parseFlowList([{ ...(saved.ok ? saved.flows[0] : {}), steps: [{ id: "s1", delayHours: 0, action }] }]);
  is("a stored step without its days, or past the limits, is not read", [stored({ do: "next", text: "Call" }), stored({ do: "next", text: "Call", days: -1 }), stored({ do: "next", text: "Call", days: 1.5 }), stored({ do: "next", text: "Call", days: MAX_STEP_NEXT_DAYS + 1 }), stored({ do: "next", text: "x".repeat(MAX_STEP_NEXT_ACTION + 1), days: 1 })], [null, null, null, null, null]);

  part("Run on the person's open deal only");
  await upsertContact(list, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await upsertContact(list, "ben@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await upsertContact(list, "cy@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await writeDeal(statsId, { id: "bendeal001", title: "Ben's coaching", email: "ben@example.com", cents: 9900, stage: open.id, note: "Met at the fair", assignee: OWNER, createdAt: 1, updatedAt: 1 }, ROOM);
  await writeDeal(statsId, { id: "cydeal0001", title: "Cy's course", email: "cy@example.com", cents: 4900, stage: won.id, note: "", createdAt: 1, updatedAt: 1 }, ROOM);
  store = (await storeForEmail(OWNER))!;
  const before = Math.floor(Date.now() / 1000);
  for (const email of ["ana@example.com", "ben@example.com", "cy@example.com"]) await enroll(store, email, { joined: true });
  for (let i = 0; i < 4; i += 1) await run();
  const deals = await readDeals(statsId, stages);
  const ben = deals.find((d) => d.id === "bendeal001")!;
  const due = (days: number) => new Date((before + days * 86_400) * 1000).toISOString().slice(0, 10);
  is("the open deal gets the next action and the day it is due, in UTC", [ben.nextAction, ben.dueDate], ["Call to check in", due(3)]);
  is("everything else on the deal is kept", [ben.title, ben.cents, ben.stage, ben.note, ben.assignee], ["Ben's coaching", 9900, open.id, "Met at the fair", OWNER]);
  is("someone with no open deal: no deal is made for them", deals.filter((d) => d.email === "ana@example.com").length, 0);
  is("a won deal is not an open one, so it is left as it was", deals.find((d) => d.id === "cydeal0001")!.nextAction ?? "", "");

  part("A deal that already has it");
  const again = await saveFlow(store, { name: "Follow up again", trigger: "tagged", tag: "again", active: true, steps: [{ delayHours: 0, action: { do: "next", text: "Call to check in", days: 3 } }] }, { activate: true });
  is("a second workflow with the same step saves", again.ok, true);
  const stamped = (await readDeals(statsId, stages)).find((d) => d.id === "bendeal001")!.updatedAt;
  await enroll(store, "ben@example.com", { joined: false, tag: "again" });
  for (let i = 0; i < 4; i += 1) await run();
  is("the same next action and due date: confirmed, not written again", (await readDeals(statsId, stages)).find((d) => d.id === "bendeal001")!.updatedAt, stamped);

  part("Said in words");
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  is("the studio's choice, its two fields and what it does", [studio.includes('<option value="next">Sets the next action and its due date on their deal</option>'), studio.includes("<span className=\"text-sm text-ink-soft\">Due in how many days</span>"), studio.includes("Someone with no open deal is skipped, and the run goes on.")], [true, true, true]);
  is("the map says it, and the day it runs for 0", [stepWhat({ action: { do: "next", text: "Call", days: 1 } } as Parameters<typeof stepWhat>[0]), stepWhat({ action: { do: "next", text: "Call", days: 0 } } as Parameters<typeof stepWhat>[0])], ["Set the next action on their deal: “Call”, due in 1 day", "Set the next action on their deal: “Call”, due the day it runs"]);
  is("the hint is read with both fields, and names the board's own filters", [studio.includes("aria-describedby={`next-hint-${s.editorKey}`}"), studio.includes("under Overdue, Due today or Upcoming")], [true, true]);
  is("an empty number of days is sent as none, never as today", studio.includes("days: /^\\d{1,3}$/.test(s.actionDays) ? Number(s.actionDays) : Number.NaN"), true);
}

void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
