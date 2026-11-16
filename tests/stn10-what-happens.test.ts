/**
 * 763 [STN10] unit 1: before "Yes, cancel it" and once a plan is set to stop,
 * the creator reads what happens next, from the figures the closing job runs
 * on. The real JSX of each place is taken from the page source on every run
 * and rendered with synthetic props; no billing, session or provider.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { AfterCancel } from "@/components/after-cancel";
import { AFTER_CANCEL_TITLE, afterCancelWords } from "@/lib/plan-cancel-words";
import { BUYER_NOTICE_DAYS } from "@/lib/closing-buyers-rules";
import { CLOSING_DAYS, ERASE_WITHIN_DAYS, WARN_MONTH_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { closingLetter } from "@/lib/plan-closing";

type Found = { node: ts.Node; tree: ts.SourceFile };
const tag = (tree: ts.SourceFile, n: ts.Node) => (ts.isJsxElement(n) ? n.openingElement.tagName.getText(tree) : "");

function find(path: string, pick: (tree: ts.SourceFile, n: ts.Node) => boolean): Found[] {
  const source = readFileSync(path, "utf8");
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Found[] = [];
  const visit = (n: ts.Node) => {
    if (pick(tree, n)) out.push({ node: n, tree });
    ts.forEachChild(n, visit);
  };
  visit(tree);
  return out;
}

const cancelDetails = (tree: ts.SourceFile, n: ts.Node) =>
  ts.isJsxElement(n) && tag(tree, n) === "details" && n.children.some((c) => tag(tree, c) === "summary" && /Cancel the subscription/.test(c.getText(tree)));
const keepFragment = (tree: ts.SourceFile, n: ts.Node) =>
  ts.isJsxFragment(n) && /Keep my subscription/.test(n.getText(tree)) && /Canceled during the trial/.test(n.getText(tree));

/** Renders one extracted element with the page's names it reads, synthetic. */
function render({ node, tree }: Found, props: Record<string, unknown>): string {
  const code = `function Extracted({trialing=false,endsOn='Nov 30, 2026',closing=false,standing='paid'}){
    const may=()=>true; const can=()=>true; const pin=''; const store={sid:'synthetic-store',subscriptionId:'synthetic-subscription'};
    const refundLink=null; const view={role:'owner'};
    return <>${node.getText(tree)}</>;
  }`;
  const compiled = ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  const Extracted = new Function("React", "AfterCancel", compiled + "\nreturn Extracted;")(React, AfterCancel) as React.ComponentType<Record<string, unknown>>;
  return renderToStaticMarkup(React.createElement(Extracted, props));
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

test("the lines carry the closing job's own figures and the end date", () => {
  const lines = afterCancelWords("Nov 30, 2026", false).join(" ");
  assert.match(lines, /^On Nov 30, 2026, your plan ends and your checkout stops taking payments\./);
  assert.ok(lines.includes(`At least ${CLOSING_DAYS} days after that, your store closes.`));
  assert.ok(lines.includes(`We email you ${WARN_MONTH_DAYS} days and ${WARN_WEEK_DAYS} days before that day.`));
  assert.ok(lines.includes(`at least ${BUYER_NOTICE_DAYS} days before it`));
  assert.ok(lines.includes(`Within ${ERASE_WITHIN_DAYS} days, everything else it keeps with us is deleted`));
  assert.match(lines, /every membership and payment plan you sold through it ends/);
  assert.match(lines, /stay on your own Stripe account/);
  assert.match(lines, /Start a plan again before that day, and your store stays exactly as it is\./);
});

test("with no end date known, the lines name the period or the trial instead", () => {
  assert.match(afterCancelWords(null, false)[0], /^When the period you paid for ends, /);
  assert.match(afterCancelWords(null, true)[0], /^When the trial ends, /);
  for (const line of [...afterCancelWords(null, true), ...afterCancelWords(null, false)]) assert.doesNotMatch(line, /undefined|null|NaN/);
});

test("the lines promise nothing the closing notice does not say", () => {
  const lines = afterCancelWords("Nov 30, 2026", true).join(" ");
  // The notice says members are not charged again only once every hold is confirmed.
  assert.doesNotMatch(lines, /not charged again|never charged/i);
  // No offer, discount, urgency or refund promise on the way out.
  assert.doesNotMatch(lines, /discount|% off|free month|hurry|last chance|refund(ed)? (you|in full)/i);
  // The closing notice uses the same days, so the two never disagree.
  const letter = closingLetter("ended", "Synthetic", Date.UTC(2026, 10, 30), Date.UTC(2026, 11, 30), Date.UTC(2026, 10, 30)).text;
  assert.ok(letter.includes(`${CLOSING_DAYS} days after your plan ended, your store closes`));
  assert.ok(letter.includes(`within ${ERASE_WITHIN_DAYS} days`));
  assert.ok(letter.includes(`${WARN_MONTH_DAYS} days before that day and ${WARN_WEEK_DAYS} days before it`));
});

test("the studio's cancel confirmation says what happens next before the button", () => {
  const found = find("app/studio/page.tsx", cancelDetails).filter((f) => /Yes, cancel it/.test(f.node.getText(f.tree)));
  assert.equal(found.length, 1, "one cancel confirmation with its button");
  for (const trialing of [false, true]) {
    const html = render(found[0], { trialing });
    const words = text(html);
    assert.ok(words.includes(AFTER_CANCEL_TITLE), "the heading is shown");
    for (const line of afterCancelWords("Nov 30, 2026", trialing)) assert.ok(words.includes(line), `shows: ${line}`);
    assert.ok(html.indexOf(AFTER_CANCEL_TITLE) < html.indexOf("Yes, cancel it"), "read before the button");
    // Still one click: no extra form, field or required answer.
    assert.equal((html.match(/<form\b/g) ?? []).length, 1);
    assert.doesNotMatch(html, /\brequired(?:=|[\s>])/);
  }
});

test("once set to stop, the studio says what happens next beside Keep my subscription", () => {
  // The innermost fragment: the billing card's own fragments hold it too.
  const all = find("app/studio/page.tsx", keepFragment);
  const found = all.filter((f) => !all.some((g) => g !== f && g.node.pos >= f.node.pos && g.node.end <= f.node.end));
  assert.equal(found.length, 1, "one canceled state");
  for (const trialing of [false, true]) {
    const words = text(render(found[0], { trialing }));
    assert.ok(words.includes(AFTER_CANCEL_TITLE));
    for (const line of afterCancelWords("Nov 30, 2026", trialing)) assert.ok(words.includes(line), `shows: ${line}`);
    assert.match(words, /Keep my subscription/);
  }
});

test("the paused studio's cancel confirmation says it too, with no date it does not know", () => {
  const found = find("app/studio/paused/page.tsx", cancelDetails);
  assert.equal(found.length, 1, "one cancel confirmation on the paused page");
  const html = render(found[0], {});
  const words = text(html);
  for (const line of afterCancelWords(null, false)) assert.ok(words.includes(line), `shows: ${line}`);
  assert.ok(html.indexOf(AFTER_CANCEL_TITLE) < html.indexOf("Yes, cancel it"));
});

test("the list is a named list, so its length and its heading are announced", () => {
  const html = renderToStaticMarkup(React.createElement(AfterCancel, { endsOn: "Nov 30, 2026", trialing: false, id: "synthetic-next" }));
  assert.match(html, /<p id="synthetic-next"[^>]*>What happens next<\/p>/);
  assert.match(html, /<ul aria-labelledby="synthetic-next"/);
  assert.equal((html.match(/<li>/g) ?? []).length, afterCancelWords("Nov 30, 2026", false).length);
});
