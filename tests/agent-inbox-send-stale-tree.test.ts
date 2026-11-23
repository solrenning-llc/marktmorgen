/**
 * The channel send command in docs/agent-inbox.md (#4378) builds the new tree in a temporary index and keeps `t` from
 * the last try. If the agent's shell already holds a `t` (an earlier send in the same session) and `git read-tree`
 * then fails, the `&&` chain leaves the old `t`: its paths match, so the path check passes, and the commit carries
 * the old tree, replacing another file and dropping the new message, with no error (Codex X8's MEDIUM 6846754316,
 * Claude 3's and Claude 7's LEVEs on #4378; #5285).
 *
 * Expected: each try starts with `t` empty, so a failed read-tree sends nothing. Synthetic only: a local bare
 * repository stands in for the channel, and a `git` shim on PATH makes `read-tree` fail.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { done, is, part } from "./check";

const doc = readFileSync(join(process.cwd(), "docs/agent-inbox.md"), "utf8");
const line = doc.split("\n").find((l) => l.startsWith('de="Claude 2"; titulo=') && l.includes("para-claude-1"));
if (!line) throw new Error("the send command is not in docs/agent-inbox.md");

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } }).trim();

function channel() {
  const root = mkdtempSync(join(tmpdir(), "inbox-send-"));
  const bare = join(root, "channel.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", seed]);
  writeFileSync(join(seed, "messages.md"), "# Messages\n");
  writeFileSync(join(seed, "LEIA-CODEX.md"), "current\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", bare, "HEAD:refs/heads/para-claude-1");
  execFileSync("git", ["init", "-q", clone]);
  // A tree with the same paths and an older LEIA-CODEX.md, as a stale `t` from an earlier send would be.
  const oldLeia = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: clone, input: "old\n", encoding: "utf8" }).trim();
  const oldMsgs = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: clone, input: "# Messages\n", encoding: "utf8" }).trim();
  const stale = execFileSync("git", ["mktree"], { cwd: clone, input: `100644 blob ${oldLeia}\tLEIA-CODEX.md\n100644 blob ${oldMsgs}\tmessages.md\n`, encoding: "utf8" }).trim();
  // A git that refuses read-tree, and runs every other command as usual.
  const shims = join(root, "bin");
  execFileSync("mkdir", ["-p", shims]);
  const real = execFileSync("bash", ["-lc", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(shims, "git"), `#!/bin/bash\n[ "$1" = "read-tree" ] && exit 1\nexec ${real} "$@"\n`);
  chmodSync(join(shims, "git"), 0o755);
  return { bare, clone, stale, shims };
}

function send(c: ReturnType<typeof channel>, failReadTree: boolean): string {
  const command = line!.replace(/u=https:\/\/github\.com\/[^;]+;/, `u=${c.bare};`).replace("sleep 3", "true");
  const env = { ...process.env, PATH: failReadTree ? `${c.shims}:${process.env.PATH}` : process.env.PATH, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
  try {
    return execFileSync("bash", ["-c", `t=${c.stale}; ${command}`], { cwd: c.clone, env, encoding: "utf8" });
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? error);
  }
}

const tip = (bare: string) => git(bare, "rev-parse", "refs/heads/para-claude-1");
const file = (bare: string, path: string) => git(bare, "show", `refs/heads/para-claude-1:${path}`);

part("A shell that still holds an earlier send's tree, and a read-tree that fails");
{
  const c = channel();
  const before = tip(c.bare);
  const said = send(c, true);
  is("nothing is sent", tip(c.bare), before);
  is("it says the tree was not built", said.includes("árvore não montada"), true);
  is("the other file is untouched", file(c.bare, "LEIA-CODEX.md"), "current");
}

part("Control: the same shell, read-tree working: the message is added and nothing else changes");
{
  const c = channel();
  const said = send(c, false);
  is("sent", said.includes("enviada"), true);
  is("the message is at the end", file(c.bare, "messages.md").endsWith("Texto da mensagem"), true);
  is("the other file is untouched", file(c.bare, "LEIA-CODEX.md"), "current");
}

part("The page says the command needs bash");
is("named beside the command", /bash/.test(doc.slice(doc.indexOf(line!) - 400, doc.indexOf(line!) + line!.length + 1200)), true);

done();
