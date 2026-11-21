/**
 * Every AI draft says it is one, and the creator checks it before it is saved
 * (756 [STN3], unit 1).
 *
 * The writing box (components/ai-assist.tsx) shows, under every draft it
 * fills in, an "AI draft" badge in words and a checklist of three things the
 * creator confirms: the facts, any picture, the price and numbers
 * (components/ai-draft-review.tsx, rules in lib/ai-draft-review.ts). The
 * product form keeps its Save and Add waiting until all three are checked and
 * says why, with the focus on the first one left. Nothing here calls a model,
 * reads or writes anything.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AI_DRAFT_BADGE, AI_DRAFT_CHECKS, AI_DRAFT_HOLD, aiDraftHold, firstUnchecked, freshChecks, reviewDone } from "@/lib/ai-draft-review";
import { AiDraftReview } from "@/components/ai-draft-review";
import { done, is, part } from "./check";

part("The rules");
is("three checks: facts, picture, price", AI_DRAFT_CHECKS.map((check) => check.id), ["facts", "picture", "price"]);
is("a fresh draft starts with none checked", freshChecks(), [false, false, false]);
is("two of three is not done", reviewDone([true, true, false]), false);
is("all three is done", reviewDone([true, true, true]), true);
is("a list of the wrong length is never done", [reviewDone([true, true]), reviewDone([true, true, true, true])], [false, false]);
is("the first one left", [firstUnchecked([true, false, false]), firstUnchecked([true, true, true])], [1, -1]);
is("no draft waiting: nothing held", aiDraftHold(null), null);
is("a draft waiting and not checked: held, with the sentence", aiDraftHold([true, false, true]), AI_DRAFT_HOLD);
is("a draft waiting and checked: not held", aiDraftHold([true, true, true]), null);
is("the hold says what to do in plain words", AI_DRAFT_HOLD, "This has an AI draft you have not checked yet. Check the three boxes under it, then save.");

part("Drawn under a draft");
const html = renderToStaticMarkup(createElement(AiDraftReview, { checks: [true, false, false], onToggle: () => {} }));
is("the badge in words, not by color alone", html.includes(`>${AI_DRAFT_BADGE}<`), true);
is("one group with a legend", [html.includes("<fieldset"), html.includes("<legend")], [true, true]);
is("a checkbox per check, each with its words", [(html.match(/type="checkbox"/g) ?? []).length, AI_DRAFT_CHECKS.every((check) => html.includes(check.label))], [3, true]);
is("what is checked is shown checked", (html.match(/checked=""/g) ?? []).length, 1);
is("a marker the form uses to find the first one left", html.includes("data-ai-review"), true);
is("each box sits in a 44 px row", (html.match(/min-h-11/g) ?? []).length >= 3, true);
const all = renderToStaticMarkup(createElement(AiDraftReview, { checks: [true, true, true], onToggle: () => {} }));
is("all checked: it says so", all.includes("Checked. You can save it."), true);

part("Where it is used");
const assist = readFileSync("components/ai-assist.tsx", "utf8");
is("the writing box draws it under every draft it fills", assist.includes("<AiDraftReview"), true);
is("each new draft starts unchecked", assist.includes("setChecks(freshChecks())"), true);
is("it tells the page whether the draft is checked", assist.includes("onReviewChange?.(reviewDone(next))") && assist.includes("onReviewChange?.(false)"), true);
const editor = readFileSync("components/product-editor.tsx", "utf8");
is("the product form holds Save and Add while a draft is unchecked", editor.includes("const aiHold = aiDraftHold(ideaChecks) ?? aiDraftHold(describeChecks);") && editor.includes("const held = aiHold;"), true);
is("and moves the focus to the first one left", editor.includes('querySelector<HTMLInputElement>("[data-ai-review] input:not(:checked)")') && editor.includes("requestAnimationFrame(() => first?.focus())"), true);
// Review of 63153488 (Claude 6), MEDIUM 1: a failed second draft hid the boxes and kept the hold.
is("the boxes stay drawn for the draft still in the fields", [assist.includes("{drafted ? ("), assist.includes("{filled ? (\n          <AiDraftReview")], [true, false]);
is("only a new confirmed draft marks one, and nothing unmarks it", [assist.includes("setDrafted(true)"), assist.includes("setDrafted(false)")], [true, false]);
// MEDIUM 2: on the edit path, "Yes, save what buyers pay" saved an unchecked AI draft.
is("the form has an id the price review submits", editor.includes("id={`product-form-${id}`}"), true);
is("Yes, save what buyers pay submits that form, through the same hold", editor.includes('type="submit" form={`product-form-${product.id}`}'), true);
is("and no longer saves around it", /onClick=\{save\}>\s*Yes, save what buyers pay/.test(editor.slice(editor.indexOf("product-${product.id}-price-review-title"))), false);
// LOW 3: a closed AI box took the focus nowhere.
is("the hold opens the closed AI box before moving the focus", editor.includes('first?.closest("details")') && editor.includes("box.open = true"), true);
is("the product form follows the box", editor.includes("onReviewChange={(checked) => setDescribeChecks(checked ? [true, true, true] : freshChecks())}"), true);

done();
