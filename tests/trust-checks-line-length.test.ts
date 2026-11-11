import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * WCAG 2.2 1.4.8 Visual Presentation, AAA (274 [AX1]): the paragraphs of the
 * trust block (components/trust-checks.tsx, on the topic pages and /pricing)
 * are no wider than 80 characters a line.
 *
 * Found by a browser audit (11 November 2026, Chromium, a local build of main
 * 7b04206e) on /platform/courses and /platform/your-stripe at 1280 px: "Your
 * work stays yours..." ran 89 characters a line (its max-w-3xl is 48rem) and
 * "Paid plans and paid selling remain subject..." 136. Both are now at most
 * 46ch, as the other notes are.
 */
const source = readFileSync("components/trust-checks.tsx", "utf8");
const classOf = (words: string): string => {
  const at = source.indexOf(words);
  assert.ok(at > 0, words);
  const open = source.lastIndexOf("<p ", at);
  return /className="([^"]*)"/.exec(source.slice(open, at))?.[1] ?? "";
};
const cap = (cls: string) => Number(/(?:^|\s)max-w-\[(\d+)ch\](?:\s|$)/.exec(cls)?.[1] ?? 999);

test("the block's lead is at most 46ch", () => {
  assert.ok(cap(classOf("Your work stays yours.")) <= 46, classOf("Your work stays yours."));
});

test("the closing note is at most 46ch", () => {
  assert.ok(cap(classOf("Paid plans and paid selling remain")) <= 46, classOf("Paid plans and paid selling remain"));
});
