import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const queue = readFileSync("docs/codex-queue.md", "utf8");
const entries = [...queue.matchAll(/^(6(?:4[6-9]|[5-8][0-9]|9[0-2]))\. \[WG\d+\] ([^\n]+)$/gm)].map((match) => ({
  number: Number(match[1]),
  title: match[2],
}));

assert.equal(entries.length, 47, "the reviewed Whop block must contain exactly items 646 through 692");
assert.deepEqual(entries.map((entry) => entry.number), Array.from({ length: 47 }, (_, index) => 646 + index));

const duplicateComplements = entries.filter((entry) => /\(complemento de \d+/.test(entry.title));
assert.deepEqual(
  duplicateComplements,
  [],
  "a complement must be folded into the existing lower-numbered item under AGENTS.md 'Pedidos repetidos'; it cannot receive a new queue number",
);
