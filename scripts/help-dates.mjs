/**
 * Reads, once, from the repository's own history, when each help answer was
 * first written and when its current words first appeared (564 [HC1],
 * complement of 30 October 2026, 09h56), and writes lib/help-dates.ts.
 *
 *   created  the day of the first commit in this history whose diff adds the
 *            answer's question, in lib/ or app/ (the help center lived in
 *            app/help/page.tsx before lib/help-content.ts);
 *   updated  the day of the latest commit that added any of the answer's
 *            current lines, as they are written in lib/help-content.ts,
 *            leaving out the commit that only moved the help center into
 *            that file; never before created.
 *
 * Needs the whole history of main (git fetch --unshallow origin main). Run
 * from the repository root: node scripts/help-dates.mjs. Dates are the
 * commits' own (UTC), never typed by hand. After this first run, the dates
 * are kept by hand with each change, held by tests/help-dates.test.ts.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";

const root = process.cwd();
const out = mkdtempSync(join(tmpdir(), "help-dates-"));
try {
  const entry = join(out, "entry.ts");
  writeFileSync(entry, `import { HELP_SECTIONS, answerId } from "${join(root, "lib/help-content.ts")}";\nconsole.log(JSON.stringify(HELP_SECTIONS.flatMap((s) => s.items.map((i) => ({ id: answerId(i.q), q: i.q, a: i.a })))));\n`);
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile: join(out, "entry.cjs"), logLevel: "error", alias: { "@": root } });
  const answers = JSON.parse(execFileSync(process.execPath, [join(out, "entry.cjs")], { encoding: "utf8", maxBuffer: 64 << 20 }));
  const source = readFileSync(join(root, "lib/help-content.ts"), "utf8");
  const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
  if (git(["rev-parse", "--is-shallow-repository"]) === "true") throw new Error("The history is shallow: run git fetch --unshallow origin main first.");
  const day = (args) => git(["log", "HEAD", "--format=%ad", "--date=format-local:%Y-%m-%d", ...args]).split("\n").filter(Boolean);
  const rows = {};
  const moved = git(["log", "HEAD", "--diff-filter=A", "--format=%H", "--", "lib/help-content.ts"]).split("\n").at(-1);
  // The file's question lines, in order: one per answer, the same order HELP_SECTIONS reads them.
  const lines = source.split("\n");
  const qAt = lines.map((line, i) => (/^\s*q: /.test(line) ? i : -1)).filter((i) => i >= 0);
  if (qAt.length !== answers.length) throw new Error(`${qAt.length} question lines for ${answers.length} answers`);
  answers.forEach((answer, n) => {
    const from = qAt[n];
    const to = lines.findIndex((line, i) => i > from && /^\s{6}\},?$/.test(line));
    const block = lines.slice(from + 1, to).map((l) => l.trim()).filter((l) => l.length > 20 && !/^a: \[$|^\],?$/.test(l));
    const literal = lines[from].trim().match(/^q: "(.*)",$/)?.[1];
    const created = [answer.q, ...(literal ? [literal] : [])].flatMap((text) => day(["--reverse", "-S", text, "--", "lib", "app"]).slice(0, 1)).sort()[0];
    if (!created) throw new Error(`No commit adds the question of ${answer.id}`);
    // The commit that moved the help center out of app/help/page.tsx changed no words: it is never an answer's last change.
    const lineDays = block.map((line) => git(["log", "HEAD", "--format=%H %ad", "--date=format-local:%Y-%m-%d", "-S", line.slice(0, 120), "--", "lib/help-content.ts", "app/help/page.tsx"]).split("\n").filter(Boolean).find((row) => !row.startsWith(moved))?.split(" ")[1]).filter(Boolean);
    const updated = [created, ...lineDays].sort().at(-1);
    rows[answer.id] = { created, updated, digest: createHash("sha256").update([answer.q, ...answer.a].join("\n")).digest("hex").slice(0, 12) };
    process.stderr.write(".");
  });
  const out_lines = Object.entries(rows).map(([id, r]) => `  ${JSON.stringify(id)}: { created: "${r.created}", updated: "${r.updated}", digest: "${r.digest}" },`);
  writeFileSync(join(root, "lib/help-dates.ts"), `/**
 * When each help answer was first written and when what it says last changed
 * (564 [HC1]), keyed by answerId. First read from the repository's history by
 * scripts/help-dates.mjs on 12 November 2026; kept by hand since, with each
 * change to an answer. \`digest\` is the answer's words as they were dated:
 * tests/help-dates.test.ts fails when the words change and the digest does
 * not, so whoever changes an answer decides: what it says changed (set
 * \`updated\` to that day) or only a comma or a link (keep the date). Both put
 * the new digest. Dates are YYYY-MM-DD, UTC.
 */
export type HelpDates = { created: string; updated: string; digest: string };

export const HELP_DATES: Readonly<Record<string, HelpDates>> = {
${out_lines.join("\n")}
};
`);
  process.stderr.write(`\n${Object.keys(rows).length} answers dated\n`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
