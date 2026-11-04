/**
 * A workflow step that shares deals evenly among the team (635 [GL3];
 * added 2 November 2026), against the in-memory Redis double, a stand-in
 * email provider and synthetic stores only: each open deal goes to whoever
 * may own deals and has the fewest open ones, the owner first on a tie;
 * someone who left the team, or lost the role, is never chosen; a deal that
 * already has someone responsible keeps them; no deal is ever made.
 */
import { readFileSync } from "node:fs";
import { readAction } from "@/lib/flow-rules";
import { parseFlowList } from "@/lib/flow-list";
import { enroll, readFlows, saveFlow, sendDueSteps } from "@/lib/flows";
import { upsertContact } from "@/lib/contacts";
import { readDeals, readStages, writeDeal } from "@/lib/crm";
import { putMember, removeMember, setMemberRole } from "@/lib/team";
import { flowConfigurationIssues } from "@/lib/flow-review";
import { stepWhat } from "@/components/workflow-tools";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return json({ id: "email_rotate" });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_rotate_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_rotate_only_a_stand_in";
  const OWNER = "rotate@example.com";
  const MAYA = "maya@example.com";
  const PAT = "pat@example.com";
  await claimHandle(OWNER, "rotate", "Rotate Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRotate0001", true);
  await setSubscription(OWNER, { customerId: "cus_Rotate001", subscriptionId: "sub_Rotate001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Rotate Studio", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  await putMember(store, MAYA, "support");
  await putMember(store, PAT, "support");
  store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const list = store.listId!;
  const stages = await readStages(statsId);
  const open = stages.find((s) => s.kind === "open")!;

  part("Read and kept");
  is("a step of its own, with nothing to choose", readAction({ do: "rotate" }, () => false), { do: "rotate" });
  const saved = await saveFlow(store, { name: "Share", trigger: "joined", active: true, steps: [{ delayHours: 0, action: { do: "rotate" } }] }, { activate: true });
  is("saved", saved.ok, true);
  is("the stored list reads it back", parseFlowList(JSON.parse(JSON.stringify(await readFlows(list)))) !== null, true);

  part("Shared evenly");
  // Maya already holds one open deal; Pat and the owner none.
  await writeDeal(statsId, { id: "mayadeal01", title: "Old", email: "old@example.com", cents: 0, stage: open.id, note: "", assignee: MAYA, createdAt: 1, updatedAt: 1 }, ROOM);
  const people = ["a", "b", "c", "d", "e"].map((x) => `${x}@example.com`);
  for (const [i, email] of people.entries()) {
    await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, ROOM);
    await writeDeal(statsId, { id: `deal0000${i}x`, title: `Deal ${i}`, email, cents: 0, stage: open.id, note: "", createdAt: 2, updatedAt: 2 }, ROOM);
  }
  await upsertContact(list, "nodeal@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  for (const email of [...people, "nodeal@example.com"]) await enroll(store, email, { joined: true });
  for (let i = 0; i < 4; i += 1) await run();
  const deals = await readDeals(statsId, stages);
  const count = (who: string) => deals.filter((d) => d.assignee === who && d.stage === open.id).length;
  is("each open deal goes to whoever had the fewest: two each in the end", [count(OWNER), count(MAYA), count(PAT)], [2, 2, 2]);
  is("someone with no open deal: no deal is made for them", deals.filter((d) => d.email === "nodeal@example.com").length, 0);

  part("Who is never chosen, and who is kept");
  await removeMember(store, PAT);
  store = (await storeForEmail(OWNER))!;
  await writeDeal(statsId, { id: "patkept001", title: "Pat's", email: "f@example.com", cents: 0, stage: open.id, note: "", assignee: PAT, createdAt: 3, updatedAt: 3 }, ROOM);
  await writeDeal(statsId, { id: "mayakept01", title: "Maya's", email: "g@example.com", cents: 0, stage: open.id, note: "", assignee: MAYA, createdAt: 3, updatedAt: 3 }, ROOM);
  for (const email of ["f@example.com", "g@example.com"]) {
    await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, ROOM);
    await enroll(store, email, { joined: true });
  }
  for (let i = 0; i < 4; i += 1) await run();
  const after = await readDeals(statsId, stages);
  // The owner holds 2 open deals and Maya 3 (with the one she keeps), so the one Pat held goes to the owner.
  is("a deal held by someone who left the team goes to whoever on it has the fewest", after.find((d) => d.id === "patkept001")!.assignee, OWNER);
  is("a deal held by someone still on the team keeps them", after.find((d) => d.id === "mayakept01")!.assignee, MAYA);

  part("A teammate who can no longer see orders, and a tie");
  await setMemberRole(store, MAYA, "editor");
  store = (await storeForEmail(OWNER))!;
  await writeDeal(statsId, { id: "tiedeal001", title: "Tie", email: "h@example.com", cents: 0, stage: open.id, note: "", assignee: MAYA, createdAt: 4, updatedAt: 4 }, ROOM);
  await upsertContact(list, "h@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "h@example.com", { joined: true });
  for (let i = 0; i < 4; i += 1) await run();
  is("a deal held by someone who can no longer see orders goes to someone who can: only the owner now", (await readDeals(statsId, stages)).find((d) => d.id === "tiedeal001")!.assignee, OWNER);
  is("with only the owner left, the workflow's review says every deal goes to them", flowConfigurationIssues((await readFlows(list))[0], { products: [], courses: [], forms: [], fields: [], stages, flows: [], assignees: [OWNER] }).some((i) => i.includes("No one besides you can be responsible for deals, so every deal goes to you.")), true);

  part("Said in words");
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  is("offered with a deals board and someone besides the owner, or where a step already has it, and what it does", [studio.includes('(automation.stages.length && assignees.length > 1) || s.kind === "rotate" ? <option value="rotate">Gives their deal to the teammate with the fewest open deals</option>'), studio.includes("Someone who left the team, or can no longer see orders, is never chosen")], [true, true]);
  is("the map says it", stepWhat({ action: { do: "rotate" } } as Parameters<typeof stepWhat>[0]), "Give their deal to whoever on your team has the fewest open deals");
}

void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
