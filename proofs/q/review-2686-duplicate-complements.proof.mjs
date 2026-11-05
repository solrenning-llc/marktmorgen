import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const queue = readFileSync("docs/codex-queue.md", "utf8");
const entries = [...queue.matchAll(/^(6(?:4[6-9]|5[0-9]|6[01]))\. \[WG\d+\] ([^\n]+)$/gm)].map((match) => ({
  number: Number(match[1]),
  title: match[2],
}));

assert.equal(entries.length, 16, "the corrected Whop block must contain exactly the 16 genuinely new items 646 through 661");
assert.deepEqual(entries.map((entry) => entry.number), Array.from({ length: 16 }, (_, index) => 646 + index));

const duplicateComplements = entries.filter((entry) => /\(complemento de \d+/.test(entry.title));
assert.deepEqual(
  duplicateComplements,
  [],
  "a complement must be folded into the existing lower-numbered item under AGENTS.md 'Pedidos repetidos'; it cannot receive a new queue number",
);

const folded = queue.match(/^Complemento WG \(05\/11\/2026,[^\n]+$/gm) ?? [];
assert.equal(folded.length, 25, "the 31 requests must be folded into their 25 existing destination items");
assert.deepEqual(
  folded.map((line) => Number(/\(estende (\d+)/.exec(line)?.[1])).sort((a, b) => a - b),
  [6, 36, 45, 257, 274, 281, 347, 378, 379, 399, 449, 451, 484, 486, 487, 491, 549, 567, 598, 603, 604, 616, 617, 624, 626],
  "each folded paragraph must sit in the destination named by its former numbered item",
);
assert.equal(folded.filter((line) => /\(a\).*\(b\).*\(c\).*\(d\).*\(e\)/.test(line)).length, 1, "item 616 keeps its five subparts in one complement");
assert.equal(folded.filter((line) => /\(a\).*\(b\).*\(c\)/.test(line)).length >= 2, true, "item 274 keeps its three subparts in one complement");

const emptyState = queue.slice(queue.indexOf("656. [WG16]"), queue.indexOf("657. [WG17]"));
assert.match(emptyState, /CI[^\n]*desconhecid[oa][^\n]*nunca zero/, "the empty-state item must say its CI cost is unknown, never zero");
