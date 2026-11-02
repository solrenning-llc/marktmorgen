import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { agentOfBranch, conflicts, lanePrefixes, pullRequestInputs, report, reservations } from "../scripts/reservation-check.mjs";

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
