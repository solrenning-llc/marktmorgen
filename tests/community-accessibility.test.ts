import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * A store's community (app/[handle]/community/*, components/community-parts.tsx,
 * components/community-composer.tsx), held to WCAG 2.2 AAA where a browser
 * audit found it short (274 [AX1]; 11 November 2026, Chromium, a synthetic
 * store with its community on and one post, opened by its owner and signed
 * out, a local build of main 7b04206e):
 *
 * - 2.5.5: the community's name in the bar (.cm-home) was 40 px tall; the
 *   "You" tab 42 px wide; a post's title in the feed 26 px tall; the label of
 *   the composer's poll box 20 px tall. Each is now at least 44 px.
 * - 1.4.8: paragraphs on the feed, members, events, search, leaderboard and
 *   notifications pages ran 82 to 108 characters a line at 1280 px. Every
 *   paragraph after the community's bar (a notice box excepted) is now at most
 *   46ch: none over 80 in the browser, also with 1.4.12 text spacing.
 *
 * All from app/globals.css, so the components (open in several pull requests)
 * are not edited; the last test keeps the hooks honest.
 */
const css = readFileSync("app/globals.css", "utf8");
const body = (selector: string): string => {
  const at = css.indexOf("\n" + selector + " {");
  assert.ok(at >= 0, selector);
  return css.slice(at, css.indexOf("}", at));
};

test("2.5.5: the bar's name, the tabs, a post's title and the poll label are 44 px targets", () => {
  assert.match(body(".cm-home"), /min-height:\s*2\.75rem;/);
  assert.match(body(".cm-tab:where(*)"), /min-width:\s*2\.75rem;/);
  const title = body(".cm-post h2 > a.st-title-link");
  assert.match(title, /display:\s*inline-flex;/);
  assert.match(title, /min-height:\s*2\.75rem;/);
  assert.match(body('.st-page label:has(> input[name="poll"])'), /min-height:\s*2\.75rem;/);
});

test("1.4.8: the community's paragraphs are at most 46ch", () => {
  const cap = /max-width:\s*(\d+(?:\.\d+)?)ch;/.exec(body(".cm-bar ~ main p:not(.st-note)"));
  assert.ok(cap && Number(cap[1]) <= 46);
});

test("the hooks are still drawn by the components", () => {
  const parts = readFileSync("components/community-parts.tsx", "utf8");
  assert.match(parts, /<header className="cm-bar/);
  assert.match(parts, /className="cm-home /);
  assert.match(parts, /className="cm-tab"/);
  assert.match(parts, /cm-post /);
  assert.match(readFileSync("components/community-composer.tsx", "utf8"), /type="checkbox" name="poll"/);
});
