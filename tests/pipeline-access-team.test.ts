/**
 * 639 [GL7](7), unit 3: choosing, on the team page, what each Editor and
 * Support person may do with each pipeline (app/api/store/pipeline-access,
 * components/pipeline-access-editor.tsx, app/studio/team/page.tsx), through
 * the real route, session and store. Only whoever runs the team chooses;
 * Admins are never restricted; each change is in the activity log; the deal
 * routes then hold to it.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/pipeline-access/route";
import { POST as CRM } from "@/app/api/store/crm/route";
import { PipelineAccessEditor } from "@/components/pipeline-access-editor";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readPipelineAccess, setPipelineAccess } from "@/lib/pipeline-access";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { moveMemberships, putMember, readLog, readTeam } from "@/lib/team";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Reply = { ok?: boolean; error?: string; message?: string; access?: Record<string, string> };

async function main(): Promise<void> {
  redis.clear();
  const owner = "teamaccess@example.com";
  await claimHandle(owner, "teamaccess", "Team Access", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1TestTeamAcc01", true);
  await setSubscription(owner, { customerId: "cus_TeamAccess01", subscriptionId: "sub_TeamAccess01", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  await putMember(store, "sam@example.com", "support");
  await putMember(store, "ada@example.com", "admin");
  await putMember(store, "eve@example.com", "editor");
  const cookie = (email: string) => openSession(email).then((s) => `${SESSION_COOKIE}=${s}`);
  const post = async (who: string, body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/pipeline-access", { method: "POST", headers: { "content-type": "application/json", cookie: await cookie(who) }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };

  part("Choosing");
  const set = await post(owner, { email: "sam@example.com", pipeline: "sales0", access: "view" });
  is("the owner restricts a Support person", [set.status, set.body.access], [200, { sales0: "view" }]);
  is("kept", await readPipelineAccess(store.statsId, "sam@example.com"), { sales0: "view" });
  is("written in the activity log", (await readLog(store.sid)).some((line) => line.what === "Set sam@example.com's access to the Sales pipeline: can only see (was can change)"), true);
  const deal = await CRM(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", cookie: await cookie("sam@example.com") }, body: JSON.stringify({ action: "deal", deal: { title: "Seats", email: "", cents: 100, stage: "lead00", note: "" } }) }));
  is("and the deal routes hold to it", deal.status, 403);
  is("can change again, as before", [(await post(owner, { email: "sam@example.com", pipeline: "sales0", access: "edit" })).body.access, await readPipelineAccess(store.statsId, "sam@example.com")], [{}, {}]);
  const admin = await post(owner, { email: "ada@example.com", pipeline: "sales0", access: "none" });
  is("an Admin is never restricted, and it says how", [admin.status, admin.body.error, admin.body.message], [400, "admin", "An Admin sees and changes every pipeline. Change their role to restrict them."]);
  is("someone not on the team, or a pipeline that is gone", [(await post(owner, { email: "x@example.com", pipeline: "sales0", access: "view" })).status, (await post(owner, { email: "sam@example.com", pipeline: "gone00", access: "view" })).status], [404, 404]);
  is("a choice that is not one", (await post(owner, { email: "sam@example.com", pipeline: "sales0", access: "all" })).body.error, "invalid");
  const self = await post("sam@example.com", { email: "sam@example.com", pipeline: "sales0", access: "edit" });
  is("a Support person cannot choose, not even for themselves", self.status >= 400 && self.status < 500, true);

  const editor = await post(owner, { email: "eve@example.com", pipeline: "sales0", access: "view" });
  is("an Editor, whose role does not open Deals, is not offered a restriction that would do nothing", [editor.status, editor.body.error, await readPipelineAccess(store.statsId, "eve@example.com")], [400, "no_deals", {}]);

  part("A record that cannot be read");
  const crmPost = async (body: Record<string, unknown>) => CRM(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", cookie: await cookie(owner) }, body: JSON.stringify(body) }));
  const added = await crmPost({ action: "pipeline", pipeline: { id: "wkshp1", name: "Workshops", stages: [{ id: "wnew01", name: "New", kind: "open" }, { id: "wwon01", name: "Won", kind: "won" }, { id: "wlost1", name: "Lost", kind: "lost" }] }, moves: {} });
  is("(a second pipeline)", added.status, 200);
  await redis.pipeline([["HSET", `nl:crm:pacc:${store.statsId}`, "sam@example.com", "{not json"]]);
  is("(sam's record cannot be read)", await readPipelineAccess(store.statsId, "sam@example.com"), null);
  const fixed = await post(owner, { email: "sam@example.com", pipeline: "sales0", access: "view" });
  is("saving one pipeline never opens the others: they stay at no access", [fixed.status, fixed.body.access], [200, { sales0: "view", wkshp1: "none" }]);
  await redis.pipeline([["HSET", `nl:crm:pacc:${store.statsId}`, "sam@example.com", "{not json"]]);
  is("even when the one chosen is set to change", (await post(owner, { email: "sam@example.com", pipeline: "sales0", access: "edit" })).body.access, { wkshp1: "none" });

  part("Two saves at once");
  await post(owner, { email: "sam@example.com", pipeline: "wkshp1", access: "edit" });
  const both = await Promise.all([post(owner, { email: "sam@example.com", pipeline: "sales0", access: "view" }), post(owner, { email: "sam@example.com", pipeline: "wkshp1", access: "none" })]);
  const kept = await readPipelineAccess(store.statsId, "sam@example.com");
  const applied = both.filter((r) => r.status === 200).map((r) => r.body.access);
  // Whichever went through last kept the other's choice: both, when both went through (in whatever order they ran).
  is("never write over each other: what is kept is exactly what the last save that went through said", applied.length === 2 ? JSON.stringify(kept) === JSON.stringify({ sales0: "view", wkshp1: "none" }) : JSON.stringify(kept) === JSON.stringify(applied[0]), true);
  is("one that cannot go through says so and writes nothing", both.filter((r) => r.status !== 200).every((r) => r.status === 409 && r.body.error === "busy" && r.body.message === "Someone else is changing this person's access right now. Try again in a moment."), true);
  await redis.pipeline([["SET", `nl:crm:pacc:lock:${store.statsId}:sam@example.com`, "someone", "EX", 10]]);
  const held = await post(owner, { email: "sam@example.com", pipeline: "sales0", access: "none" });
  is("while another change to the same person is being written, a save is refused", [held.status, held.body.error], [409, "busy"]);
  is("and nothing of it is kept", (await readPipelineAccess(store.statsId, "sam@example.com"))?.sales0 !== "none", true);
  await redis.pipeline([["DEL", `nl:crm:pacc:lock:${store.statsId}:sam@example.com`]]);
  await setPipelineAccess(store.statsId!, "sam@example.com", ["sales0", "wkshp1"], "sales0", "view", store);
  const [lock] = await redis.pipeline([["GET", `nl:crm:pacc:lock:${store.statsId}:sam@example.com`]]);
  is("the lock is let go once the change is written", lock, null);
  const pipe = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "HSET" && String(c[1]).startsWith("nl:crm:pacc:"))) throw new Error("down");
    return pipe(commands);
  }) as typeof redis.pipeline;
  const failed = await post(owner, { email: "sam@example.com", pipeline: "sales0", access: "none" });
  redis.pipeline = pipe;
  const [after] = await redis.pipeline([["GET", `nl:crm:pacc:lock:${store.statsId}:sam@example.com`]]);
  is("and also when the write fails, so the next save is not refused", [failed.status, after, (await post(owner, { email: "sam@example.com", pipeline: "sales0", access: "none" })).status], [500, null, 200]);

  part("While the teammate changes their sign-in");
  await post(owner, { email: "sam@example.com", pipeline: "sales0", access: "edit" });
  await post(owner, { email: "sam@example.com", pipeline: "wkshp1", access: "edit" });
  const [raced] = await Promise.all([post(owner, { email: "sam@example.com", pipeline: "sales0", access: "none" }), moveMemberships("sam@example.com", "sam5@example.com")]);
  const onTeam = (await readTeam(store.sid)).members.find((m) => m.email === "sam5@example.com" || m.email === "sam@example.com")!.email;
  is("whichever comes first, the address on the team holds the restriction the owner saved, and none is lost", [onTeam, raced.status === 200 ? (await readPipelineAccess(store.statsId, onTeam))?.sales0 : raced.status], ["sam5@example.com", raced.status === 200 ? "none" : 404]);
  await moveMemberships("sam5@example.com", "sam@example.com");
  is("(back on the first address, with it)", (await readPipelineAccess(store.statsId, "sam@example.com"))?.sales0 ?? (raced.status === 200 ? "lost" : "none-saved"), raced.status === 200 ? "none" : "none-saved");
  const teamLock = `nl:team:lock:${store.sid}`;
  await redis.pipeline([["SET", teamLock, "someone", "EX", 10]]);
  const teamBusy = await post(owner, { email: "sam@example.com", pipeline: "wkshp1", access: "view" });
  await redis.pipeline([["DEL", teamLock]]);
  is("while the team is being changed, a save waits, then says so and writes nothing", [teamBusy.status, teamBusy.body.error, teamBusy.body.message, (await readPipelineAccess(store.statsId, "sam@example.com"))?.wkshp1 ?? "edit"], [409, "busy", "Someone else is changing your team right now. Try again in a moment.", "edit"]);
  is("the route reads the teammate and writes with the team's lock held", readFileSync("app/api/store/pipeline-access/route.ts", "utf8").includes("await withTeamLocked(store.sid, async () => {"), true);

  part("Every pipeline at once, from the Save button");
  await post(owner, { email: "sam@example.com", pipeline: "sales0", access: "edit" });
  const saveAll = await post(owner, { email: "sam@example.com", choices: { sales0: "view", wkshp1: "none" } });
  is("one Save keeps every choice, and the log says them", [saveAll.status, saveAll.body.access, (await readLog(store.sid)).some((line) => line.what === "Set sam@example.com's pipeline access. Sales: can only see (was can change); Workshops: no access (was can change)")], [200, { sales0: "view", wkshp1: "none" }, true]);
  is("a choice that is not one, or a pipeline that is gone, changes nothing", [(await post(owner, { email: "sam@example.com", choices: { sales0: "all" } })).body.error, (await post(owner, { email: "sam@example.com", choices: { gone00: "view" } })).status, await readPipelineAccess(store.statsId, "sam@example.com")], ["invalid", 404, { sales0: "view", wkshp1: "none" }]);
  await redis.pipeline([["HSET", `nl:crm:pacc:${store.statsId}`, "sam@example.com", JSON.stringify({ sales0: "view", wkshp1: "none", oldp01: "none" })]]);
  is("a restriction on a pipeline the store no longer has is dropped at the next save", (await post(owner, { email: "sam@example.com", choices: { sales0: "edit" } })).body.access, { wkshp1: "none" });

  part("The screen");
  const html = renderToStaticMarkup(createElement(PipelineAccessEditor, { members: [{ email: "sam@example.com", role: "support" }], pipelines: [{ id: "sales0", name: "Sales" }, { id: "coach0", name: "Coaching" }], initial: { "sam@example.com": { coach0: "none" } } }));
  is("each teammate a group named by their address", html.includes("<fieldset") && html.includes(">sam@example.com</legend>"), true);
  is("each pipeline a labeled choice, as it stands", html.includes(">Sales</span>") && html.includes(">Coaching</span>") && /<option value="none" selected="">No access<\/option>/.test(html) && /<option value="edit" selected="">Can change<\/option>/.test(html), true);
  is("refusals said in an alert", html.includes('role="alert"'), true);
  const unread = renderToStaticMarkup(createElement(PipelineAccessEditor, { members: [{ email: "sam@example.com", role: "support" }], pipelines: [{ id: "sales0", name: "Sales" }], initial: { "sam@example.com": null } }));
  is("a record that cannot be read is said to show nothing, and what saving does", unread.includes("they see no pipeline. Choose what they may do with each one and save; the others stay at No access until you do.") && /<option value="none" selected="">/.test(unread), true);
  is("nobody to restrict, said why", renderToStaticMarkup(createElement(PipelineAccessEditor, { members: [], pipelines: [], initial: {} })).includes("only Support people can"), true);
  const editorCode = readFileSync("components/pipeline-access-editor.tsx", "utf8");
  is("a choice saves nothing by itself: each teammate has a Save that names them, and what happened is said in their own group", [/<select[^>]*disabled/.test(html), html.includes('role="status"'), html.includes(">Save<span class=\"sr-only\"> the access of sam@example.com</span>"), editorCode.includes("onChange={(event) => void choose"), editorCode.includes("body: JSON.stringify({ email, choices, was })")], [false, true, true, false, true]);
  is("an error is tied to that teammate's choices, and the Save button is never disabled (it says why instead)", [editorCode.includes("aria-describedby={message?.kind === \"error\" ? errorId : undefined}"), editorCode.includes("aria-disabled={busy !== null || undefined}"), editorCode.includes("Another teammate's access is being saved. Press Save again in a moment.")], [true, true, true]);

  part("On the team page");
  const page = readFileSync("app/studio/team/page.tsx", "utf8");
  is("a named section, only roles that open Deals offered, never an Admin", page.includes('aria-labelledby="pipeline-access-title"') && page.includes('(m.role === "editor" || m.role === "support") && can(m.role, "orders")'), true);
  is("said when it cannot be read", page.includes("Your pipelines or your team&apos;s access could not be read just now."), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
