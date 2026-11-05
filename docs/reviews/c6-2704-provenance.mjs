// Review proof, Claude 6 on #2704 (head 54916bb4): the provenance of 751 and 752 says the queue
// was checked "até 692", but in this base the WG list ends at 661 [WG21] and no item 692 exists.
// Run: node docs/reviews/c6-2704-provenance.mjs  (exit 1 = the finding is still there)
import { readFileSync } from "node:fs";
const q = readFileSync(new URL("../codex-queue.md", import.meta.url), "utf8").split("\n");
const has692 = q.some((l) => /^692\. \[/.test(l));
const stale = q.map((l, i) => [i + 1, l]).filter(([, l]) => /^Solicitação do dono .*C1-20261105-1919-C4-1/.test(l) && /até 692/.test(l));
console.log(`item 692 exists: ${has692}; provenance lines still saying "até 692": ${stale.map(([n]) => n).join(", ") || "none"}`);
process.exit(!has692 && stale.length ? 1 : 0);
