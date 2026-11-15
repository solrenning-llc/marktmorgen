/**
 * Key families may be kept one file per topic (C2-213, variant B1): lib/data-families/<topic>.ts, listed by the
 * generated lib/data-families/index.ts and joined, when lib/data-families.ts loads, to its four lists, whose own
 * lines stay where they are. This fails when the index is stale (run node scripts/data-families-index.mjs), when a
 * family sits in a file whose name is not its topic, when a family is twice in one part (in two topic files, or in a
 * topic file and in lib/data-families.ts both), or when a topic's entries are not in the public lists.
 * The folder may hold no topic yet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INDEX_FILE, indexSource, topicFiles, topicOf } from "../scripts/data-families-index.mjs";
import { ALL_TOPICS } from "@/lib/data-families/index";
import { CLOSING, COUNTED_FAMILIES, ELSEWHERE_FAMILIES, FOLLOWED_FAMILIES, closingOf, countedInRoom } from "@/lib/data-families";
import type { TopicFamilies } from "@/lib/data-family-kinds";

const root = process.cwd();
const files: string[] = topicFiles(root);
const PARTS = ["counted", "elsewhere", "closing", "followed"] as const;
const namesOf = (topic: TopicFamilies, part: (typeof PARTS)[number]): string[] =>
  part === "closing" ? Object.keys(topic.closing ?? {}) : [...(topic[part] ?? [])];

test("the index is the generator's output for the topic files in the folder (none is fine)", () => {
  const have = readFileSync(join(root, INDEX_FILE), "utf8");
  assert.equal(have, indexSource(files), "run node scripts/data-families-index.mjs");
  assert.equal(ALL_TOPICS.length, files.length);
});

test("an empty folder makes an index with no topic", () => {
  const empty = indexSource([]);
  assert.match(empty, /export const ALL_TOPICS: readonly TopicFamilies\[\] = \[\n\];/);
  assert.doesNotMatch(empty, /from "\.\//);
});

test("the topic files' names are topics, and each family sits in its topic's file, one entry a line", () => {
  for (const name of files) assert.match(name, /^[a-z0-9-]+$/, `lib/data-families/${name}.ts: a topic file is named [a-z0-9-]`);
  const misplaced: string[] = [];
  ALL_TOPICS.forEach((topic, i) => {
    for (const part of PARTS) for (const family of namesOf(topic, part)) if (topicOf(family) !== files[i]) misplaced.push(`${family} (${part}) is in ${files[i]}.ts, its topic is ${topicOf(family)}`);
  });
  assert.deepEqual(misplaced, [], "move each to lib/data-families/<its topic>.ts");
  for (const name of files) {
    for (const line of readFileSync(join(root, "lib/data-families", `${name}.ts`), "utf8").split("\n")) {
      const m = /^\s*"(nl:[^"]*)"\s*[:,]/.exec(line);
      if (m) assert.equal(topicOf(m[1]), name, `${m[1]} is written in ${name}.ts`);
      else assert.ok(!/^\s*"nl:/.test(line), `${name}.ts: one entry a line: ${line.trim()}`);
    }
  }
});

test("no family is twice in a public list, nor both counted and elsewhere", () => {
  const twice = (list: readonly string[]) => list.filter((family, i) => list.indexOf(family) !== i);
  assert.deepEqual(twice(COUNTED_FAMILIES), [], "a family in a topic file and in lib/data-families.ts both, or twice");
  assert.deepEqual(twice(ELSEWHERE_FAMILIES), []);
  assert.deepEqual(twice([...FOLLOWED_FAMILIES]), []);
  const closingNames = ALL_TOPICS.flatMap((topic) => namesOf(topic, "closing"));
  assert.deepEqual(twice(closingNames), [], "a closing rule in two topic files");
  const counted = new Set(COUNTED_FAMILIES);
  assert.deepEqual(ELSEWHERE_FAMILIES.filter((family) => counted.has(family)), [], "a family is counted in the room or bounded elsewhere, never both");
});

test("every topic's entries are in the public lists, and the functions read them", () => {
  for (const topic of ALL_TOPICS) {
    for (const family of topic.counted ?? []) assert.ok(COUNTED_FAMILIES.includes(family) && countedInRoom(`${family}x`), family);
    for (const family of topic.elsewhere ?? []) assert.ok(ELSEWHERE_FAMILIES.includes(family), family);
    for (const family of topic.followed ?? []) assert.ok((FOLLOWED_FAMILIES as readonly string[]).includes(family), family);
    for (const [family, rule] of Object.entries(topic.closing ?? {})) {
      assert.equal(CLOSING[family], rule, family);
      assert.equal(closingOf(`${family}x`), rule, family);
    }
  }
});
