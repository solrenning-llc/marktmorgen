/**
 * A word taken from the address (`?link=`, `?status=`, `?n=`, `?cert=`, ...)
 * picks a notice only when it is one of the table's own keys. A bare index
 * reads Object's prototype too: "?link=constructor" finds Object's own
 * constructor, a function, so the course page received a function as its
 * notice, and a `??` chain stopped there instead of reaching its fallback.
 *
 * `ownEntry` (lib/own-entry.ts) reads only the table's own keys; the pages
 * below read their notice tables through it or through Object.hasOwn. The
 * `? T[query.x]` reads on the sign, pay and studio Discord pages (and the 20
 * other pages of that kind) are fixed in claude5/links-on-main
 * (tests/query-notice-own-keys.test.ts) and not repeated here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ownEntry } from "@/lib/own-entry";

const PROTOTYPE_WORDS = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"];

test("a bare index reaches the prototype", () => {
  assert.equal(typeof ({} as Record<string, unknown>)["constructor"], "function");
});

test("ownEntry reads only the table's own keys", () => {
  const table = { sent: "Sent", unsure: "Not sure" };
  for (const word of PROTOTYPE_WORDS) assert.equal(ownEntry(table, word), undefined, word);
  assert.equal(ownEntry(table, "sent"), "Sent");
  assert.equal(ownEntry(table, "unsure"), "Not sure");
  assert.equal(ownEntry(table, ""), undefined);
  assert.equal(ownEntry(table, undefined), undefined);
  assert.equal(ownEntry(table, ["sent"]), undefined, "a repeated query parameter is an array, never a key");
});

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...pages(path));
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

test("no page indexes a table with a word from its address without checking the table's own keys", () => {
  // `T[typeof query.n === "string" ? query.n : ""]`: the form that reached the prototype.
  const bare = /\[typeof [a-zA-Z]+\.[a-zA-Z]+ === "string" \? [a-zA-Z]+\.[a-zA-Z]+ : ""\]/;
  const left: string[] = [];
  for (const file of pages("app")) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (bare.test(line)) left.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(left, [], "bare reads left");
});

test("the library, affiliate and course pages read their notices from the table's own keys", () => {
  const bare: [string, RegExp][] = [
    ["app/library/page.tsx", /"string" \? STATUS\[query\.status\]/],
    ["app/affiliate/page.tsx", /"string" \? STATUS\[query\.status\]/],
    ["app/[handle]/course/[product]/page.tsx", /w\.linkNotices\[/],
    ["app/[handle]/course/[product]/page.tsx", /\)\[typeof query\.cert/],
    ["app/studio/page.tsx", /BILLING_ALIASES\[String\(params\.billing\)\]/],
  ];
  for (const [file, re] of bare) assert.doesNotMatch(readFileSync(file, "utf8"), re, `${file}: bare read left`);
});
