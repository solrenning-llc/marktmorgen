/**
 * 639 [GL7](19): a workflow's earlier versions, and putting one back. On a
 * synthetic store, through lib/flows.ts and the studio's real mail route:
 *
 *   - a save that changes what a workflow does keeps the version before it;
 *     switching it on or off, or saving it unchanged, keeps none;
 *   - at most MAX_FLOW_VERSIONS are kept, newest first, counted in the room;
 *   - putting one back is a save checked against the store as it is now,
 *     keeps the workflow's on or off, and keeps the version it replaced, so
 *     it can be undone the same way;
 *   - an unknown version or workflow is refused; a removed workflow's
 *     versions go with it.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { WorkflowVersions } from "@/components/workflow-versions";
import { readFlows, removeFlow, saveFlow, setFlowActive } from "@/lib/flows";
import { MAX_FLOW_VERSIONS, readFlowVersions } from "@/lib/flow-versions";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { POST as mailRoute } from "@/app/api/store/mail/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "versions@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "versions", "Versions Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestVers00001", true);
  await setSubscription(OWNER, { customerId: "cus_Vers0001", subscriptionId: "sub_Vers0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Versions Kitchen", address: "1 Main St, Portland, OR 97201" });
  const store = async () => (await storeForEmail(OWNER))!;
  const list = (await store()).listId as string;
  const session = await openSession(OWNER);
  const post = async (body: Record<string, unknown>) => {
    const response = await mailRoute(new NextRequest("https://marktmorgen.com/api/store/mail", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, data: (await response.json()) as { ok?: boolean; error?: string; versions?: { at: number; name: string; trigger: string; steps: number }[]; flows?: { id: string; name: string; active: boolean; steps: { subject: string }[] }[] } };
  };
  const welcome = (subject: string, name = "Welcome") => ({ name, trigger: "joined", steps: [{ delayHours: 0, subject, body: "Glad you are here." }] });

  part("A save that changes what it does keeps the one before");
  const first = await saveFlow(await store(), welcome("Hello"));
  if (!first.ok) throw new Error(`no workflow: ${first.reason}`);
  const id = first.flows[0].id;
  is("a new workflow has no earlier version", (await readFlowVersions(list, id)).length, 0);
  await saveFlow(await store(), { id, ...welcome("Hello there") });
  const one = await readFlowVersions(list, id);
  is("one earlier version: the first subject", one.map((v) => v.flow.steps[0].subject), ["Hello"]);
  // As the editor sends it back: the same steps, with their ids.
  const saved = (await readFlows(list)).find((f) => f.id === id)!;
  await saveFlow(await store(), { ...saved });
  is("saving it unchanged keeps none", (await readFlowVersions(list, id)).length, 1);
  await setFlowActive(await store(), id, true);
  is("switching it on keeps none", (await readFlowVersions(list, id)).length, 1);

  part("The route lists them, newest first");
  await saveFlow(await store(), { id, active: true, ...welcome("Hi", "Welcome, short") });
  const listed = await post({ action: "flow-versions", id });
  is("name, trigger and steps of each, newest first", listed.data.versions?.map((v) => [v.name, v.trigger, v.steps]), [["Welcome", "joined", 1], ["Welcome", "joined", 1]]);
  is("an unknown workflow", (await post({ action: "flow-versions", id: "ffffffffffffffff" })).status, 404);

  part("Putting one back");
  const oldest = (await readFlowVersions(list, id)).at(-1)!;
  const restored = await post({ action: "flow-restore", id, at: oldest.at });
  const now = (await readFlows(list)).find((f) => f.id === id)!;
  is("its content is back, and it stays on", [restored.data.ok, now.steps[0].subject, now.name, now.active], [true, "Hello", "Welcome", true]);
  const after = await readFlowVersions(list, id);
  is("the version it replaced is kept, so it can be undone", after[0].flow.steps[0].subject, "Hi");
  const undo = await post({ action: "flow-restore", id, at: after[0].at });
  is("undone the same way", [undo.data.ok, (await readFlows(list)).find((f) => f.id === id)!.steps[0].subject], [true, "Hi"]);
  is("an unknown version is refused", [(await post({ action: "flow-restore", id, at: 12345 })).status, (await post({ action: "flow-restore", id, at: 12345 })).data.error], [404, "version"]);

  part("At most ten, and they go with the workflow");
  for (let i = 0; i < MAX_FLOW_VERSIONS + 3; i += 1) await saveFlow(await store(), { id, active: true, ...welcome(`Subject ${i}`) });
  const kept = await readFlowVersions(list, id);
  is(`only the newest ${MAX_FLOW_VERSIONS}`, [kept.length, kept[0].flow.steps[0].subject], [MAX_FLOW_VERSIONS, `Subject ${MAX_FLOW_VERSIONS + 1}`]);
  await removeFlow(await store(), id);
  is("a removed workflow's versions are gone", [(await readFlowVersions(list, id)).length, (await redis.pipeline([["LLEN", `nl:wf:ver:${list}:${id}`]]))[0]], [0, 0]);

  part("The studio");
  const drawn = renderToStaticMarkup(createElement(WorkflowVersions, { flowId: id, request: async () => ({ ok: true, versions: [] }), onRestored: () => undefined }));
  is("a named section that says what is kept and how putting one back works", [drawn.includes("<h4"), drawn.includes("Earlier versions"), drawn.includes(`the last ${MAX_FLOW_VERSIONS}, while your store has room`), drawn.includes("keeps it switched on or off as it is now")], [true, true, true, true]);
  is("it says it is reading, in a status", drawn.includes('role="status"') && drawn.includes("Reading the earlier versions"), true);
  const source = readFileSync("components/workflow-versions.tsx", "utf8");
  is("each version has a button whose name starts with its visible words", source.includes("Put this version back</") || source.includes("Put this version back\n"), true);
  is("and its accessible name adds the date after them", source.includes("aria-label={`Put this version back: ${when(v.at)}`}"), true);
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  is("the workflow list opens it with a toggle that says whether it is open", studio.includes("aria-expanded={versionsOpen === f.id}") && studio.includes("<WorkflowVersions flowId={f.id} request={call} onRestored={refreshFlows} />"), true);
  is("putting one back is a sequence write, so an unconfirmed one is said as such", studio.includes('"flow-resolve", "flow-restore"].includes'), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
