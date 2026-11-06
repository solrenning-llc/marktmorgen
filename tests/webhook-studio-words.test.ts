/**
 * The studio's and the public page's words about replacing a webhook secret
 * and sending a failed delivery again (378 [TB4] unit 2) say what the code
 * does: "for a day" is ROTATION_HOURS, "about forty hours" is the retry
 * schedule, and the buttons call the route's own actions, the irreversible
 * one behind a confirmation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { RETRY_MINUTES, ROTATION_HOURS } from "@/lib/webhooks";
import { FEATURE_PAGES } from "@/lib/feature-pages";

const editor = readFileSync("components/webhook-editor.tsx", "utf8");
const page = JSON.stringify(FEATURE_PAGES);

test("the words match the figures", () => {
  assert.equal(ROTATION_HOURS, 24, "the studio and the public page say the old secret signs \"for a day\"");
  assert.match(editor, /keeps signing beside it for a day/);
  assert.match(page, /keeps signing beside it for a day/);
  const hours = RETRY_MINUTES.reduce((sum, m) => sum + m, 0) / 60;
  assert.ok(hours >= 38 && hours <= 42, `"about forty hours" is ${hours.toFixed(1)}`);
  assert.match(page, /about forty hours/);
});

test("the buttons call the route's actions; a new secret asks first", () => {
  assert.match(editor, /action: "rotate", id/);
  assert.match(editor, /action: "resend", delivery: id/);
  assert.match(editor, /<ConfirmAction[\s\S]{0,300}question="Make a new signing secret\?/);
  // Only a failed delivery, never a test, offers it; its name says which one (2.4.9).
  assert.match(editor, /d\.state === "failed" && d\.type !== "test"/);
  // The accessible name starts with the visible words (2.5.3).
  assert.match(editor, /aria-label=\{`Send again: /);
  // Not on a copy, and not again while the last resend did not fail.
  assert.match(editor, /!d\.resentFrom && \(!d\.resentAs \|\| view\.log\.find\(\(x\) => x\.id === d\.resentAs\)\?\.state === "failed"\)/);
  assert.match(editor, /accept a message when any/);
});
