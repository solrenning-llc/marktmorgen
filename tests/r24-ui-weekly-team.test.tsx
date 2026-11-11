/**
 * VR 2, rule 24: who gets the weekly email is shown only when read (components/weekly-team-picker.tsx;
 * app/studio/page.tsx). Before: a failed read of weeklyTeam became [], so every member showed unchecked; ticking one
 * then saved only that one, dropping everyone who really got the email, and said "Saved.". Now the page hands null
 * and the picker says it could not read who gets it, with no box to tick. A known list still shows its boxes.
 *
 * Real component, rendered on the server.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WeeklyTeamPicker } from "@/components/weekly-team-picker";

const members = ["ana@example.com", "ben@example.com"];
const render = (chosen: string[] | null) => renderToStaticMarkup(createElement(WeeklyTeamPicker, { members, chosen: chosen as never }));
const UNREAD = /We could not read who gets the weekly email just now\./;

test("who gets it not read: said in words, no box to tick", () => {
  let html = "";
  assert.doesNotThrow(() => (html = render(null)));
  assert.match(html, UNREAD);
  assert.doesNotMatch(html, /type="checkbox"/);
});

test("a known list still shows its boxes, the chosen ones checked", () => {
  const html = render(["ben@example.com"]);
  assert.doesNotMatch(html, UNREAD);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
  assert.equal((html.match(/checked=""/g) ?? []).length, 1);
});

test("the page hands null on a failed read, never an empty list", async () => {
  const source = (await import("node:fs")).readFileSync("app/studio/page.tsx", "utf8");
  assert.doesNotMatch(source, /weeklyTeam\(store\.handle\)\.catch\(\(\) => \[\]\)/);
});
