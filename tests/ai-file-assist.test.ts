/**
 * What the creator sees of the file written with AI (758 [STN5], unit 3;
 * components/ai-file-assist.tsx), held to 756 [STN3] and AX274: the text is
 * shown under the "AI draft" badge and its three checks, with the warning
 * about health, money or the law and every number the creator did not give
 * marked "Estimate"; the PDF is made only once all three are checked; every
 * box has a visible label and every button is at least 44 by 44 pixels; a
 * part that started and did not come back is said apart from one never
 * started; and nothing moves.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { AiFileReview, finalStates } from "@/components/ai-file-assist";
import { AI_DRAFT_BADGE, ESTIMATE_BADGE } from "@/lib/ai-draft-review";
import { done, is, part } from "./check";

const draft = {
  title: "Better Sleep",
  sections: [
    { title: "Start here", body: "Most adults need 8 hours of sleep.\n\nKeep the room dark." },
    { title: "Week one", body: "Go to bed at the same time. Good sleep helps your health." },
  ],
};
const draw = (checks: boolean[], missing: string[] = []) =>
  renderToStaticMarkup(
    createElement(AiFileReview, { draft, given: "A guide to sleep for new parents.", checks, missing, saving: false, onToggle: () => {}, onEdit: () => {}, onSave: () => {} }),
  );
const saveButton = (html: string) => /<button[^>]*>Make the PDF[^<]*<\/button>/.exec(html)?.[0] ?? "";

function main(): void {
  part("The text, under the AI draft checks");
  const fresh = draw([false, false, false], ["Week two"]);
  is("the badge, drawn by the page", fresh.includes(AI_DRAFT_BADGE), true);
  is("the three checks, none checked yet", (fresh.match(/type="checkbox"/g) ?? []).length === 3 && !/checked=""/.test(fresh), true);
  is("each part in a box with its own visible label", (fresh.match(/<label[^>]*for="[^"]+"[^>]*>Part \d: /g) ?? []).length, 2);
  is("the warning about health", fresh.includes("This draft is about health."), true);
  is("a number the creator did not give is marked as an estimate", fresh.includes(ESTIMATE_BADGE) && fresh.includes(">8<"), true);
  is("a part that did not come back is said", fresh.includes("These parts did not come back and are not in the file: Week two."), true);

  part("The PDF is made only once all three are checked");
  is("not before", /disabled=""/.test(saveButton(fresh)), true);
  is("it says why", fresh.includes("Check the three boxes under it, then save."), true);
  const checked = draw([true, true, true]);
  is("then it can be made", /disabled=""/.test(saveButton(checked)), false);
  is("and says the product stays a draft", checked.includes("The product stays a draft. You publish it when you are ready."), true);
  is("the button is at least 44 by 44 pixels", [/min-h-11/.test(saveButton(checked)), /min-w-11/.test(saveButton(checked))], [true, true]);

  part("After a run");
  is(
    "a part that started and did not come back, apart from one never started",
    finalStates(["section-1", "section-2", "section-3"], { "section-1": "done", "section-2": "running" }),
    { "section-1": "done", "section-2": "unfinished", "section-3": "skipped" },
  );

  part("Source checks");
  const source = readFileSync("components/ai-file-assist.tsx", "utf8");
  is("nothing animates", /\banimate-/.test(source), false);
  is("every button is at least 44 by 44 pixels", (source.match(/<button[\s\S]*?className="([^"]*)"/g) ?? []).every((b) => /min-h-11/.test(b)), true);
  is("it posts only to its own route and the writing help's stop", (source.match(/fetch\("([^"]+)"/g) ?? []).sort(), ['fetch("/api/store/ai"', 'fetch("/api/store/ai-file"'].sort());
  is("it says what the PDF holds and that nothing is published", source.includes("The PDF has headings and paragraphs only: no lists, pictures or links. Nothing is published."), true);

  done();
}

main();
