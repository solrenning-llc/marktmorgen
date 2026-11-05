/**
 * 639 [GL7](7), unit 2: the deals a teammate may only see, drawn without
 * anything that changes them (components/deals-board.tsx), and the deals
 * and forms pages showing each teammate only the pipelines the store lets
 * them see (app/studio/deals/page.tsx, app/studio/forms/page.tsx).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { DealsBoard } from "@/components/deals-board";
import { DealAgenda } from "@/components/deal-agenda";
import { DEFAULT_STAGES, FIRST_PIPELINE_ID, type Deal, type Pipeline } from "@/lib/crm-rules";
import { readdirSync } from "node:fs";
import { can } from "@/lib/team-roles";
import { done, is, part } from "./check";

const coaching: Pipeline = { id: "coach0", name: "Coaching", stages: [{ id: "cnew00", name: "Intro call", kind: "open" }, { id: "cwon00", name: "Signed", kind: "won" }, { id: "clost0", name: "Passed", kind: "lost" }] };
const pipelines: Pipeline[] = [{ id: FIRST_PIPELINE_ID, name: "Sales", stages: DEFAULT_STAGES }, coaching];
const deal = (id: string, stage: string): Deal => ({ id, title: "Deal " + id, email: "", cents: 1000, stage, note: "", createdAt: 100, updatedAt: 200 });
const props = { deals: [deal("d000000001", "lead00"), deal("d000000003", "cnew00")], stages: pipelines.flatMap((p) => p.stages), pipelines, pipelineMax: 5, fields: [], currency: "usd", assignees: ["owner@example.com"], today: "2026-11-04" };
const draw = (viewOnly?: string[]) =>
  renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { push() {}, refresh() {}, prefetch() {} } as never }, createElement(DealsBoard, { ...props, viewOnly })));

part("A pipeline they may only see");
const seen = draw([FIRST_PIPELINE_ID]);
is("its deals are shown", seen.includes("Deal d000000001"), true);
is("with nothing that changes them: no new deal, no move, no edit, no remove", [seen.includes("New deal"), seen.includes("Move Deal d000000001"), />Edit</.test(seen), seen.includes('aria-label="Remove Deal d000000001"')], [false, false, false, false]);
is("its stages cannot be changed, and it says why and whom to ask", [seen.includes("Change Sales and its stages"), seen.includes("You can see this pipeline but not change it. Ask the store’s owner to change your access.")], [false, true]);

is("nor a copy of it offered; a new pipeline of their own still is", [seen.includes("Duplicate “Sales”"), seen.includes("New pipeline")], [false, true]);
const agenda = (onEdit?: (d: Deal) => void) => renderToStaticMarkup(createElement(DealAgenda, { deals: [{ ...deal("d000000001", "lead00"), nextAction: "Call back", dueDate: "2026-11-05" }], stages: DEFAULT_STAGES, currency: "usd", today: "2026-11-04", disabled: false, onEdit }));
is("its agenda lists the deals with no Edit column or button", [/>Edit</.test(agenda()), agenda().includes("Call back")], [false, true]);
is("the agenda of a pipeline they may change keeps Edit", />Edit</.test(agenda(() => {})), true);
is("the board gives the agenda no editor on a pipeline they may only see", readFileSync("components/deals-board.tsx", "utf8").includes("onEdit={canChange ? deal =>"), true);

is("never sends them to a button that is not there, and marks the pipeline view only (review of units 2 and 3)", [seen.includes("No deals in this pipeline yet. You can see it but not change it.") || seen.includes("Deal d000000001"), seen.includes("· view only"), seen.includes("owner or an Admin")], [true, true, false]);
is("the store's pipeline count is never said to someone who may not see them all", [renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { push() {}, refresh() {}, prefetch() {} } as never }, createElement(DealsBoard, { ...props, someHidden: true }))).includes("of the 5 pipelines"), draw().includes("of the 5 pipelines")], [false, true]);

part("A pipeline they may change, beside one they may only see");
const mixed = draw(["coach0"]);
is("its deals keep every control", mixed.includes("New deal") && mixed.includes("Move Deal d000000001") && mixed.includes("Change Sales and its stages") && mixed.includes("Duplicate “Sales”"), true);
is("a deal can be moved only to a stage they may change", [mixed.includes('value="lead00"'), mixed.includes('value="cnew00"')], [true, false]);
const open = draw();
is("everything as before when nothing is restricted", [open.includes('value="cnew00"'), open.includes("Change Sales and its stages"), />Edit</.test(open), open.includes('aria-label="Remove Deal d000000001"'), open.includes("New deal")], [true, true, true, true, true]);

part("The pages");
const deals = readFileSync("app/studio/deals/page.tsx", "utf8");
is("the deals page reads this person's access, the owner and Admins never restricted", deals.includes('const restricted = view.role !== "owner" && view.role !== "admin";') && deals.includes("readPipelineAccess(store.statsId, view.email).catch(() => null)"), true);
is("shows only what they may see, and marks what they may only see", deals.includes("visiblePipelines(inventory.pipelines, view.role, access)") && deals.includes("deals: inventory.deals.filter((deal) => seenStages.has(deal.stage))") && deals.includes("viewOnly={viewOnly}"), true);
is("never offers a pipeline beyond the store's limit", deals.includes("pipelineMax={Math.max(0, pipelineLimit(store) - hidden)}"), true);
is("says so when there is nothing they may see", deals.includes("You have no pipelines to see in this store."), true);
is("an access record that cannot be read is said as such, and nobody is sent to an Admin who cannot change access", [deals.includes("Your access to this store&apos;s pipelines could not be read just now"), deals.includes("owner or an Admin"), deals.includes("someHidden={restricted}")], [true, false, true]);
is("but never when their access could not be read: then the deals are unavailable, not missing", deals.includes("inventory.available && access !== null && shown.pipelines.length === 0") && deals.includes("&& shown.pipelines.length > 0;"), true);
const forms = readFileSync("app/studio/forms/page.tsx", "utf8");
is("the forms page offers only stages they may change, and shows only deals they may see", forms.includes('seen.filter((p) => p.access === "edit")') && forms.includes("reviewData.deals.filter((deal) => !restricted || seenStages.has(deal.stage))"), true);

part("Every other way to a deal (inbox C3-37 (b), (c))");
// Only Editors and Support can be restricted; the owner and Admins never are.
is("a role that can be restricted cannot save or switch on a workflow (which can move or give out deals): send stays the owner's and Admins'", [can("editor", "send"), can("support", "send")], [false, false]);
is("nor export a person's data, deals included", [can("editor", "export"), can("support", "export")], [false, false]);
const agentFiles = [...readdirSync("lib").filter((f) => /^(api-|mcp)/.test(f)).map((f) => `lib/${f}`)];
is("no agent tool or API key reads or changes deals yet: if one does, it needs the same check", agentFiles.filter((f) => /\b(readDeals|writeDeal|dropDeal|readDeal|readOpportunityReview)\b/.test(readFileSync(f, "utf8"))), []);

done();
