/**
 * The agents' mail hook (tooling/agent-mail/hook.mjs, .claude/settings.json; owner, 24/11/2026: "PRATICAMENTE NAO
 * FUNCIONA ESSE CORREIO!!!!!!!!!!!! NINGUEM ESCUTA NINGUEM!!!!!!!!!!."). Claude Code runs it itself: at the start of a
 * session it shows the messages of the last hours for that session, and while the agent works it shows, at most once
 * a minute, what arrived since. It only reads, never blocks a session and never prints a credential.
 *
 * Synthetic: a throwaway local git repository stands for the mail, and a throwaway folder for ~/.agent-mail. The test
 * clock (AGENT_MAIL_HOOK_NOW) is honored only with AGENT_MAIL_TEST=1 and a local mail repository. Nothing real is read.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { done, is, part } from "./check";

const HOOK = join(process.cwd(), "tooling/agent-mail/hook.mjs");
const root = mkdtempSync(join(tmpdir(), "agent-mail-hook-"));
const mail = join(root, "mail");
const home = join(root, "home");
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", mail, ...args], { encoding: "utf8", env: gitEnv });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
};

/** 24/11/2026 05:00 UTC, the test's "now". */
const NOW = Date.UTC(2026, 10, 24, 5, 0, 0);
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const SESSION = "session_012ST5iZUmuf9ob1UKKczQnH";

function message(box: string, at: number, sender: string, subject: string, hex: string): string {
  const id = `${stamp(at)}-${sender}-${hex}`;
  mkdirSync(join(mail, "caixas", box), { recursive: true });
  writeFileSync(join(mail, "caixas", box, `${id}.md`), `De: ${sender}\nPara: ${box}\nData (UTC): x\nAssunto: ${subject}\nId: ${id}\n\nBody of ${subject}.\nSessão: session_x (claude-9)\n`);
  return id;
}
function commit(): void {
  git("add", "-A");
  git("commit", "-q", "-m", "mail");
}

type Run = { status: number | null; event: string | null; text: string };
function hook(mode: "start" | "check", at: number, env: Record<string, string> = {}): Run {
  const r = spawnSync(process.execPath, [HOOK, mode], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...gitEnv, CORREIO_REPO: mail, AGENT_MAIL_HOOK_DIR: home, AGENT_MAIL_TEST: "1", AGENT_MAIL_HOOK_NOW: String(at), CLAUDE_CODE_REMOTE_SESSION_ID: SESSION, ...env },
  });
  const out = r.stdout.trim();
  if (!out) return { status: r.status, event: null, text: "" };
  const parsed = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  return { status: r.status, event: parsed.hookSpecificOutput.hookEventName, text: parsed.hookSpecificOutput.additionalContext };
}

try {
  mkdirSync(mail, { recursive: true });
  git("init", "-q", "-b", "correio");
  const toAll = message("todos", NOW - 3_600_000, "claude-1", "To everyone", "a001");
  const toFamily = message("claude-5", NOW - 1_800_000, "claude-3-xuxy", "To the family", "a002");
  const toMe = message("claude-5-izumuf", NOW - 600_000, "claude-6-jaav7", "To this session", "a003");
  const toSister = message("claude-5-ibqho", NOW - 600_000, "claude-6-jaav7", "To a sister session", "a004");
  const toOther = message("claude-3", NOW - 600_000, "claude-1", "To another family", "a005");
  const old = message("todos", NOW - 7 * 3_600_000, "claude-1", "Older than six hours", "a006");
  const mine = message("todos", NOW - 300_000, "claude-5-izumuf", "Sent by this session", "a007");
  commit();

  part("At the start of a session: the last six hours of everyone's, the family's and its own box");
  const start = hook("start", NOW);
  is("it exits 0", start.status, 0);
  is("as SessionStart context", start.event, "SessionStart");
  is("everyone's, the family's and its own messages are shown", [toAll, toFamily, toMe].map((id) => start.text.includes(id)), [true, true, true]);
  is("a sister session's, another family's, an older one and its own sent message are not", [toSister, toOther, old, mine].map((id) => start.text.includes(id)), [false, false, false, false]);
  is("with sender and subject", start.text.includes("De: claude-6-jaav7 | Assunto: To this session"), true);
  is("and how to read in full and confirm", /read --as "Claude 5 <sua sessão>"; confirme com ack/.test(start.text), true);

  part("While the agent works: at most once a minute, only what arrived since");
  is("30 seconds later: nothing is looked at", hook("check", NOW + 30_000), { status: 0, event: null, text: "" });
  const arrived = message("todos", NOW + 60_000, "claude-2", "Arrived during work", "b001");
  commit();
  const check = hook("check", NOW + 120_000);
  is("2 minutes later: the new message, as PostToolUse context", [check.status, check.event, check.text.includes(arrived)], [0, "PostToolUse", true]);
  is("and none of those already shown", [toAll, toFamily, toMe].map((id) => check.text.includes(id)), [false, false, false]);
  is("a minute after that: nothing new, nothing said", hook("check", NOW + 200_000), { status: 0, event: null, text: "" });

  part("Many at once: only the newest are shown, and the count is said");
  for (let i = 0; i < 12; i += 1) message("todos", NOW + 300_000 + i * 1000, "claude-4", `Burst ${i}`, `c${String(i).padStart(3, "0")}`);
  commit();
  const burst = hook("check", NOW + 400_000);
  is("12 new, the 8 newest shown", [burst.text.includes("12 mensagem(ns) nova(s)"), burst.text.includes("as 8 mais novas"), burst.text.includes("Burst 11"), burst.text.includes("Burst 3")], [true, true, true, false]);

  part("It never blocks a session and never prints a credential");
  const broken = { CORREIO_REPO: join(root, "no-such-mail"), AGENT_MAIL_HOOK_DIR: join(root, "home2") };
  const startBroken = hook("start", NOW, broken);
  is("an unreadable mail at the start: exit 0 and a plain notice", [startBroken.status, startBroken.text.startsWith("CORREIO DOS AGENTES: não consegui ler o correio agora")], [0, true]);
  is("an unreadable mail during work: exit 0 and silence", hook("check", NOW + 120_000, broken), { status: 0, event: null, text: "" });
  const secret = spawnSync(process.execPath, ["--input-type=module", "-e", `import { semSegredo } from ${JSON.stringify(HOOK)}; console.log(semSegredo("fetch https://user:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x failed"))`], { encoding: "utf8" });
  is("a token in an error is masked", [secret.stdout.includes("ghp_"), secret.stdout.includes("***@github.com")], [false, true]);

  part("The test clock is ignored against the real mail");
  const clock = spawnSync(process.execPath, ["--input-type=module", "-e", `import { agora } from ${JSON.stringify(HOOK)}; const t = agora({ AGENT_MAIL_TEST: "1", AGENT_MAIL_HOOK_NOW: "5", CORREIO_REPO: "https://github.com/x/y" }); console.log(t > 1e12 ? "real" : "test")`], { encoding: "utf8" });
  is("a remote mail repository always uses the real clock", clock.stdout.trim(), "real");

  part("Outside the cloud: AGENT_MAIL_AS names the family; without it, only everyone's box");
  const local = hook("start", NOW - 60_000, { CLAUDE_CODE_REMOTE_SESSION_ID: "", AGENT_MAIL_AS: "Claude 5", AGENT_MAIL_HOOK_DIR: join(root, "home3") });
  is("the family's box is read, no session box", [local.text.includes(toFamily), local.text.includes(toMe)], [true, false]);
  const nobody = hook("start", NOW - 60_000, { CLAUDE_CODE_REMOTE_SESSION_ID: "", AGENT_MAIL_AS: "", AGENT_MAIL_HOOK_DIR: join(root, "home4") });
  is("no identity: everyone's box only", [nobody.text.includes(toAll), nobody.text.includes(toFamily)], [true, false]);

  part("Claude Code runs it: .claude/settings.json, only the copy reviewed on main");
  const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8")) as { hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> }>> };
  const command = (event: string) => settings.hooks[event]?.[0]?.hooks?.[0];
  const startCommand = command("SessionStart")?.command ?? "";
  const checkCommand = command("PostToolUse")?.command ?? "";
  is("at every session start, resume, clear and compaction; after every tool", [settings.hooks.SessionStart?.[0]?.matcher, settings.hooks.PostToolUse?.[0]?.matcher], ["startup|resume|clear|compact", "*"]);
  is("the start takes the hook from origin/main and runs that copy", [startCommand.includes("git show origin/main:tooling/agent-mail/hook.mjs"), startCommand.includes('node "$HOME/.agent-mail/hook.mjs" start')], [true, true]);
  is("during work, the same copy", checkCommand.includes('node "$HOME/.agent-mail/hook.mjs" check'), true);
  is("never the hook of the branch checked out", [startCommand, checkCommand].some((c) => c.includes("$CLAUDE_PROJECT_DIR/tooling/agent-mail/hook.mjs")), false);
  is("each with a short time limit, and no other hook", [command("SessionStart")?.timeout, command("PostToolUse")?.timeout, Object.keys(settings.hooks).sort()], [60, 30, ["PostToolUse", "SessionStart"]]);

  // A project whose origin/main holds the reviewed hook and tool; HOME is a throwaway folder.
  const project = (name: string, files: Record<string, string>) => {
    const dir = join(root, name);
    mkdirSync(join(dir, "tooling/agent-mail"), { recursive: true });
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    const g = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv });
    g("init", "-q", "-b", "main");
    g("add", "-A");
    g("commit", "-q", "-m", "main");
    g("update-ref", "refs/remotes/origin/main", "HEAD");
    return dir;
  };
  const tool = readFileSync("tooling/agent-mail/agent-mail.mjs", "utf8");
  const toolSha = readFileSync("tooling/agent-mail/agent-mail.sha256", "utf8");
  const hookText = readFileSync("tooling/agent-mail/hook.mjs", "utf8");
  const reviewed = project("reviewed", { "tooling/agent-mail/hook.mjs": hookText, "tooling/agent-mail/agent-mail.mjs": tool, "tooling/agent-mail/agent-mail.sha256": toolSha });
  const run = (cmd: string, dir: string, homeDir: string, at: number): Run => {
    const r = spawnSync("bash", ["-c", cmd], {
      encoding: "utf8",
      timeout: 90_000,
      env: { ...gitEnv, HOME: homeDir, CLAUDE_PROJECT_DIR: dir, CORREIO_REPO: mail, AGENT_MAIL_TEST: "1", AGENT_MAIL_HOOK_NOW: String(at), CLAUDE_CODE_REMOTE_SESSION_ID: SESSION, AGENT_MAIL_HOOK_DIR: "" },
    });
    const out = r.stdout.trim();
    if (!out) return { status: r.status, event: null, text: "" };
    const parsed = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    return { status: r.status, event: parsed.hookSpecificOutput.hookEventName, text: parsed.hookSpecificOutput.additionalContext };
  };

  part("The settings' own commands, run as Claude Code runs them");
  const home5 = join(root, "home5");
  mkdirSync(home5);
  writeFileSync(join(reviewed, "tooling/agent-mail/hook.mjs"), `${hookText}\nconsole.log("BRANCH CODE RAN");\n`);
  const viaStart = run(startCommand, reviewed, home5, NOW - 60_000);
  is("the start runs main's copy, not the branch's changed file", [viaStart.status, viaStart.event, viaStart.text.includes("BRANCH CODE")], [0, "SessionStart", false]);
  is("it installed the reviewed tool and read the family's box", [readFileSync(join(home5, ".agent-mail/agent-mail.mjs"), "utf8") === tool, viaStart.text.includes(toFamily)], [true, true]);
  writeFileSync(join(home5, ".agent-mail/agent-mail.mjs"), "export const SESSOES = {};\n");
  const afterTamper = run(checkCommand, reviewed, home5, NOW + 3_600_000);
  is("a changed tool copy is installed again from main before it is read", [afterTamper.status, readFileSync(join(home5, ".agent-mail/agent-mail.mjs"), "utf8") === tool], [0, true]);

  const badSha = project("bad-sha", { "tooling/agent-mail/hook.mjs": hookText, "tooling/agent-mail/agent-mail.mjs": tool, "tooling/agent-mail/agent-mail.sha256": `${"0".repeat(64)}  agent-mail.mjs\n` });
  const home6 = join(root, "home6");
  mkdirSync(home6);
  const refused = run(startCommand, badSha, home6, NOW - 60_000);
  is("a tool that does not match main's SHA-256 is never run: everyone's box only, and why", [refused.status, refused.text.includes(toAll), refused.text.includes(toFamily), refused.text.includes("Só a caixa de todos foi lida")], [0, true, false, true]);

  const before = project("before-merge", { "tooling/agent-mail/agent-mail.mjs": tool, "tooling/agent-mail/agent-mail.sha256": toolSha });
  const home7 = join(root, "home7");
  mkdirSync(home7);
  is("before the hook is on main, the commands do nothing and exit 0", [run(startCommand, before, home7, NOW), run(checkCommand, before, home7, NOW)], [{ status: 0, event: null, text: "" }, { status: 0, event: null, text: "" }]);
} finally {
  rmSync(root, { recursive: true, force: true });
}

done();
