import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * WCAG 2.2 1.4.8 Visual Presentation, AAA (274 [AX1]): no block of the
 * affiliate directory (/affiliate-programs) is wider than 80 characters.
 *
 * Found by a browser audit (11 November 2026, Chromium, a local build of main
 * 7b04206e) at 1280 px: the note on how programs are ordered (#order,
 * max-w-3xl) ran 115 characters a line and "Turn on your affiliate program in
 * your studio..." 119. Both are now at most 46ch (the centered note stays
 * centered with mx-auto): none over 80 at 768 or 1280 px, nor with 1.4.12 text
 * spacing.
 */
const page = readFileSync("app/affiliate-programs/page.tsx", "utf8");
const cap = (cls: string) => Number(/(?:^|\s)max-w-\[(\d+)ch\](?:\s|$)/.exec(cls)?.[1] ?? 999);

test("the ordering note is at most 46ch and still centered", () => {
  const cls = /<p className="([^"]*)" id="order">/.exec(page)?.[1] ?? "";
  assert.ok(cap(cls) <= 46, cls);
  assert.match(cls, /(^|\s)mx-auto(\s|$)/);
});

test("the note on joining the directory is at most 46ch", () => {
  const cls = /<p className="([^"]*)">Turn on your affiliate program/.exec(page)?.[1] ?? "";
  assert.ok(cap(cls) <= 46, cls);
});
