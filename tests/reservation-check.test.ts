import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { agentOfBranch, allReservations, conflicts, lanePrefixes, ownerOfReservationFile, pullRequestInputs, report, reservations } from "../scripts/reservation-check.mjs";

const sample = `Lanes (who owns which subjects):

| Agent | Branch prefix | Lane |
| --- | --- | --- |
| Codex (ChatGPT) | codex/ | Money |
| Claude 1 | claude/ | Coordination |
| Claude 2 | claude2/ | Group A |
| Claude 3 | claude3/ | 631 [AA1] |

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 3 | 631 [AA1] | claude3/aa1-x | \`lib/agent.ts\`, \`docs/codex-queue.md\` | 02/11/2026 |
| Claude 2 | 520 [LB1] | claude2/lb1-deposit | \`lib/call-deposit.ts\` and the deposit parts of \`lib/calls.ts\` | 02/11/2026 |
`;

test("each branch belongs to the agent with the longest matching prefix", () => {
  const lanes = lanePrefixes(sample);
  assert.equal(agentOfBranch("claude2/lb1-deposit", lanes), "claude 2");
  assert.equal(agentOfBranch("claude3/aa1-x", lanes), "claude 3");
  assert.equal(agentOfBranch("claude/reservation-check", lanes), "claude 1");
  assert.equal(agentOfBranch("codex/tx3", lanes), "codex");
  assert.equal(agentOfBranch("dependabot/npm", lanes), null);
});

test("a file reserved by another agent fails, partial reservations included", () => {
  const { found } = conflicts({ text: sample, branch: "claude3/aa1-y", changed: ["lib/calls.ts", "lib/agent.ts"] });
  assert.deepEqual(found.map((r: { file: string }) => r.file), ["lib/calls.ts"]);
  const codex = conflicts({ text: sample, branch: "codex/x", changed: ["lib/agent.ts", "lib/call-deposit.ts"] });
  assert.equal(codex.found.length, 2);
});

test("own reservations, shared queue files and unknown branches pass", () => {
  assert.equal(conflicts({ text: sample, branch: "claude2/lb1-more", changed: ["lib/calls.ts", "lib/call-deposit.ts"] }).found.length, 0);
  assert.equal(conflicts({ text: sample, branch: "claude2/q", changed: ["docs/codex-queue.md", "docs/reservations.md"] }).found.length, 0);
  assert.equal(conflicts({ text: sample, branch: "owner-fix", changed: ["lib/agent.ts"] }).found.length, 0);
});

// Since 02/11/2026 (inbox C3-7): each agent's rows in its own file, edited only by that agent.
const own = (agent: string, rows: string) => `# Reservations of ${agent}\n\n## Reservations before code\n\n| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |\n| --- | --- | --- | --- | --- |\n${rows}`;
const lanesOnly = sample.split("## Reservations before code")[0];
const files = [
  { path: "docs/reservations/claude3.md", text: own("Claude 3", "| Claude 3 | 619 [SZ3] | claude3/sz3 | `lib/person-copy.ts` | 02/11/2026 |\n") },
  // A row whose first cell names someone else is still the file owner's.
  { path: "docs/reservations/claude2.md", text: own("Claude 2", "| Claude 3 | 520 [LB1] | claude2/lb1 | `lib/calls.ts` | 02/11/2026 |\n") },
  { path: "docs/reservations/stranger.md", text: own("Nobody", "| Nobody | x | x | `lib/free.ts` | 02/11/2026 |\n") },
];

test("each agent's own file: its rows are that agent's, a file of no lane counts for nothing", () => {
  const lanes = lanePrefixes(lanesOnly);
  assert.equal(ownerOfReservationFile("docs/reservations/claude2.md", lanes), "claude 2");
  assert.equal(ownerOfReservationFile("docs/reservations/codex.md", lanes), "codex");
  assert.equal(ownerOfReservationFile("docs/reservations/stranger.md", lanes), null);
  assert.equal(ownerOfReservationFile("docs/reservations.md", lanes), null);
  assert.deepEqual(allReservations(lanesOnly, files).map((r: { agent: string; file: string }) => [r.agent, r.file]), [["claude 3", "lib/person-copy.ts"], ["claude 2", "lib/calls.ts"]]);
});

test("a file reserved in another agent's own file fails; one's own passes", () => {
  assert.deepEqual(conflicts({ text: lanesOnly, branch: "claude2/x", changed: ["lib/person-copy.ts", "lib/calls.ts"], agentFiles: files }).found.map((r: { file: string }) => r.file), ["lib/person-copy.ts"]);
  assert.equal(conflicts({ text: lanesOnly, branch: "claude3/y", changed: ["lib/person-copy.ts", "lib/free.ts"], agentFiles: files }).found.length, 0);
});

test("changing another agent's reservations file fails; one's own, a new one and the shared files pass", () => {
  const theirs = conflicts({ text: lanesOnly, branch: "claude3/y", changed: ["docs/reservations/claude2.md"], agentFiles: files });
  assert.deepEqual(theirs.found.map((r: { agent: string; file: string }) => [r.agent, r.file]), [["claude 2", "docs/reservations/claude2.md"]]);
  assert.match(report(theirs, "claude3/y", 1).lines[0], /only claude 2 edits it/);
  assert.equal(conflicts({ text: lanesOnly, branch: "claude3/y", changed: ["docs/reservations/claude3.md", "docs/reservations.md", "docs/codex-queue.md"], agentFiles: files }).found.length, 0);
  // Not on the base branch yet: the PR that moves the rows into their files may make it.
  assert.equal(conflicts({ text: lanesOnly, branch: "claude3/y", changed: ["docs/reservations/codex.md"], agentFiles: files }).found.length, 0);
});

test("a generated file never blocks, even when a row names it (inbox C3-13)", () => {
  const reserved = [{ path: "docs/reservations/claude3.md", text: own("Claude 3", "| Claude 3 | x | claude3/x | `docs/accessibility-inventory.json` | 02/11/2026 |\n") }];
  assert.equal(conflicts({ text: lanesOnly, branch: "claude2/y", changed: ["docs/accessibility-inventory.json"], agentFiles: reserved }).found.length, 0);
});

test("the agent coverage table never blocks: each agent adds the rows of its own routes (inbox C3-14)", () => {
  const reserved = [{ path: "docs/reservations/claude3.md", text: own("Claude 3", "| Claude 3 | x | claude3/x | `lib/agent-coverage.ts` | 02/11/2026 |\n") }];
  assert.equal(conflicts({ text: lanesOnly, branch: "codex/shipped", changed: ["lib/agent-coverage.ts"], agentFiles: reserved }).found.length, 0);
});

test("the privacy policy never blocks: each agent adds only its own unit's sentences (inbox C3-37)", () => {
  const reserved = [{ path: "docs/reservations/claude2.md", text: own("Claude 2", "| Claude 2 | x | claude2/x | `app/privacy/page.tsx` | 04/11/2026 |\n") }];
  assert.equal(conflicts({ text: lanesOnly, branch: "claude3/y", changed: ["app/privacy/page.tsx"], agentFiles: reserved }).found.length, 0);
});

test("the cost and test registries never block: each agent adds its own rows (inbox CX-29)", () => {
  const reserved = [{ path: "docs/reservations/claude2.md", text: own("Claude 2", "| Claude 2 | x | claude2/x | `tests/plan-cost-registry.ts`, `tests/test-config.mjs` | 04/11/2026 |\n") }];
  assert.equal(conflicts({ text: lanesOnly, branch: "codex/mail", changed: ["tests/plan-cost-registry.ts", "tests/test-config.mjs"], agentFiles: reserved }).found.length, 0);
});

test("the old table is still read while it exists", () => {
  assert.deepEqual(conflicts({ text: sample, branch: "claude3/y", changed: ["lib/call-deposit.ts"], agentFiles: files }).found.map((r: { agent: string }) => r.agent), ["claude 2"]);
});

test("the real reservations files parse: one per lane, rows name exact paths", () => {
  const text = readFileSync("docs/reservations.md", "utf8");
  const lanes = lanePrefixes(text);
  const real = readdirSync("docs/reservations").filter((n: string) => n.endsWith(".md")).map((n: string) => ({ path: `docs/reservations/${n}`, text: readFileSync(`docs/reservations/${n}`, "utf8") }));
  assert.deepEqual(real.map((f: { path: string }) => ownerOfReservationFile(f.path, lanes)).sort(), ["claude 1", "claude 2", "claude 3", "codex"]);
  for (const r of allReservations(text, real)) assert.match(r.file, /^[\w.\[\]\/-]+$/, r.file);
});

test("the real reservations file parses: every lane has a prefix and rows name exact paths", () => {
  const text = readFileSync("docs/reservations.md", "utf8");
  const lanes = lanePrefixes(text);
  for (const prefix of ["codex/", "claude/", "claude2/", "claude3/"]) assert.ok(lanes.some((l: { prefix: string }) => l.prefix === prefix), prefix);
  for (const r of reservations(text)) assert.match(r.file, /^[\w.\[\]\/-]+$/, r.file);
});

// The real check: on a pull request (GitHub sets GITHUB_HEAD_REF), the files this PR changes
// against its base must not include a file another agent reserved on the base branch.
test("this pull request changes no file another agent reserved", { skip: !process.env.GITHUB_HEAD_REF }, () => {
  const branch = process.env.GITHUB_HEAD_REF!;
  const { text, changed } = pullRequestInputs((args: string[]) => execFileSync("git", args, { encoding: "utf8" }));
  const result = report(conflicts({ text, branch, changed }), branch, changed.length);
  assert.ok(result.ok, result.lines.join("\n"));
});
