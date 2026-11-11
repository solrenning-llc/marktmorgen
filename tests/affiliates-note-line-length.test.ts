import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * WCAG 2.2 1.4.8 Visual Presentation, AAA (274 [AX1]): the note under the
 * affiliate program's application form (app/[handle]/affiliates/page.tsx) is
 * no wider than 80 characters a line.
 *
 * Found by a browser audit (11 November 2026, Chromium, a synthetic store, a
 * local build of main 7b04206e): "No password. The link confirms the address
 * is yours..." ran 87 characters a line at 1280 px. It is now at most 46ch,
 * as the other buyer notes are; 46ch kept every such note under 80 at 320,
 * 768 and 1280 px and with 1.4.12 text spacing.
 */
const page = readFileSync("app/[handle]/affiliates/page.tsx", "utf8");

test("the application form's note is at most 46ch wide", () => {
  const m = /<p className="([^"]*)">\{a\.formNote\}<\/p>/.exec(page);
  assert.ok(m, "the note is drawn");
  const cap = /(?:^|\s)max-w-\[(\d+)ch\](?:\s|$)/.exec(m![1]);
  assert.ok(cap && Number(cap[1]) <= 46, m![1]);
});
