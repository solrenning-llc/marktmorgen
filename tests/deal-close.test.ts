/**
 * Closing a deal from the board asks first, and each column says how many
 * deals it holds (lib/deal-close.ts, components/deals-board.tsx; 553 [DB1]
 * unit 1, added 12 November 2026). Checked:
 *
 *   - only a move into a won or lost stage from another kind closes a deal;
 *     open to open, and won to another won stage, ask nothing;
 *   - the question names the deal, the stage and what counts, says when a
 *     sequence may start, and puts the safer button first;
 *   - the column header says "1 deal" / "2 deals" beside its total;
 *   - in the board, "Move" into a closing stage shows the question instead of
 *     moving, the stage stays chosen, Escape or "Keep it where it is" moves
 *     nothing and gives focus back to "Move", and "Close as won/lost" moves
 *     by the same write as any move; the question stands only while nothing
 *     changed under it.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { closeWords, closesDeal, dealCount } from "@/lib/deal-close";
import { DealsBoard } from "@/components/deals-board";
import { DEFAULT_STAGES, type Deal } from "@/lib/crm-rules";
import { done, is, part } from "./check";

part("What closes a deal");
is("open to won, open to lost, won to lost, lost to won", [closesDeal("open", "won"), closesDeal("open", "lost"), closesDeal("won", "lost"), closesDeal("lost", "won")], [true, true, true, true]);
is("open to open, won to won, lost to lost", [closesDeal("open", "open"), closesDeal("won", "won"), closesDeal("lost", "lost")], [false, false, false]);
is("a stage that is gone is not guessed to close it", [closesDeal("open", undefined), closesDeal(undefined, "open")], [false, false]);

part("The question");
{
  const won = closeWords({ kind: "won", title: "Acme retainer", stage: "Signed", amount: "$1,500.00" });
  is("names the deal and the kind", won.question, "Close “Acme retainer” as won?");
  is("says where it goes and what counts, and when a sequence may start", won.text, "It moves to Signed and its $1,500.00 counts as won. If a sequence you switched on starts at that stage, it starts for this deal's person when they are on your list and agreed to hear from you.");
  is("the buttons: the safer one, then the one that closes", [won.keep, won.close], ["Keep it where it is", "Close as won"]);
  const lost = closeWords({ kind: "lost", title: "Acme", stage: "Passed", amount: null });
  is("lost says it no longer counts as open", [lost.question, lost.text.startsWith("It moves to Passed and it counts as lost and no longer as open."), lost.close], ["Close “Acme” as lost?", true, "Close as lost"]);
  is("won without an amount", closeWords({ kind: "won", title: "X", stage: "Won", amount: null }).text.startsWith("It moves to Won and it counts as won."), true);
}

part("How many deals in a column");
is("in words", [dealCount(0), dealCount(1), dealCount(12), dealCount(1200)], ["0 deals", "1 deal", "12 deals", "1,200 deals"]);
{
  const deal = (id: string, stage: string, cents: number): Deal => ({ id, title: "Deal " + id, email: "", cents, stage, note: "", createdAt: 100, updatedAt: 200 });
  const html = renderToStaticMarkup(createElement(DealsBoard, { deals: [deal("d000000001", "lead00", 150000), deal("d000000002", "lead00", 5000)], stages: DEFAULT_STAGES, pipelineMax: 1, fields: [], currency: "usd", assignees: [], today: "2026-11-12" }));
  is("the column header says how many beside its total", /2 deals · \$1,550/.test(html), true);
  is("no closing question is drawn before anything is chosen", html.includes("deal-close-"), false);
}

part("In the board");
{
  const board = readFileSync("components/deals-board.tsx", "utf8");
  const event = board.slice(board.indexOf("function stageEvent"), board.indexOf("function removeDeal"));
  is("Move into a closing stage asks instead of moving", /if \(step\.commit && closesDeal\(kindOf\(deal\.stage\), kindOf\(step\.commit\)\)\) \{\s*setError\(null\);\s*setClosing\(\{ id: deal\.id, from: deal\.stage, to: step\.commit \}\);\s*moveFocus\(`deal-close-\$\{deal\.id\}`\);\s*return;\s*\}/.test(event), true);
  is("asking happens before the stage choice is cleared, so it stays chosen", event.indexOf("setClosing({ id: deal.id") < event.indexOf("setMoving(m =>"), true);
  is("the question stands only while the deal is where it was and that stage is still chosen", /const closingNow = closing && !blocked && view === "board" && pendingMoves\[closing\.id\] === closing\.to && deals\.some\(d => d\.id === closing\.id && d\.stage === closing\.from\) \? closing : null;/.test(board), true);
  const group = board.slice(board.indexOf("{closingNow?.id === deal.id && canChange ? ("), board.indexOf("{confirmingId === deal.id && canChange ? ("));
  is("a named group, with its text, that Escape leaves", [/role="group" tabIndex=\{-1\} aria-labelledby=\{`deal-close-\$\{deal\.id\}-title`\} aria-describedby=\{`deal-close-\$\{deal\.id\}-text`\}/.test(group), /e\.key === "Escape" && !locked\) keepOpen\(deal\.id\)/.test(group)], [true, true]);
  is("the safer button comes first", group.indexOf("deal-close-keep-") < group.indexOf("deal-close-yes-"), true);
  is("keeping it moves nothing and gives focus back to Move", /const keepOpen = \(id: string\) => \{ setClosing\(null\); focusLater\(`deal-move-\$\{id\}`\); \};/.test(board), true);
  is("closing moves it by the same write as any move", /function confirmClose\(deal: Deal, to: string\) \{[\s\S]*?setClosing\(null\);[\s\S]*?moveDeal\(deal, to\);/.test(board), true);
}

done();
