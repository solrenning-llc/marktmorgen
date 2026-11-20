/**
 * 639 [GL7](7), review round 5: two pipelines may share a name (a teammate
 * who cannot see one may give theirs the same name), so every screen of
 * the owner tells them apart (lib/crm-rules.ts, pipelineNames), and the
 * board offers a teammate who sees no pipeline what the server lets them do.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { DealsBoard } from "@/components/deals-board";
import { PipelineAccessEditor } from "@/components/pipeline-access-editor";
import { accessLogNamer, accessLogWords } from "@/lib/pipeline-access-rules";
import { DEFAULT_STAGES, FIRST_PIPELINE_ID, type Deal, type Pipeline, changePipeline, labeledStages, pipelineNames, stageLabel } from "@/lib/crm-rules";
import { done, is, part } from "./check";

const sales: Pipeline = { id: FIRST_PIPELINE_ID, name: "Sales", stages: DEFAULT_STAGES };
const twin: Pipeline = { id: "sales2", name: "sales", stages: [{ id: "tnew01", name: "New", kind: "open" }, { id: "twon01", name: "Won", kind: "won" }, { id: "tlst01", name: "Lost", kind: "lost" }] };
const pipelines = [sales, twin];
const deal = (id: string, stage: string): Deal => ({ id, title: "Deal " + id, email: "", cents: 1000, stage, note: "", createdAt: 100, updatedAt: 200 });
const draw = (extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { push() {}, refresh() {}, prefetch() {} } as never }, createElement(DealsBoard, { deals: [deal("d000000001", "lead00")], stages: pipelines.flatMap((p) => p.stages), pipelines, pipelineMax: 5, fields: [], currency: "usd", assignees: ["owner@example.com"], today: "2026-11-04", ...extra })));

part("Pipelines that share a name are told apart, in the order they were made");
is("the later one gets a number", [...pipelineNames(pipelines).values()], ["Sales", "sales (2)"]);
is("never one that another pipeline already has", [...pipelineNames([sales, { ...twin, name: "Sales (2)" }, { ...twin, id: "sales3", name: "Sales" }]).values()], ["Sales", "Sales (2)", "Sales (3)"]);
is("names nobody shares stay as they are", [...pipelineNames([sales, { ...twin, name: "Coaching" }]).values()], ["Sales", "Coaching"]);
const labels = labeledStages(pipelines).filter((s) => s.kind === "won").map((s) => s.name);
is("so a form's or a workflow's choice of stage never offers two that read the same", [labels, stageLabel(pipelines, { id: "twon01", name: "Won" })], [["Sales: Won", "sales (2): Won"], "sales (2): Won"]);

part("On the board");
const board = draw();
is("each pipeline's button and total says which", [board.includes(">sales (2)<"), (board.match(/>Sales</g) ?? []).length >= 1], [true, true]);
is("and the board says why one has a number, with the real name", board.includes("Some of these pipelines share a name, so each one made later shows a number after it, such as “sales (2)”."), true);
is("the file of selected deals is named from it too", readFileSync("components/deals-board.tsx", "utf8").includes("(pipelines.length > 1 ? nameOf(pipeline).toLowerCase()"), true);
is("nothing said when no names are shared", draw({ pipelines: [sales, { ...twin, name: "Coaching" }] }).includes("Some of these pipelines share a name"), false);

part("In the access editor and the team's log");
const editor = renderToStaticMarkup(createElement(PipelineAccessEditor, { members: [{ email: "sam@example.com", role: "support" }], pipelines: [{ id: sales.id, name: sales.name }, { id: twin.id, name: twin.name }], initial: {} }));
is("each choice named as the board names it", [editor.includes(">Sales</span>"), editor.includes(">sales (2)</span>")], [true, true]);
is("the log names them the same way when shown", accessLogWords({ email: "sam@example.com", one: false, changes: [{ id: twin.id, name: twin.name, now: "none", was: "edit" }] }, accessLogNamer(pipelines)), "Set sam@example.com's pipeline access. sales (2): no access (was can change)");

part("Editing a pipeline that already shares its name");
const counts = new Map<string, number>();
is("its stages are saved while its name stays as it was", changePipeline(pipelines, { pipeline: { ...twin, stages: [...twin.stages, { id: "tmid01", name: "Talking", kind: "open" }] } }, {}, counts, 5).ok, true);
is("renaming it to another pipeline's name is still refused", changePipeline([sales, { ...twin, name: "Partners" }], { pipeline: { ...twin, name: "SALES" } }, {}, counts, 5), { ok: false, error: "pipelines" });

part("A teammate who sees no pipeline");
const empty = draw({ pipelines: [], deals: [], stages: [], someHidden: true });
is("is told so, and offered what the server lets them do: a pipeline of their own and the fields", [empty.includes("You have no pipelines to see in this store. Ask the store&#x27;s owner if you need to see one. You can still add a pipeline of your own and change the fields below."), empty.includes("New pipeline"), empty.includes("Add your first field")], [true, true, true]);
is("and nothing of a pipeline that is not theirs", [empty.includes("New deal"), empty.includes("Change the pipeline and its stages"), empty.includes(">Sales<")], [false, false, false]);
const boardCode = readFileSync("components/deals-board.tsx", "utf8");
is("Remove is offered on the one pipeline they see only when the store has others (the server keeps the last one)", [boardCode.includes("!pipelineDraft.isNew && (pipelines.length > 1 || othersHidden)"), readFileSync("app/studio/deals/page.tsx", "utf8").includes("othersHidden={hidden > 0}")], [true, true]);
is("and with deals and nowhere they may send them, it says what to do instead of an empty choice", boardCode.includes("Move its ${pipelineDeals.length === 1 ? \"deal\" : \"deals\"} to a pipeline you can change first."), true);
is("and a full store never tells them to remove one they cannot see", boardCode.includes("Your store has all the pipelines it can keep now. Ask the store's owner if you need another."), true);
const page = readFileSync("app/studio/deals/page.tsx", "utf8");
is("the deals page draws the board for them", [page.includes("&& (shown.pipelines.length > 0 || restricted);"), page.includes("shown.pipelines.length === 0 ? <p")], [true, false]);

done();
