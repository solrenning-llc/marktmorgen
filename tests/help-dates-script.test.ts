/**
 * How scripts/help-dates.mjs reads the history (564 [HC1]; review of #4209),
 * on a synthetic git repository made here, never this one:
 *
 *   - a long line whose tail alone changed is dated by the commit that changed
 *     it: the whole line is searched, never a 120-character prefix (which
 *     dated 24 answers too early);
 *   - days are UTC whatever the machine's time zone: a commit at 00:30 UTC is
 *     that UTC day, also when the script runs in Fortaleza (UTC-3), where the
 *     same moment is still the day before;
 *   - words that come from another file (a price interpolated from lib/) date
 *     the answer by the commit that changed them, though no line of
 *     lib/help-content.ts moved (Codex N1 MEDIUM on #4209): the answers are
 *     evaluated at each commit, not only searched as lines;
 *   - the generated entry imports through the @ alias, never a machine's own
 *     path, which on Windows would put backslashes in a string (Codex N1 LOW).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as helpDates from "../scripts/help-dates.mjs";
const { firstDay, gitIn, lastDayOfLine } = helpDates;
import { done, is, part } from "./check";

const repo = mkdtempSync(join(tmpdir(), "help-dates-repo-"));
const plain = (args: string[], env: Record<string, string> = {}) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } }).trim();
const head = "A".repeat(150);
const one = `${head} tail one`;
const two = `${head} tail two`;
try {
  plain(["init", "-q", "-b", "main"]);
  plain(["config", "user.email", "test@example.com"]);
  plain(["config", "user.name", "Test"]);
  plain(["config", "commit.gpgsign", "false"]);
  mkdirSync(join(repo, "lib"));
  const commit = (text: string, at: string) => {
    writeFileSync(join(repo, "lib", "help.ts"), `${text}\n`);
    plain(["add", "."]);
    plain(["commit", "-q", "-m", "x"], { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
  };
  commit(one, "2026-11-05T12:00:00Z");
  commit(two, "2026-11-06T00:30:00Z");

  part("A long line, changed only in its tail");
  {
    const git = gitIn(repo);
    is("dated by the commit that changed its tail", lastDayOfLine(git, two, ["lib"]), "2026-11-06");
    is("where a 120-character prefix would have found only the first commit", lastDayOfLine(git, two.slice(0, 120), ["lib"]), "2026-11-05");
    is("the first day a text appears", firstDay(git, "tail one", ["lib"]), "2026-11-05");
    is("a commit left out is skipped", lastDayOfLine(git, head, ["lib"], plain(["rev-parse", "HEAD~1"])), undefined);
  }

  part("UTC days, whatever the machine's time zone");
  {
    const before = process.env.TZ;
    process.env.TZ = "America/Fortaleza";
    try {
      is("00:30 UTC is that UTC day, run in Fortaleza", lastDayOfLine(gitIn(repo), two, ["lib"]), "2026-11-06");
      const local = plain(["log", "-1", "--format=%ad", "--date=format-local:%Y-%m-%d"], { TZ: "America/Fortaleza" });
      is("where git left to the local zone says the day before", local, "2026-11-05");
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  }
} finally {
  rmSync(repo, { recursive: true, force: true });
}

part("Words from another file date the answer by the commit that changed them");
{
  const dep = mkdtempSync(join(tmpdir(), "help-dates-dep-"));
  const run = (args: string[], env: Record<string, string> = {}) => execFileSync("git", args, { cwd: dep, encoding: "utf8", env: { ...process.env, ...env } }).trim();
  try {
    run(["init", "-q", "-b", "main"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    run(["config", "commit.gpgsign", "false"]);
    mkdirSync(join(dep, "lib"));
    const content = [
      'import { PRICE } from "@/lib/price";',
      "export function answerId(q: string): string {",
      '  return q.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");',
      "}",
      "export const HELP_SECTIONS: { items: { q: string; a: string[] }[] }[] = [",
      "  {",
      "    items: [",
      "      {",
      '        q: "What does the plan cost?",',
      "        a: [",
      "          `The plan costs ${PRICE} a month, charged on the day it starts.`,",
      "        ],",
      "      },",
      "    ],",
      "  },",
      "];",
      "",
    ].join("\n");
    const commit = (price: string, at: string, withContent: boolean) => {
      if (withContent) writeFileSync(join(dep, "lib", "help-content.ts"), content);
      writeFileSync(join(dep, "lib", "price.ts"), `export const PRICE = "${price}";\n`);
      run(["add", "."]);
      run(["commit", "-q", "-m", "x"], { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
    };
    commit("$69", "2026-11-05T12:00:00Z", true);
    commit("$79", "2026-11-07T12:00:00Z", false);
    execFileSync(process.execPath, [join(process.cwd(), "scripts", "help-dates.mjs")], { cwd: dep, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const written = readFileSync(join(dep, "lib", "help-dates.ts"), "utf8");
    const row = written.match(/"what-does-the-plan-cost": \{ created: "([0-9-]+)", updated: "([0-9-]+)"/);
    is("created on the day the question was written", row?.[1], "2026-11-05");
    is("updated on the day its price changed, in lib/price.ts", row?.[2], "2026-11-07");
  } finally {
    rmSync(dep, { recursive: true, force: true });
  }
}

part("The generated entry never holds the machine's own path");
{
  const make = (helpDates as { helpEntry?: () => string }).helpEntry;
  const entry = typeof make === "function" ? make() : "";
  is("it imports lib/help-content through the @ alias", entry.includes('from "@/lib/help-content"'), true);
  is("no backslash, which a Windows path would put in the string", entry.includes("\\"), false);
}

done();
