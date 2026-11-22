/**
 * The MEDIUM on #4164 (Claude 1 cloud, 12/11/2026, twice): the deal editor's closing question was never cleared when
 * the editor closed or another deal was opened, and it was drawn on any deal whose chosen stage equalled the stage
 * asked about. So: edit deal A, set Won, press Save (the question), press Cancel; then edit deal B, already in Won:
 * the editor opened saying "Close "B" as won? It moves to Won..." though nothing changed and Save was never pressed
 * (WCAG 3.2.5, 3.3.6). The question now names the deal it was asked for, stands only while that deal still has
 * that stage chosen and the stage still differs from the saved one, and is cleared whenever the editor closes or
 * opens another deal (lib/deal-close.ts editorQuestionStands, components/deals-board.tsx).
 */
import { readFileSync } from "node:fs";
import * as dealClose from "@/lib/deal-close";
import { done, is, part } from "./check";

type Question = { id: string; stage: string } | null;
type Draft = { id: string; stage: string; base: { stage: string } };
const stands = (dealClose as unknown as { editorQuestionStands?: (question: Question, draft: Draft | null) => boolean }).editorQuestionStands;
const ask = (question: Question, draft: Draft | null) => (typeof stands === "function" ? stands(question, draft) : "missing");

part("When the editor's closing question stands");
const a = { id: "dealaaaa01", stage: "won", base: { stage: "new" } };
is("asked for deal A, A still moved to that stage: it stands", ask({ id: "dealaaaa01", stage: "won" }, a), true);
is("asked for deal A, deal B open in the editor, already in that stage: it does not", ask({ id: "dealaaaa01", stage: "won" }, { id: "dealbbbb02", stage: "won", base: { stage: "won" } }), false);
is("asked for deal A, deal B moved to that same stage before any Save: it does not", ask({ id: "dealaaaa01", stage: "won" }, { id: "dealbbbb02", stage: "won", base: { stage: "new" } }), false);
is("A's stage set back to the saved one: it does not", ask({ id: "dealaaaa01", stage: "won" }, { ...a, stage: "new" }), false);
is("A moved on to another stage: it does not", ask({ id: "dealaaaa01", stage: "won" }, { ...a, stage: "lost" }), false);
is("a deal whose saved stage is the one asked about: it does not", ask({ id: "dealaaaa01", stage: "won" }, { ...a, base: { stage: "won" } }), false);
is("no question, or no deal open: it does not", [ask(null, a), ask({ id: "dealaaaa01", stage: "won" }, null)], [false, false]);
is("a new deal (no id) is never asked", ask({ id: "", stage: "won" }, { id: "", stage: "won", base: { stage: "new" } }), false);

part("In the board: the question names its deal and is cleared when the editor closes or opens a deal");
const board = readFileSync("components/deals-board.tsx", "utf8");
const body = (name: string) => {
  const at = board.indexOf(`const ${name} = `);
  return at >= 0 ? board.slice(at, board.indexOf("\n  const ", at + 10)) : "";
};
is("it is kept with the deal it was asked for", /setSaveClosing\(\{ id: opened\.id, stage: opened\.stage \}\)/.test(board), true);
is("it is drawn only through the same rule", board.includes("{editorQuestionStands(saveClosing, draft) ? ("), true);
is("closing the editor clears it", /setSaveClosing\(null\)/.test(body("closeDeal")), true);
is("opening a deal (clearMessages) clears it", /setSaveClosing\(null\)/.test(body("clearMessages")), true);
done();
