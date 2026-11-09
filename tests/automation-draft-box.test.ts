/**
 * The studio's box for a workflow drafted from a goal (20 [E3],
 * components/automation-draft.tsx), drawn as the server draws it. What is
 * checked: the box is there only where the writing help is on and the
 * person may save workflows; a draft is shown whole before anything is
 * saved, step by step in the code's own words, every email readable; the
 * two choices are plain buttons a finger or a keyboard can reach; and the
 * Email page draws it under the same permission the save needs.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationDraftBox, DraftReview } from "@/components/automation-draft";
import type { AutomationDraftValue } from "@/lib/automation-draft";
import { done, is } from "./check";

const value: AutomationDraftValue = {
  draft: {
    name: "Course checkout reminder",
    trigger: "abandoned",
    productId: "prodcourse01",
    tag: null,
    goal: { productId: "prodcourse01" },
    steps: [
      { kind: "email", waitDays: 1, subject: "Still thinking?", body: "It is here when you are ready.\n\nAda" },
      { kind: "tag", waitDays: 2, label: "warm" },
    ],
  },
  titles: { prodcourse01: "Weeknight Course" },
};

const off = renderToStaticMarkup(createElement(AutomationDraftBox, { ai: { on: false, left: 0 } }));
is("nothing is drawn where the writing help is off", off, "");

const box = renderToStaticMarkup(createElement(AutomationDraftBox, { ai: { on: true, left: 7 } }));
is("a titled region, its title a heading", [/<section aria-labelledby="automation-draft-title"/.test(box), /<h2 id="automation-draft-title"[^>]*>Start a workflow from a goal<\/h2>/.test(box)], [true, true]);
is("it says what happens before anything is asked", [box.includes("saved paused"), box.includes("nothing is sent until you switch it on")], [true, true]);
is("the writing help's own box asks for the goal", box.includes("Draft a workflow with AI"), true);
is("a polite status region is there before anything is said in it", /role="status" aria-live="polite"/.test(box), true);

const review = renderToStaticMarkup(createElement(DraftReview, { value, busy: false, onSave: () => {}, onDiscard: () => {} }));
is("the draft is named, then explained step by step in an ordered list", [
  /<h3[^>]*>Course checkout reminder<\/h3>/.test(review),
  review.includes("<ol"),
  review.includes("Starts when someone leaves the checkout for “Weeknight Course” without paying, after agreeing to hear from you."),
  review.includes("Step 2, 2 days after the step before: gives the label “warm”."),
  review.includes("Saved paused: nothing is sent until you switch it on."),
], [true, true, true, true, true]);
is("every email can be read whole before saving, its subject naming it", [/<details[^>]*><summary[^>]*>Read the email “Still thinking\?”<\/summary>/.test(review), review.includes("It is here when you are ready.\n\nAda")], [true, true]);
const buttons = review.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];
is("two plain buttons: save paused, or discard", buttons.map((b) => b.replace(/<[^>]+>/g, "")), ["Save it, paused", "Discard this draft"]);
is("each a real button of at least 44 pixels", buttons.every((b) => b.includes('type="button"') && b.includes("min-h-11")), true);
const busy = renderToStaticMarkup(createElement(DraftReview, { value, busy: true, onSave: () => {}, onDiscard: () => {} }));
is("while it saves, saving says so and cannot be pressed twice", [busy.includes("Saving…"), /<button[^>]*disabled=""[^>]*aria-busy="true"/.test(busy)], [true, true]);

const page = readFileSync("app/studio/email/page.tsx", "utf8");
is("the Email page draws it only for those who may save workflows", /can\(role, "send"\) \? \(\s*<AutomationDraftBox/.test(page), true);
done();
