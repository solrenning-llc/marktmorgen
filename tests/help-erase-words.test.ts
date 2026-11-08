/**
 * The help center's answer on deleting a person (lib/help-content.ts) names
 * every kind of record the store's own deletion email (lib/erasure-request.ts)
 * says is deleted, so the two never disagree (inbox C2-74, 4 November 2026:
 * the answer had left out the team's tasks about the person).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HELP_SECTIONS } from "@/lib/help-content";

test("the answer on deleting a person names everything the deletion email says is deleted", () => {
  const email = readFileSync("lib/erasure-request.ts", "utf8");
  const line = /"Deleted: ([^"]+?)\. Your store will not email them again/.exec(email);
  assert.ok(line, "the deletion email's list of what is deleted was not found");
  const kinds = line[1].replace(/\band /g, "").split(/,\s*/).map((kind) => kind.trim()).filter(Boolean);
  const answer = HELP_SECTIONS.flatMap((section) => section.items)
    .find((item) => item.q === "Someone asked me to delete their data. What do I do?");
  assert.ok(answer, "the help center has no answer on deleting a person");
  const text = answer.a.join(" ");
  const said = (kind: string) => kind.split(" ").filter((w) => w.length > 3 && !["about", "them", "your", "their", "team's"].includes(w)).every((w) => text.includes(w));
  assert.deepEqual(kinds.filter((kind) => !said(kind)), []);
  assert.match(text, /your team's tasks about them/);
});
