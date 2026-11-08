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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { aiLeft } from "@/lib/ai";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { StoreSetupAi } from "@/components/store-setup-ai";
import { StudioHelp } from "@/components/studio-help";
import { AiAssist, AiOn } from "@/components/ai-assist";
import { AiPosts } from "@/components/ai-posts";
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
// The buttons that start an AI job: their opening tag and their words.
const writeButtons = (html: string) =>
  [...html.matchAll(/<button\b([^>]*)>((?:(?!<\/button>)[\s\S])*)<\/button>/g)]
    .filter((m) => /\b(Write|Draft|Ask)\b/.test(m[2].replace(/<[^>]+>/g, "")))
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

// Call sites still reading an unknown allowance as 0, each in another agent's open pull request or reservation
// when this test was written (AV5). The list may only shrink: a file that no longer has the line must leave it.
const PENDING = new Set([
  "app/studio/page.tsx",
  "app/studio/email/page.tsx",
  "app/studio/pages/page.tsx",
  "app/studio/site/page.tsx",
  "app/studio/funnels/page.tsx",
  "app/studio/outreach/page.tsx",
  "app/studio/course/[product]/page.tsx",
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
