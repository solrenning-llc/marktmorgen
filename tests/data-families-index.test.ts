/**
 * The key-family registry is split one file per topic (C2-213):
 * lib/data-families/<topic>.ts, read by lib/data-families.ts through the
 * generated lib/data-families/index.ts. This fails when the index is stale
 * (run node scripts/data-families-index.mjs), when a family sits in a file
 * whose name is not its topic, when a family is twice in one part or in two
 * files, or when the public lists are not exactly the topics' entries.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INDEX_FILE, indexSource, topicFiles, topicOf } from "../scripts/data-families-index.mjs";
import { ALL_TOPICS } from "@/lib/data-families/index";
import { CLOSING, COUNTED_FAMILIES, ELSEWHERE_FAMILIES, FOLLOWED_FAMILIES } from "@/lib/data-families";
import type { TopicFamilies } from "@/lib/data-family-kinds";

const root = process.cwd();
const files: string[] = topicFiles(root);
const PARTS = ["counted", "elsewhere", "closing", "followed"] as const;
const namesOf = (topic: TopicFamilies, part: (typeof PARTS)[number]): string[] =>
  part === "closing" ? Object.keys(topic.closing ?? {}) : [...(topic[part] ?? [])];

test("the index is the generator's output for the topic files in the folder", () => {
  const have = readFileSync(join(root, INDEX_FILE), "utf8");
  assert.equal(have, indexSource(files), "run node scripts/data-families-index.mjs");
  assert.equal(ALL_TOPICS.length, files.length);
});

test("the topic files' names are topics, and each family sits in its topic's file", () => {
  for (const name of files) assert.match(name, /^[a-z0-9-]+$/, `lib/data-families/${name}.ts: a topic file is named [a-z0-9-]`);
  const misplaced: string[] = [];
  ALL_TOPICS.forEach((topic, i) => {
    for (const part of PARTS) for (const family of namesOf(topic, part)) if (topicOf(family) !== files[i]) misplaced.push(`${family} (${part}) is in ${files[i]}.ts, its topic is ${topicOf(family)}`);
  });
  assert.deepEqual(misplaced, [], "move each to lib/data-families/<its topic>.ts");
  // The raw text agrees, one entry a line: each line that starts with a family is of the file's topic
  // (a family named inside a rule, as T("nl:erase:ix:", 7), may be another topic's).
  for (const name of files) {
    const lines = readFileSync(join(root, "lib/data-families", `${name}.ts`), "utf8").split("\n");
    for (const line of lines) {
      const m = /^\s*"(nl:[^"]*)"\s*[:,]/.exec(line);
      if (m) assert.equal(topicOf(m[1]), name, `${m[1]} is written in ${name}.ts`);
      else assert.ok(!/^\s*"nl:/.test(line), `${name}.ts: one entry a line: ${line.trim()}`);
    }
  }
});

test("no family is twice in a part, in two files, or both counted and elsewhere", () => {
  for (const part of PARTS) {
    const seen = new Map<string, string>();
    const twice: string[] = [];
    ALL_TOPICS.forEach((topic, i) => {
      for (const family of namesOf(topic, part)) {
        if (seen.has(family)) twice.push(`${family} (${part}): ${seen.get(family)}.ts and ${files[i]}.ts`);
        else seen.set(family, files[i]);
      }
    });
    assert.deepEqual(twice, [], `each family once in ${part}`);
  }
  const counted = new Set(COUNTED_FAMILIES);
  assert.deepEqual(ELSEWHERE_FAMILIES.filter((family) => counted.has(family)), [], "a family is counted in the room or bounded elsewhere, never both");
});

test("the public lists are exactly the topics' entries", () => {
  const all = (part: (typeof PARTS)[number]) => ALL_TOPICS.flatMap((topic) => namesOf(topic, part));
  assert.deepEqual([...COUNTED_FAMILIES], all("counted"));
  assert.deepEqual([...ELSEWHERE_FAMILIES], all("elsewhere"));
  assert.deepEqual([...FOLLOWED_FAMILIES], all("followed"));
  assert.deepEqual(Object.keys(CLOSING), all("closing"));
  for (const topic of ALL_TOPICS) for (const [family, rule] of Object.entries(topic.closing ?? {})) assert.equal(CLOSING[family], rule);
});
