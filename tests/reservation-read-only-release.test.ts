import test from "node:test";
import assert from "node:assert/strict";
import { conflicts, pullRequestInputs, READ_ONLY_AGENTS, report } from "../scripts/reservation-check.mjs";

// Owner decision, 13/11/2026 (Fortaleza): Codex only reads the repository since 12/11/2026, so the rows
// in docs/reservations/codex.md can never be removed by Codex itself. The coordinator (Claude 2) may
// remove rows from that file, and only remove them; everything else about the check stays as it was.

const lanes = `Lanes (who owns which subjects):

| Agent | Branch prefix | Lane |
| --- | --- | --- |
| Codex (ChatGPT) | codex/ | Money |
| Claude 1 | claude/ | Coordination |
| Claude 2 | claude2/ | Group A |
| Claude 3 | claude3/ | 631 [AA1] |
`;
const own = (agent: string, rows: string) => `# Reservations of ${agent}\n\n## Reservations before code\n\n| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |\n| --- | --- | --- | --- | --- |\n${rows}`;
const stale = "| Codex A | merged unit | codex/a-done | `lib/mail.ts` | 05/11/2026 |\n";
const live = "| Codex B | open unit | codex/b-open | `lib/orders.ts` | 06/11/2026 |\n";
const base = [
  { path: "docs/reservations/codex.md", text: own("Codex", stale + live) },
  { path: "docs/reservations/claude3.md", text: own("Claude 3", "| Claude 3 | x | claude3/x | `lib/quiz.ts` | 02/11/2026 |\n") },
];
const headCodex = (rows: string) => ({ "docs/reservations/codex.md": own("Codex", rows) });

test("Codex is the read-only agent and Claude 2 is the one who may release its rows", () => {
  assert.equal(READ_ONLY_AGENTS.get("codex"), "claude 2");
  assert.equal(READ_ONLY_AGENTS.size, 1);
});

test("the coordinator may remove rows from the read-only agent's file, and the released file no longer blocks it", () => {
  const result = conflicts({ text: lanes, branch: "claude2/release", changed: ["docs/reservations/codex.md", "lib/mail.ts"], agentFiles: base, headFiles: headCodex(live) });
  assert.deepEqual(result.found, []);
  assert.ok(report(result, "claude2/release", 2).ok);
});

test("a row the coordinator keeps still blocks the coordinator", () => {
  const found = conflicts({ text: lanes, branch: "claude2/release", changed: ["docs/reservations/codex.md", "lib/orders.ts"], agentFiles: base, headFiles: headCodex(live) }).found;
  assert.deepEqual(found.map((r: { file: string }) => r.file), ["lib/orders.ts"]);
});

test("a released row still blocks every other agent until the removal is on the base branch", () => {
  const found = conflicts({ text: lanes, branch: "claude3/y", changed: ["lib/mail.ts"], agentFiles: base, headFiles: {} }).found;
  assert.deepEqual(found.map((r: { file: string }) => r.file), ["lib/mail.ts"]);
});

test("the coordinator may not add or change a row in the read-only agent's file", () => {
  const added = conflicts({ text: lanes, branch: "claude2/release", changed: ["docs/reservations/codex.md"], agentFiles: base, headFiles: headCodex(stale + live + "| Codex C | new | codex/c | `lib/free.ts` | 13/11/2026 |\n") }).found;
  assert.deepEqual(added.map((r: { file: string }) => r.file), ["docs/reservations/codex.md"]);
  const changed = conflicts({ text: lanes, branch: "claude2/release", changed: ["docs/reservations/codex.md"], agentFiles: base, headFiles: headCodex(live.replace("lib/orders.ts", "lib/free.ts")) }).found;
  assert.deepEqual(changed.map((r: { file: string }) => r.file), ["docs/reservations/codex.md"]);
});

test("the coordinator may not delete the read-only agent's whole file", () => {
  const found = conflicts({ text: lanes, branch: "claude2/release", changed: ["docs/reservations/codex.md"], agentFiles: base, headFiles: { "docs/reservations/codex.md": null } }).found;
  assert.deepEqual(found.map((r: { file: string }) => r.file), ["docs/reservations/codex.md"]);
});

test("no one else may remove the read-only agent's rows", () => {
  const found = conflicts({ text: lanes, branch: "claude3/y", changed: ["docs/reservations/codex.md", "lib/mail.ts"], agentFiles: base, headFiles: headCodex(live) }).found;
  assert.deepEqual(found.map((r: { file: string }) => r.file).sort(), ["docs/reservations/codex.md", "lib/mail.ts"]);
});

test("the coordinator may not remove rows of an agent that still writes", () => {
  const found = conflicts({ text: lanes, branch: "claude2/release", changed: ["docs/reservations/claude3.md", "lib/quiz.ts"], agentFiles: base, headFiles: { "docs/reservations/claude3.md": own("Claude 3", "") } }).found;
  assert.deepEqual(found.map((r: { file: string }) => r.file).sort(), ["docs/reservations/claude3.md", "lib/quiz.ts"]);
});

test("without the head's text the check keeps refusing, as before", () => {
  const found = conflicts({ text: lanes, branch: "claude2/release", changed: ["docs/reservations/codex.md", "lib/mail.ts"], agentFiles: base }).found;
  assert.deepEqual(found.map((r: { file: string }) => r.file).sort(), ["docs/reservations/codex.md", "lib/mail.ts"]);
});

test("the CI inputs carry the head's text of each changed reservations file, and null for a deleted one", () => {
  const baseId = "1".repeat(40);
  const shown: Record<string, string> = {
    [`${baseId}:docs/reservations.md`]: lanes,
    [`${baseId}:docs/reservations/codex.md`]: base[0].text,
    [`${baseId}:docs/reservations/claude3.md`]: base[1].text,
    "HEAD:docs/reservations/codex.md": own("Codex", live),
  };
  const git = (args: string[]) => {
    if (args[0] === "cat-file" && args[1] === "-p") return `tree ${"2".repeat(40)}\nparent ${baseId}\nparent ${"3".repeat(40)}\n`;
    if (args[0] === "cat-file" && args[1] === "-e") return "";
    if (args[0] === "show") { if (!(args[1] in shown)) throw new Error(`no ${args[1]}`); return shown[args[1]]; }
    if (args[0] === "diff") return "docs/reservations/codex.md\ndocs/reservations/claude3.md\nlib/mail.ts\n";
    if (args[0] === "ls-tree") return "docs/reservations/codex.md\ndocs/reservations/claude3.md";
    throw new Error(args.join(" "));
  };
  const inputs = pullRequestInputs(git);
  assert.deepEqual(inputs.headFiles, { "docs/reservations/codex.md": own("Codex", live), "docs/reservations/claude3.md": null });
});
