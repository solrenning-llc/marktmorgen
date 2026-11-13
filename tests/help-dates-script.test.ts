/**
 * How scripts/help-dates.mjs reads the history (564 [HC1]; review of #4209),
 * on a synthetic git repository made here, never this one:
 *
 *   - a long line whose tail alone changed is dated by the commit that changed
 *     it: the whole line is searched, never a 120-character prefix (which
 *     dated 24 answers too early);
 *   - days are UTC whatever the machine's time zone: a commit at 00:30 UTC is
 *     that UTC day, also when the script runs in Fortaleza (UTC-3), where the
 *     same moment is still the day before.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstDay, gitIn, lastDayOfLine } from "../scripts/help-dates.mjs";
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

done();
