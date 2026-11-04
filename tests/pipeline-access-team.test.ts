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
import { readPipelineAccess } from "@/lib/pipeline-access";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { putMember, readLog } from "@/lib/team";
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
  const cookie = (email: string) => openSession(email).then((s) => `${SESSION_COOKIE}=${s}`);
  const post = async (who: string, body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/pipeline-access", { method: "POST", headers: { "content-type": "application/json", cookie: await cookie(who) }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };

  part("Choosing");
  const set = await post(owner, { email: "sam@example.com", pipeline: "sales0", access: "view" });
  is("the owner restricts a Support person", [set.status, set.body.access], [200, { sales0: "view" }]);
  is("kept", await readPipelineAccess(store.statsId, "sam@example.com"), { sales0: "view" });
  is("written in the activity log", (await readLog(store.sid)).some((line) => line.what === "Set sam@example.com's access to the Sales pipeline: can only see"), true);
  const deal = await CRM(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", cookie: await cookie("sam@example.com") }, body: JSON.stringify({ action: "deal", deal: { title: "Seats", email: "", cents: 100, stage: "lead00", note: "" } }) }));
  is("and the deal routes hold to it", deal.status, 403);
  is("can change again, as before", [(await post(owner, { email: "sam@example.com", pipeline: "sales0", access: "edit" })).body.access, await readPipelineAccess(store.statsId, "sam@example.com")], [{}, {}]);
  const admin = await post(owner, { email: "ada@example.com", pipeline: "sales0", access: "none" });
  is("an Admin is never restricted, and it says how", [admin.status, admin.body.error, admin.body.message], [400, "admin", "An Admin sees and changes every pipeline. Change their role to restrict them."]);
  is("someone not on the team, or a pipeline that is gone", [(await post(owner, { email: "x@example.com", pipeline: "sales0", access: "view" })).status, (await post(owner, { email: "sam@example.com", pipeline: "gone00", access: "view" })).status], [404, 404]);
  is("a choice that is not one", (await post(owner, { email: "sam@example.com", pipeline: "sales0", access: "all" })).body.error, "invalid");
  const self = await post("sam@example.com", { email: "sam@example.com", pipeline: "sales0", access: "edit" });
  is("a Support person cannot choose, not even for themselves", self.status >= 400 && self.status < 500, true);

  part("The screen");
  const html = renderToStaticMarkup(createElement(PipelineAccessEditor, { members: [{ email: "sam@example.com", role: "support" }], pipelines: [{ id: "sales0", name: "Sales" }, { id: "coach0", name: "Coaching" }], initial: { "sam@example.com": { coach0: "none" } } }));
  is("each teammate a group named by their address", html.includes("<fieldset") && html.includes(">sam@example.com</legend>"), true);
  is("each pipeline a labeled choice, as it stands", html.includes(">Sales</span>") && html.includes(">Coaching</span>") && /<option value="none" selected="">No access<\/option>/.test(html) && /<option value="edit" selected="">Can change<\/option>/.test(html), true);
  is("refusals said in an alert", html.includes('role="alert"'), true);
  const unread = renderToStaticMarkup(createElement(PipelineAccessEditor, { members: [{ email: "sam@example.com", role: "support" }], pipelines: [{ id: "sales0", name: "Sales" }], initial: { "sam@example.com": null } }));
  is("a record that cannot be read is said to show nothing", unread.includes("see no pipeline until it is saved again") && /<option value="none" selected="">/.test(unread), true);
  is("nobody to restrict, said why", renderToStaticMarkup(createElement(PipelineAccessEditor, { members: [], pipelines: [], initial: {} })).includes("only Editors and Support can"), true);

  part("On the team page");
  const page = readFileSync("app/studio/team/page.tsx", "utf8");
  is("a named section, only Editors and Support offered", page.includes('aria-labelledby="pipeline-access-title"') && page.includes('m.role === "editor" || m.role === "support"'), true);
  is("said when it cannot be read", page.includes("Your pipelines or your team&apos;s access could not be read just now."), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
