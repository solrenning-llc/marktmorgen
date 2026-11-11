/**
 * VR item 2, rule 24: an AI allowance that cannot be read is said to be unknown, never "0 left this month".
 * lib/ai.ts aiLeft already throws UnknownReplyError on an unknown read; a page passes `null` for it, and every
 * component that shows the allowance says so in words, with its AI buttons off (the server still checks and
 * reserves before any model call). A known allowance still shows its number (control).
 * Real lib/ai.ts and real components; synthetic Redis that answers with error objects.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { aiLeft } from "@/lib/ai";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { StoreSetupAi } from "@/components/store-setup-ai";
import { StudioHelp } from "@/components/studio-help";
import { AiAssist, AiOn } from "@/components/ai-assist";
import { AiPosts } from "@/components/ai-posts";
import { BlockRewrite } from "@/components/block-rewrite";
import { PageCoach } from "@/components/page-coach";
import { TranslatePage } from "@/components/translate-page";
import type { PageBlock, SalesPage } from "@/lib/sales-page";
import { setUnknown } from "./vr2-ai-left-unknown-world";
import { paidPeriod } from "./billing-period-fixture";

const now = Date.UTC(2026, 10, 8, 9);
const fixture = { statsId: "vr2-ai", tier: "pro", period: paidPeriod(now) } as Store;
const UNKNOWN = /We could not check your AI allowance just now\. Reload the page in a minute to try again\./;
const SAYS_A_COUNT = /\b(0|null|NaN|undefined) (left|AI jobs left)/;
// What a page hands a component when aiLeft threw: null as a prop, or `known: false` in AiOn
// (the fix: `.catch(() => null)`; before it, `.catch(() => 0)` handed over a plain 0).
const unread = null;
type Shown = number | null;
// Typed loosely so this file also builds against main, where these props and AiOn take a number only.
const aiOnValue = (left: Shown) => (left === null ? { on: true, left: 0, known: false } : { on: true, left }) as never;
const prop = (left: Shown) => left as never;

const assist = (left: Shown) =>
  renderToStaticMarkup(createElement(AiOn.Provider, { value: aiOnValue(left) },
    createElement(AiAssist, { title: "Write it for me", hint: "h", placeholder: "p", payload: () => ({}), onResult: () => {}, done: "d" })));
const posts = (left: Shown) =>
  renderToStaticMarkup(createElement(AiOn.Provider, { value: aiOnValue(left) }, createElement(AiPosts, { url: "https://example.test", what: "store" })));
const setupBox = (left: Shown) => renderToStaticMarkup(createElement(StoreSetupAi, { currency: "usd", left: prop(left), hasFaq: false, storeName: "Demo" }));
const helpBox = (left: Shown) => renderToStaticMarkup(createElement(StudioHelp, { left: prop(left) }));
// A button's words without its inner tags: the text after each tag's closing ">", for comparing words only.
const wordsOf = (html: string) =>
  html
    .split("<")
    .map((part, i) => (i === 0 ? part : part.slice(part.indexOf(">") + 1)))
    .join("");
// The buttons that start an AI job: their opening tag and their words.
const writeButtons = (html: string) =>
  [...html.matchAll(/<button\b([^>]*)>((?:(?!<\/button>)[\s\S])*)<\/button>/g)]
    .filter((m) => /\b(Write|Draft|Ask)\b/.test(wordsOf(m[2])))
    .map((m) => m[1]);
const describedByUnknown = (html: string, tag: string) => {
  const id = tag.match(/aria-describedby="([^"]+)"/)?.[1];
  return Boolean(id) && new RegExp(`id="${id}"[^>]*>${UNKNOWN.source}`).test(html);
};

test("premise: the lib says the balance is unknown (it throws), as rule 24 asks", async () => {
  setUnknown(true);
  await assert.rejects(aiLeft(fixture, now), UnknownReplyError);
});

test("an unread allowance is said in words in every component that shows it, never as a count", () => {
  const shown = {
    "store setup": setupBox(unread),
    "studio help": helpBox(unread),
    "writing help box": assist(unread),
    "social posts": posts(unread),
  };
  const failures: string[] = [];
  for (const [where, html] of Object.entries(shown)) {
    if (!UNKNOWN.test(html)) failures.push(`${where}: no "could not check" sentence`);
    if (SAYS_A_COUNT.test(html)) failures.push(`${where}: says ${html.match(SAYS_A_COUNT)?.[0]}`);
  }
  console.log(`  ${Object.keys(shown).length - new Set(failures.map((f) => f.split(":")[0])).size}/${Object.keys(shown).length} components say an unread allowance truthfully`);
  assert.deepEqual(failures, []);
});

test("with an unread allowance the AI buttons that wait on it are off, and every AI button is tied to the sentence that says why", () => {
  // The writing box and the posts are off at 0 today, so an unread allowance keeps them off too (nothing is spent on a guess).
  const gated = [assist(unread), posts(unread)];
  let checked = 0;
  for (const html of gated) {
    const buttons = writeButtons(html);
    assert.equal(buttons.length, 1, html);
    for (const tag of buttons) {
      assert.match(tag, /disabled=""/, tag);
      assert.ok(describedByUnknown(html, tag), `${tag}: not described by the sentence`);
      checked++;
    }
  }
  // The store draft and the help question were never off at 0 (the server answers "used"): the server still checks first.
  for (const html of [setupBox(unread), helpBox(unread)]) {
    const buttons = writeButtons(html);
    assert.equal(buttons.length, 1, html);
    assert.ok(describedByUnknown(html, buttons[0]), `${buttons[0]}: not described by the sentence`);
    checked++;
  }
  console.log(`  ${checked} AI buttons checked`);
});

test("control: a known allowance still shows its number and leaves the buttons on", () => {
  assert.match(setupBox(7), /One draft counts once\. 7 left this month\./);
  assert.match(helpBox(5), /one of your 5 AI jobs left this month/);
  assert.doesNotMatch(setupBox(7) + helpBox(5), UNKNOWN);
  const box = assist(3);
  assert.match(box, /3 left this month\. Started attempts count, even if they fail\./);
  assert.doesNotMatch(box, UNKNOWN);
  assert.match(posts(4), /4 left this month\./);
  const on = [...writeButtons(box), ...writeButtons(posts(4))];
  assert.equal(on.length, 2);
  for (const tag of on) assert.doesNotMatch(tag, /disabled=""/, tag);
});

test("control: a spent allowance is still 0 left, with the buttons off", () => {
  const box = assist(0);
  assert.match(box, /0 left this month/);
  assert.doesNotMatch(box, UNKNOWN);
  const off = [...writeButtons(box), ...writeButtons(posts(0))];
  assert.equal(off.length, 2);
  for (const tag of off) assert.match(tag, /disabled=""/, tag);
});

// The three tools on the sales-page editor: rewrite one block, review the page, translate the page.
const textBlock = { id: "text0001", kind: "text", heading: "What it is", body: "A simple practice lesson." } as PageBlock;
const emptyBenefits = { id: "bene0001", kind: "benefits", heading: "", items: [] } as PageBlock;
const salesPage = { blocks: [textBlock], seoDescription: "", test: null } as unknown as SalesPage;
const inAi = (left: Shown, child: ReactNode) => renderToStaticMarkup(createElement(AiOn.Provider, { value: aiOnValue(left) }, child));
const rewrite = (left: Shown, block = textBlock) =>
  inAi(left, createElement(BlockRewrite, { productId: "vr2", block, page: () => salesPage, onChange: () => {} }));
const translate = (left: Shown) =>
  inAi(left, createElement(TranslatePage, { productId: "vr2", storeLanguage: "pt", page: () => salesPage, onResult: () => true }));
const coachProps = {
  productId: "vr2", productTitle: "Practice", free: true, picture: false, pictureAlt: "", facts: {}, page: salesPage, reach: null,
  onAdd: () => {}, onHeadline: () => {}, onTest: () => {}, onFit: () => {}, onQuestions: () => {},
} as Parameters<typeof PageCoach>[0];

// The page coach opens its writing help only when the creator presses "See what to improve". There is no DOM in
// these tests, so this harness runs PageCoach's own hooks with a minimal stand-in dispatcher, presses that button
// through the component's own onClick (its real setOpen), runs it again with the state that click left, and hands
// the opened tree to React's server renderer. Nothing in the component is patched or forced.
type Hooks = { H: unknown };
const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: Hooks })
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
type Node = ReactElement<{ children?: unknown; onClick?: () => void; "aria-expanded"?: boolean }>;
const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join("") : typeof node === "string" || typeof node === "number" ? String(node)
    : React.isValidElement(node) ? textOf((node as Node).props.children) : "";
const findButton = (node: unknown, words: string): Node | undefined => {
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findButton(child, words); if (hit) return hit; }
    return undefined;
  }
  if (!React.isValidElement(node)) return undefined;
  const element = node as Node;
  if (element.type === "button" && textOf(element.props.children) === words) return element;
  return findButton(element.props.children, words);
};
const coach = (left: Shown) => {
  const states: unknown[] = [];
  const run = () => {
    let at = 0;
    const before = internals.H;
    internals.H = {
      useContext: () => aiOnValue(left),
      useId: () => "vr2-coach-allowance",
      useState: (initial: unknown) => {
        const slot = at++;
        if (!(slot in states)) states[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial;
        return [states[slot], (next: unknown) => { states[slot] = typeof next === "function" ? (next as (was: unknown) => unknown)(states[slot]) : next; }];
      },
    };
    try { return (PageCoach as (props: typeof coachProps) => ReactElement)(coachProps); } finally { internals.H = before; }
  };
  const closed = run();
  const toggle = findButton(closed, "See what to improve");
  assert.ok(toggle, "the coach's own open button is drawn");
  assert.equal(toggle.props["aria-expanded"], false);
  assert.doesNotMatch(renderToStaticMarkup(closed), /Review my page/, "closed, the coach shows no AI job button");
  toggle.props.onClick?.();
  const opened = run();
  assert.equal(findButton(opened, "Hide")?.props["aria-expanded"], true, "the press opened it");
  return renderToStaticMarkup(opened);
};

// Each editor tool, with the words of the buttons that start one of its AI jobs.
const editorTools: [string, (left: Shown) => string, RegExp][] = [
  ["block rewrite", (left) => rewrite(left), /^(Clearer|Shorter|More specific|Warmer)$/],
  ["block draft", (left) => rewrite(left, emptyBenefits), /^Write it with AI$/],
  ["page coach", coach, /^Review my page$/],
  ["page translation", translate, /^Translate$/],
];
const jobButtons = (html: string, words: RegExp) =>
  [...html.matchAll(/<button\b([^>]*)>((?:(?!<\/button>)[\s\S])*)<\/button>/g)]
    .filter((m) => words.test(wordsOf(m[2]).trim()))
    .map((m) => m[1]);
const EXPECTED_BUTTONS: Record<string, number> = { "block rewrite": 4, "block draft": 1, "page coach": 1, "page translation": 1 };

test("editor tools: an unread allowance is said in words, every AI job button is off and tied to that sentence", () => {
  const failures: string[] = [];
  let checked = 0;
  for (const [where, render, words] of editorTools) {
    const html = render(unread);
    if (!UNKNOWN.test(html)) failures.push(`${where}: no "could not check" sentence`);
    if (SAYS_A_COUNT.test(html)) failures.push(`${where}: says ${html.match(SAYS_A_COUNT)?.[0]}`);
    const buttons = jobButtons(html, words);
    if (buttons.length !== EXPECTED_BUTTONS[where]) failures.push(`${where}: ${buttons.length} AI job buttons, expected ${EXPECTED_BUTTONS[where]}`);
    for (const tag of buttons) {
      checked++;
      if (!/disabled=""/.test(tag)) failures.push(`${where}: an AI job button is on: ${tag}`);
      if (!describedByUnknown(html, tag)) failures.push(`${where}: an AI job button is not described by the sentence: ${tag}`);
    }
  }
  console.log(`  ${editorTools.length} editor tools, ${checked} AI job buttons checked with an unread allowance`);
  assert.deepEqual(failures, []);
});

test("editor tools control: a known allowance shows its number, the buttons are on and still described by it", () => {
  for (const [where, render, words] of editorTools) {
    const html = render(9);
    assert.match(html, /9 left this month/, where);
    assert.doesNotMatch(html, UNKNOWN, where);
    const buttons = jobButtons(html, words);
    assert.equal(buttons.length, EXPECTED_BUTTONS[where], where);
    for (const tag of buttons) {
      assert.doesNotMatch(tag, /disabled=""/, `${where}: ${tag}`);
      const id = tag.match(/aria-describedby="([^"]+)"/)?.[1];
      assert.ok(id && new RegExp(`id="${id}"[^>]*>[^<]*9 left this month`).test(html), `${where}: ${tag}`);
    }
  }
});

test("editor tools control: a spent allowance is still 0 left, with every AI job button off", () => {
  for (const [where, render, words] of editorTools) {
    const html = render(0);
    assert.match(html, /0 left this month/, where);
    assert.doesNotMatch(html, UNKNOWN, where);
    const buttons = jobButtons(html, words);
    assert.equal(buttons.length, EXPECTED_BUTTONS[where], where);
    for (const tag of buttons) assert.match(tag, /disabled=""/, `${where}: ${tag}`);
  }
});

// Call sites still reading an unknown allowance as 0, each in another agent's open pull request or reservation
// when this test was written (AV5). The list may only shrink: a file that no longer has the line must leave it.
const PENDING = new Set([
  "app/studio/page.tsx",
  "app/studio/outreach/page.tsx",
  "app/api/store/numbers/ask/route.ts",
]);
const ZERO_ON_UNKNOWN = /aiLeft\([^)]*\)\.catch\(\(\) => 0\)/;
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });

test("no page reads an unknown allowance as 0 outside the pending list, and the list only shrinks", () => {
  const found = sources("app").filter((file) => ZERO_ON_UNKNOWN.test(readFileSync(file, "utf8")));
  const unexpected = found.filter((file) => !PENDING.has(file));
  const fixed = [...PENDING].filter((file) => !found.includes(file));
  console.log(`  ${found.length} call site(s) still turn an unknown allowance into 0; ${unexpected.length} outside the pending list`);
  assert.deepEqual(unexpected, [], "a page turns an unknown allowance into 0");
  assert.deepEqual(fixed, [], "fixed: remove these from PENDING");
});
