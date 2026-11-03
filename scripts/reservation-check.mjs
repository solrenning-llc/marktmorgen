// Fails a pull request that changes a file another agent reserved, or another
// agent's own reservations file (owner, 02/11/2026: four agents, no conflicts;
// rule AV5). Since 02/11/2026 (inbox C3-7) each agent's rows live in its own
// file, docs/reservations/<agent>.md, edited only by that agent; the lanes stay
// in docs/reservations.md, whose old table is still read while it exists.
// It reads only the repository: the PR branch name, the list of changed files
// and the reservations. It changes nothing and needs no secret.
// In CI it runs inside `npm test` (tests/reservation-check.test.ts) on every
// pull request; locally: node scripts/reservation-check.mjs <branch> <base>.
import { execFileSync } from "node:child_process";

/** Files every agent edits through its own small docs PRs (see docs/reservations.md). */
export const SHARED_FILES = new Set(["docs/codex-queue.md", "docs/reservations.md"]);

/** The folder of each agent's own reservations file. */
export const RESERVATIONS_DIR = "docs/reservations/";

/** The file each agent keeps its rows in, by its key ("claude 2" → docs/reservations/claude2.md). */
export const reservationFileOf = (agent) => `${RESERVATIONS_DIR}${agent.replace(/\s+/g, "")}.md`;

/** The agent a reservations file belongs to, from its name; null for any other path. */
export function ownerOfReservationFile(path, lanes) {
  if (!path.startsWith(RESERVATIONS_DIR) || !path.endsWith(".md")) return null;
  return lanes.find((l) => reservationFileOf(l.agent) === path)?.agent ?? null;
}

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

/**
 * Exact paths reserved in the "Reservations before code" table of one file,
 * with their agent: the file's owner when it is an agent's own file (a row
 * there is that agent's, whatever its first cell says), else each row's.
 */
export function reservations(text, owner = null) {
  return tableAfter(text, "## Reservations before code").flatMap((row) => {
    const agent = owner ?? agentKey(row[0] || "");
    const files = [...(row[3] || "").matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    return files.map((file) => ({ agent, item: row[1] || "", file }));
  });
}

/** Every reservation: the old table in docs/reservations.md while it exists, then each agent's own file. */
export function allReservations(text, agentFiles = []) {
  const lanes = lanePrefixes(text);
  return [
    ...reservations(text),
    ...agentFiles.flatMap(({ path, text: own }) => {
      const owner = ownerOfReservationFile(path, lanes);
      return owner ? reservations(own, owner) : [];
    }),
  ];
}

/**
 * Changed files that another agent reserved, and other agents' reservations
 * files this PR changes. `agentFiles` are the reservations files as they are
 * on the base branch: a file that does not exist there yet may be made (so
 * moving the rows into their files could be done in one PR). Empty means the
 * PR may proceed.
 */
export function conflicts({ text, branch, changed, agentFiles = [] }) {
  const lanes = lanePrefixes(text);
  const me = agentOfBranch(branch, lanes);
  if (!me) return { me, found: [] };
  const held = allReservations(text, agentFiles).filter((r) => r.agent !== me && !SHARED_FILES.has(r.file));
  const found = changed.filter((f) => !SHARED_FILES.has(f)).flatMap((f) => held.filter((r) => r.file === f));
  const existing = new Set(agentFiles.map((f) => f.path));
  for (const path of changed) {
    const owner = ownerOfReservationFile(path, lanes);
    if (owner && owner !== me && existing.has(path)) found.push({ agent: owner, item: "its own reservations file", file: path });
  }
  return { me, found };
}

/** The agents' reservations files as they are at `rev`, read through `git`. */
export function agentFilesAt(git, rev) {
  let names = [];
  try {
    names = git(["ls-tree", "--name-only", rev, RESERVATIONS_DIR]).split("\n").filter((n) => n.endsWith(".md"));
  } catch {
    names = [];
  }
  return names.map((path) => ({ path, text: git(["show", `${rev}:${path}`]) }));
}

/** In a pull_request checkout (the merge commit), the PR's changed files and the base's reservations. */
export function pullRequestInputs(git) {
  // The merge commit's first parent is the base; fetch it when the checkout is shallow.
  try { git(["rev-parse", "--verify", "--quiet", "HEAD^1"]); }
  catch { git(["fetch", "--no-tags", "--quiet", "--deepen=1", "origin"]); }
  const text = git(["show", "HEAD^1:docs/reservations.md"]);
  const changed = git(["diff", "--name-only", "HEAD^1", "HEAD"]).split("\n").filter(Boolean);
  return { text, changed, agentFiles: agentFilesAt(git, "HEAD^1") };
}

export function report({ me, found }, branch, changedCount) {
  if (!me) return { ok: true, lines: [`Branch ${branch} belongs to no agent lane; nothing to check.`] };
  if (!found.length) return { ok: true, lines: [`${me}: none of the ${changedCount} changed files is reserved by another agent.`] };
  return {
    ok: false,
    lines: found.map((r) =>
      r.item === "its own reservations file"
        ? `${r.file} is ${r.agent}'s own reservations file: only ${r.agent} edits it.`
        : `${r.file} is reserved by ${r.agent} (${r.item}). Pick another unit or wait until that reservation is removed.`,
    ),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [branch, base] = process.argv.slice(2);
  const git = (args) => execFileSync("git", args, { encoding: "utf8" });
  // The reservations as they are on the base branch: a PR cannot clear another agent's row for itself.
  const text = git(["show", `${base}:docs/reservations.md`]);
  const changed = git(["diff", "--name-only", `${base}...HEAD`]).split("\n").filter(Boolean);
  const result = report(conflicts({ text, branch, changed, agentFiles: agentFilesAt(git, base) }), branch, changed.length);
  for (const line of result.lines) console.log(line);
  process.exit(result.ok ? 0 : 1);
}
