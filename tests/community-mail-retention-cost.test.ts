/**
 * The community announcement's recipients are costed for as long as they are kept (Codex L-20261121-0743, #5010 row
 * 21): lib/community-mail.ts keeps a send's job and its recipient list (nl:cm:mail:<job>, nl:cm:mail:<job>:to) for
 * 60 days, and the data-room cost of that family (tests/store-data-registry.ts) took 30. The stored cost was half the
 * worst case, and an unknown or understated cost is never taken as covered.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FAMILIES } from "./store-data-registry";

/** Every expiry lib/community-mail.ts writes on the job and its recipients, in days. */
function keptDays(): number[] {
  const code = readFileSync("lib/community-mail.ts", "utf8");
  const days = [...code.matchAll(/(?:"EX", |"EXPIRE", toKey\(job\.id\), )(\d+) \* 86_400/g)].map((match) => Number(match[1]));
  assert.ok(days.length >= 2, "the job's SET EX and the recipients' EXPIRE are both read");
  return days;
}

test("a send's recipients are costed for the whole time they are kept", () => {
  const family = FAMILIES["nl:cm:mail:@lib/community-mail.ts"];
  assert.ok(family && "parts" in family && family.parts, "the family is in the registry with its parts");
  const costed = Math.min(...family.parts.map((part) => ("days" in part ? part.days : Infinity)));
  assert.ok(costed >= Math.max(...keptDays()), `costed ${costed} days, kept ${Math.max(...keptDays())}`);
});

test("and the registry's words say the same number of days", () => {
  const family = FAMILIES["nl:cm:mail:@lib/community-mail.ts"];
  const words = family && "parts" in family && family.parts ? family.parts.map((part) => part.what).join(" ") : "";
  assert.match(words, /sixty days/);
});
