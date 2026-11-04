/**
 * The deals board with pipelines, drawn on the server (17 October 2026):
 * pipeline tabs and honest totals, every pipeline's stages to move a deal
 * to, and the payment request a deal links to (#533), kept.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DealsBoard } from "@/components/deals-board";
import { DEFAULT_STAGES, FIRST_PIPELINE_ID, type Deal, type Pipeline } from "@/lib/crm-rules";
import { done, is, part } from "./check";

const coaching: Pipeline = { id: "coach0", name: "Coaching", stages: [{ id: "cnew00", name: "Intro call", kind: "open" }, { id: "cwon00", name: "Signed", kind: "won" }, { id: "clost0", name: "Passed", kind: "lost" }] };
const pipelines: Pipeline[] = [{ id: FIRST_PIPELINE_ID, name: "Sales", stages: DEFAULT_STAGES }, coaching];
const deal = (id: string, stage: string, cents: number, email = ""): Deal => ({ id, title: "Deal " + id, email, cents, stage, note: "", createdAt: 100, updatedAt: 200 });
const deals = [deal("d000000001", "lead00", 150000, "dana@example.com"), deal("d000000002", "won000", 40000), deal("d000000003", "cnew00", 99900)];
const props = { deals, stages: pipelines.flatMap((p) => p.stages), pipelines, pipelineMax: 5, fields: [], currency: "usd", assignees: ["owner@example.com"], today: "2026-10-17", requestHref: "/studio/requests?store=s1" };

part("Pipelines on the board");
const html = renderToStaticMarkup(createElement(DealsBoard, props));
is("a tab for each pipeline, the first chosen", html.includes('aria-pressed="true"') && html.includes("Sales") && html.includes("Coaching"), true);
is("each pipeline's totals, open, won and lost, in the store's currency", html.includes("1 · $1,500") && html.includes("1 · $400") && html.includes("1 · $999"), true);
is("totals say they are recorded values, nothing forecast", html.includes("Nothing is weighted or forecast"), true);
is("the store's number is shown", html.includes("You have 2 of the 5 pipelines your store can keep"), true);
is("a deal moves to a stage of any pipeline", html.includes('<optgroup label="Coaching">') && html.includes("Intro call"), true);
is("only the chosen pipeline's deals are on its board", html.includes("Deal d000000001") && !html.includes("Deal d000000003"), true);
is("a deal with a person still links to a payment request, filled in", html.includes("/studio/requests?store=s1&amp;email=dana%40example.com&amp;for=Deal+d000000001&amp;amount=1500"), true);
is("a new pipeline can be added below the plan's number", html.includes("New pipeline"), true);
is("the alert region is always there, empty and visually hidden without an error, so a message put in it is announced", html.includes('class="sr-only" role="alert"></p>'), true);
// Drawn only after a refused save (state the server render cannot reach), so read from the source (635 [GL3], review round 2).
const boardSource = readFileSync("components/deals-board.tsx", "utf8");
is("\"Use this\" keeps its visible words in its name, with the part it is for read after them (2.5.3)", [boardSource.includes('Use this<span className="sr-only">{` for ${label}`}</span>'), boardSource.includes("Use what is saved now for")], [true, false]);
is("taking what is saved moves focus to that part and says so in a status region (2.4.3, 4.1.3)", [boardSource.includes("focusLater(taken.focus)"), boardSource.includes('<p className="sr-only" role="status">{said}</p>')], [true, true]);
is("each field in conflict points to the words of what is saved now (aria-describedby)", ["title", "email", "value", "stage", "nextAction", "dueDate", "assignee", "note"].every((f) => boardSource.includes(`id={dealFieldId("${f}")} aria-describedby={describedBy("${f}")}`)), true);
is("a card's stage select sends a move only on Enter or when it is left, never on each change (3.2.5)", [boardSource.includes('onChange={(e) => stageEvent(deal, { kind: "change", value: e.target.value })}'), boardSource.includes('onBlur={() => stageEvent(deal, { kind: "blur" })}'), boardSource.includes('onChange={(e) => void run({ action: "deal"')], [true, true, false]);
const full = renderToStaticMarkup(createElement(DealsBoard, { ...props, pipelineMax: 2 }));
is("and not at it", full.includes("New pipeline"), false);
const one = renderToStaticMarkup(createElement(DealsBoard, { ...props, pipelines: undefined, stages: DEFAULT_STAGES, deals: deals.slice(0, 2), pipelineMax: 1 }));
is("a store with the one board it always had sees no optgroups", one.includes("<optgroup"), false);
done();
