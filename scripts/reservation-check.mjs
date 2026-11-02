// Fails a pull request that changes a file another agent reserved in
// docs/reservations.md (owner, 02/11/2026: four agents, no conflicts; rule AV5).
// It reads only the repository: the PR branch name, the list of changed files
// and the reservations table. It changes nothing and needs no secret.
// In CI it runs inside `npm test` (tests/reservation-check.test.ts) on every
// pull request; locally: node scripts/reservation-check.mjs <branch> <base>.
import { execFileSync } from "node:child_process";

/** Files every agent edits through its own small docs PRs (see docs/reservations.md). */
export const SHARED_FILES = new Set(["docs/codex-queue.md", "docs/reservations.md"]);

const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const agentKey = (name) => name.replace(/\(.*?\)/g, "").trim().toLowerCase();

/** The rows of the first table after a heading line that starts with `heading`. */
function tableAfter(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) return [];
  const rows = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (line.trim().startsWith("|")) { inTable = true; rows.push(cells(line)); }
    else if (inTable) break;
  }
  return rows.slice(2); // header and separator
}

/** Branch prefix of each agent, from the "Lanes" table at the top of the file. */
export function lanePrefixes(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith("Lanes"));
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith("|")) rows.push(cells(line));
    else if (rows.length) break;
  }
  return rows.slice(2).map(([agent, prefix]) => ({ agent: agentKey(agent), prefix: prefix.replace(/`/g, "").trim() })).filter((r) => r.prefix);
}

/** The agent that owns a branch, by the longest matching prefix; null when none does. */
export function agentOfBranch(branch, lanes) {
  const match = lanes.filter((l) => branch.startsWith(l.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return match ? match.agent : null;
}

/** Exact paths reserved in the "Reservations before code" table, with their agent. */
export function reservations(text) {
  return tableAfter(text, "## Reservations before code").flatMap((row) => {
    const agent = agentKey(row[0] || "");
    const files = [...(row[3] || "").matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    return files.map((file) => ({ agent, item: row[1] || "", file }));
  });
}

/** Changed files that another agent reserved. Empty means the PR may proceed. */
export function conflicts({ text, branch, changed }) {
  const lanes = lanePrefixes(text);
  const me = agentOfBranch(branch, lanes);
  if (!me) return { me, found: [] };
  const held = reservations(text).filter((r) => r.agent !== me && !SHARED_FILES.has(r.file));
  const found = changed.filter((f) => !SHARED_FILES.has(f)).flatMap((f) => held.filter((r) => r.file === f));
  return { me, found };
}

/** In a pull_request checkout (the merge commit), the PR's changed files and the base's reservations. */
export function pullRequestInputs(git) {
  // The merge commit's first parent is the base; fetch it when the checkout is shallow.
  try { git(["rev-parse", "--verify", "--quiet", "HEAD^1"]); }
  catch { git(["fetch", "--no-tags", "--quiet", "--deepen=1", "origin"]); }
  const text = git(["show", "HEAD^1:docs/reservations.md"]);
  const changed = git(["diff", "--name-only", "HEAD^1", "HEAD"]).split("\n").filter(Boolean);
  return { text, changed };
}

export function report({ me, found }, branch, changedCount) {
  if (!me) return { ok: true, lines: [`Branch ${branch} belongs to no agent lane; nothing to check.`] };
  if (!found.length) return { ok: true, lines: [`${me}: none of the ${changedCount} changed files is reserved by another agent.`] };
  return { ok: false, lines: found.map((r) => `${r.file} is reserved by ${r.agent} (${r.item}) in docs/reservations.md. Pick another unit or wait until that reservation is removed.`) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [branch, base] = process.argv.slice(2);
  const git = (args) => execFileSync("git", args, { encoding: "utf8" });
  // The reservations as they are on the base branch: a PR cannot clear another agent's row for itself.
  const text = git(["show", `${base}:docs/reservations.md`]);
  const changed = git(["diff", "--name-only", `${base}...HEAD`]).split("\n").filter(Boolean);
  const result = report(conflicts({ text, branch, changed }), branch, changed.length);
  for (const line of result.lines) console.log(line);
  process.exit(result.ok ? 0 : 1);
}
