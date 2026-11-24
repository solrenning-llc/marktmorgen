#!/usr/bin/env node
// Tests for agent-mail.mjs (owner, OWNER-20261121-1749-QUEUE-IMPROVEMENTS-AUTH, R5): local throwaway git repositories and
// a fake `gh`, never the real mailbox or GitHub. Run: node agent-mail.test.mjs [path/to/agent-mail.mjs]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TOOL = resolve(process.argv[2] || new URL("./agent-mail.mjs", import.meta.url).pathname);
const T = mkdtempSync(join(tmpdir(), "agent-mail-test-"));
const g = (args, cwd = T) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const SES = { c4: "cse_01S9eVA3KcXUkc6qPJmpNg4a", c5: "cse_012ST5iZUmuf9ob1UKKczQnH", c6: "cse_018ZjhHhUoHAGLUkhRVBUuAW", c2: "cse_01FR6Z1Q87JZvTFBRpZ8SNo8",
  // The named session and its backup (coordinator decision C1-20261121-2036-C6-1); c5 is another Claude 5 session.
  ibq: "cse_012ST5ibqhoHCYrphJXU5az3", c1a: "cse_01DKvYQaxPrZTrVdXNwosXYi" };

// Repositories: the mailbox branch, and a "GitHub" with main, PRs and a merge-queue group.
g(["init", "-q", "--bare", "mail.git"]); g(["init", "-q", "--bare", "prs.git"]);
g(["init", "-q", "w"]); g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], join(T, "w"));
g(["push", "-q", "../mail.git", "HEAD:refs/heads/correio"], join(T, "w"));
g(["init", "-q", "p"]); const P = join(T, "p");
const commit = (file, text, msg) => { writeFileSync(join(P, file), text); g(["add", "."], P); g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg], P); return g(["rev-parse", "HEAD"], P); };
const M = commit("a.txt", "x\n", "base"); g(["push", "-q", "../prs.git", "HEAD:refs/heads/main"], P);
const pr = (n, file, text) => { g(["checkout", "-q", "-B", `pr${n}`, M], P); const h = commit(file, text, `pr${n}`); g(["push", "-q", "../prs.git", `HEAD:refs/pull/${n}/head`], P); return h; };
const H1 = pr(1, "f1.txt", "1\n"), H2 = pr(2, "f2.txt", "2\n"), H3 = pr(3, "a.txt", "um\n");
g(["checkout", "-q", "-B", "q9", M], P); commit("a.txt", "nove\n", "pr9"); g(["push", "-q", "../prs.git", `HEAD:refs/heads/gh-readonly-queue/main/pr-9-${M}`], P);

// A fake gh: FAKE_GH=ok answers a comment of PR 1 or 2 citing H1/H2; FAKE_GH=nohead answers without the head; FAKE_GH=down fails.
const BIN = join(T, "bin"); mkdirSync(BIN);
writeFileSync(join(BIN, "gh"), `#!/bin/sh
case "$FAKE_GH" in
  down) echo "gh: connection refused" >&2; exit 1 ;;
esac
# The PR's own comments and reviews (ce2d): one JSON line [body, association] per comment, from FAKE_COMMENTS.
for a in "$@"; do case "$a" in
  repos/*/issues/[0-9]*/comments) [ "$FAKE_COMMENTS_DOWN" = 1 ] && { echo "gh: 502" >&2; exit 1; }
    # FAKE_READY_ALL=1 (OWNER-20261123-1442): a READY from every family on every head of this PR's repository, so a test
    # that only needs the PR enqueued meets the three READY; the tool still leaves out the author and commit families.
    if [ "$FAKE_READY_ALL" = 1 ]; then n=\${a#*issues/}; n=\${n%%/*}
      for h in $(git --git-dir="$CORREIO_PR_REPO" for-each-ref --format='%(objectname:short=10)' refs/heads refs/pull); do
        for f in "Claude 1 R" "Claude 2 R" "Claude 3 R" "Claude 4 R" "Claude 5 R" "Claude 6 R" "Claude 7 R" "Codex R"; do
          case "$f" in "$FAKE_READY_SKIP "*) continue ;; esac
          printf '["%s review #%s @%s: READY\\\\n\\\\nbody","COLLABORATOR"]\\n' "$f" "$n" "$h"; done; done; exit 0; fi
    printf '%s' "\${FAKE_COMMENTS:-}"; exit 0 ;;
  repos/*/pulls/[0-9]*/reviews) printf '%s' "\${FAKE_REVIEWS:-}"; exit 0 ;;
  repos/*/issues?labels=canal-ativo*) [ "$FAKE_CANAL_DOWN" = 1 ] && { echo "gh: 502" >&2; exit 1; }
    printf '%s\\n' "\${FAKE_CANAL:-[5104,\\"Agent coordination — part 8 (continues #4932)\\"]}"; exit 0 ;;
esac; done
case "$FAKE_GH" in
  req) printf '%s\\n' '["https://github.com/solrenning-llc/marktmorgen/issues/'"\${FAKE_ISSUE:-4932}"'#issuecomment-'"$FAKE_ID"'","'"$FAKE_BODY"'","'"\${FAKE_CREATED:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"'"]' ;;
  headref) echo "$FAKE_REF" ;;
  nohead) echo '["https://github.com/solrenning-llc/marktmorgen/pull/'"$FAKE_PR"'#issuecomment-1","READY, no head here","","COLLABORATOR"]' ;;
  rev) printf '%s\\n' '["https://github.com/solrenning-llc/marktmorgen/pull/'"$FAKE_PR"'#issuecomment-1","'"$FAKE_BODY"'","","'"\${FAKE_ASSOC:-COLLABORATOR}"'"]' ;;
  *) echo '["https://github.com/solrenning-llc/marktmorgen/pull/'"$FAKE_PR"'#issuecomment-1","Review @'"$FAKE_SHA"' READY","","COLLABORATOR"]' ;;
esac
`); chmodSync(join(BIN, "gh"), 0o755);

const base = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", CORREIO_REPO: join(T, "mail.git"), CORREIO_PR_REPO: join(T, "prs.git"), CORREIO_SEM_VERSAO: "1", AGENT_MAIL_TEST: "1", CORREIO_GIT_DIR: join(T, "correio-local.git"), PATH: `${BIN}:${process.env.PATH}` };
delete base.CLAUDE_CODE_REMOTE_SESSION_ID;
// Both outputs are read: warnings go to stderr even when the command succeeds.
// Writes several files straight into a mailbox in one commit (the reviews a test needs on a head).
const rawMany = (files, repo) => {
  const c = join(T, `raw-${Math.random().toString(16).slice(2)}`);
  g(["clone", "-q", "-b", "correio", repo, c]);
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(c, path, ".."), { recursive: true }); writeFileSync(join(c, path), text); }
  g(["add", "."], c); g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "raw"], c); g(["push", "-q", "origin", "HEAD:correio"], c);
};
/**
 * The reviews concluded in the mail on a head, as complete-review writes them (revisao/feitas): `quem` is a list of
 * reviewer names, or [name, result, head] triples. The 3-READY gate does not count these: the proof is the PR (CO (l)).
 */
const revisoesNoCorreio = (repo, pr, sha, quem) => rawMany(Object.fromEntries(quem.map((q) => {
  const [nome, resultado = "READY", head = sha] = Array.isArray(q) ? q : [q];
  return [`revisao/feitas/t-${pr}-${Math.random().toString(16).slice(2, 10)}.md`, `Resultado: ${resultado}\nPR: ${pr}\nHead: ${head}\nPor: ${nome}\nData (UTC): 2026-11-23 00:00\n\nt\n`];
})), repo);
const run = (args, env = {}, cwd = join(T, "w")) => {
  // The enqueuer is outside the head's reviewers (FQ (1)): FAKE_READY_ALL leaves out the READY of the --as family.
  if (env.FAKE_READY_ALL === "1" && !env.FAKE_READY_SKIP) {
    const quem = String(args[args.indexOf("--as") + 1] ?? "");
    env = { ...env, FAKE_READY_SKIP: /^Codex/i.test(quem) ? "Codex" : (/^Claude \d+/.exec(quem)?.[0] ?? "") };
  }
  const r = spawnSync("node", [TOOL, ...args], { cwd, env: { ...base, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const as = (k) => ({ CLAUDE_CODE_REMOTE_SESSION_ID: SES[k] });
let falhas = 0, total = 0;
const is = (nome, cond, extra = "") => { total++; if (!cond) falhas++; console.log(`${cond ? "  ok  " : "  FAIL"}  ${nome}${!cond && extra ? `\n        ${String(extra).slice(0, 400).replace(/\n/g, "\n        ")}` : ""}`); };
// Writes a file straight into the mailbox with git, as an old or edited copy of the tool could (review of Claude 2 upbeat).
const raw = (path, text, repo = join(T, "mail.git")) => {
  const c = join(T, `raw-${Math.random().toString(16).slice(2)}`);
  g(["clone", "-q", "-b", "correio", repo, c]);
  mkdirSync(join(c, path, ".."), { recursive: true }); writeFileSync(join(c, path), text);
  g(["add", "."], c); g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "raw"], c); g(["push", "-q", "origin", "HEAD:correio"], c);
};
const link = (n) => `https://github.com/solrenning-llc/marktmorgen/pull/${n}#issuecomment-1`;

const rec0 = () => run(["record-review", "--as", "Claude 4 X", "--pr", "1", "--sha", H1.slice(0, 10), "--result", "READY", "--link", `https://github.com/solrenning-llc/marktmorgen/pull/1#issuecomment-1`], { CLAUDE_CODE_REMOTE_SESSION_ID: SES.c4, FAKE_GH: "ok", FAKE_PR: "1", FAKE_SHA: H1.slice(0, 10) });
console.log("switches (R1)");
let r = run(["record-review", "--as", "Claude 4 X", "--pr", "1", "--sha", H1.slice(0, 10), "--result", "READY", "--link", link(1)], { ...as("c4"), FAKE_GH: "ok", FAKE_PR: "1", FAKE_SHA: H1.slice(0, 10) });
is("off by default: record-review is refused", !r.ok && /DESLIGADO/.test(r.out), r.out);
r = run(["set-switch", "--as", "Claude 6 X", "--name", "record-review", "--on", "--reason", "t"], as("c6"));
is("only the named session turns a switch on: Claude 6 is refused", !r.ok && /sessão nomeada/.test(r.out), r.out);
r = run(["set-switch", "--as", "Claude 5 X", "--name", "record-review", "--on", "--reason", "t"]);
is("an unidentified session cannot turn it on, even named Claude 5", !r.ok && /sessão nomeada/.test(r.out), r.out);
r = run(["set-switch", "--as", "Claude 5 X", "--name", "record-review", "--on", "--reason", "t"], as("c6"));
is("a Claude 6 session cannot turn it on under Claude 5's name", !r.ok && /identidade|sessão nomeada/.test(r.out), r.out);
raw(`chaves/record-review/${Date.now()}-claude-5-x-ab12`, "ON\nClaude 5 X\nraw\n");
r = rec0();
is("an ON written without the coordinator's session (raw git, old copy) does not turn anything on", !r.ok && /DESLIGADO/.test(r.out), r.out);
is("list-switches says the raw ON was ignored", /record-review: DESLIGADO .*ON IGNORADO/.test(run(["list-switches"]).out), run(["list-switches"]).out);
console.log("privileged actions: the named session only, on a coordinator request on #4932 (OWNER-20261121-1904 step 2)");
// A coordinator request is a fresh comment on #4932 with the marker line; each one gets its own id (single use).
let nReq = 100;
const marca = (cmd, alvo) => `AGENT-MAIL-REQUEST C1-20261121-2100-TEST ${cmd} ${alvo}`;
const pedidoDe = (body, extra = {}) => { const id = ++nReq; return { args: ["--request", `https://github.com/solrenning-llc/marktmorgen/issues/4932#issuecomment-${id}`], env: { FAKE_GH: "req", FAKE_ID: String(id), FAKE_BODY: body, ...extra }, id }; };
const ligar = (who, k, q = null, extra = [], nome = "record-review") => run(["set-switch", "--as", who, "--name", nome, "--on", "--reason", "teste", ...(q ? q.args : []), ...extra], { ...as(k), ...(q ? q.env : {}) });
r = ligar("Claude 5 X", "c5", pedidoDe(marca("set-switch", "record-review")));
is("another Claude 5 session (not the named one) cannot turn a switch on", !r.ok && /sessão nomeada/.test(r.out), r.out);
r = ligar("Claude 5 ibqho", "ibq");
is("the named session needs --request (condition 4)", !r.ok && /--request é obrigatório/.test(r.out), r.out);
r = ligar("Claude 5 ibqho", "ibq", pedidoDe(marca("set-switch", "record-review"), { FAKE_ISSUE: "4933" }));
is("a request comment that is not on the coordination channel in force is refused", !r.ok && /não é do canal em vigor \(#5104 ou da #4932/.test(r.out), r.out);
r = ligar("Claude 5 ibqho", "ibq", pedidoDe("please turn record-review on"));
is("a comment that only mentions the switch, without the marker line, is refused (review of Claude 4 3Kc)", !r.ok && /não traz a linha "AGENT-MAIL-REQUEST/.test(r.out), r.out);
r = ligar("Claude 5 ibqho", "ibq", pedidoDe(marca("set-switch", "ready-check")));
is("a marker for another switch is refused", !r.ok && /não traz a linha/.test(r.out), r.out);
r = ligar("Claude 5 ibqho", "ibq", pedidoDe("AGENT-MAIL-REQUEST C5-20261121-2100-TEST set-switch record-review"));
is("a marker without the coordinator's identifier (C1-...) is refused", !r.ok && /não traz a linha/.test(r.out), r.out);
r = ligar("Claude 5 ibqho", "ibq", pedidoDe(marca("set-switch", "record-review"), { FAKE_CREATED: "2026-01-01T00:00:00Z" }));
is("an old request is refused (at most 2 hours)", !r.ok && /não é um pedido recente/.test(r.out), r.out);
r = ligar("Claude 5 ibqho", "ibq", { args: ["--request", "77"], env: { FAKE_GH: "down" } });
is("a request that cannot be checked now is refused (nothing NOT CHECKED goes on)", !r.ok && /NÃO FOI CONFERIDO/.test(r.out), r.out);
// The channel changes part at 2,250 comments (AC (p)); on 22/11/2026 #5104 took over from #4932 (channel-ativo label).
r = ligar("Claude 5 ibqho", "ibq", pedidoDe(marca("set-switch", "record-review"), { FAKE_CANAL_DOWN: "1" }));
is("with the channel in force unreadable, the request is not used (NOT CHECKED)", !r.ok && /canal em vigor .*NÃO FOI CONFERIDO/.test(r.out), r.out);
r = ligar("Claude 5 ibqho", "ibq", pedidoDe(marca("set-switch", "record-review"), { FAKE_CANAL: '[5104,"part 8 (continues #4932)"]\n[5200,"part 9 (continues #5104)"]' }));
is("with two open issues labeled canal-ativo, the channel is NOT CHECKED and nothing is done", !r.ok && /canal em vigor .*NÃO FOI CONFERIDO/.test(r.out), r.out);
r = ligar("Claude 5 ibqho", "ibq", pedidoDe(marca("set-switch", "record-review"), { FAKE_CANAL: '[5200,"Agent coordination — part 9 (continues #5104)"]' }));
is("two parts later, a request on #4932 is refused: only the part in force and the one it continues count", !r.ok && /não é do canal em vigor \(#5200 ou da #5104/.test(r.out), r.out);
is("nothing was turned on by the refused attempts", /record-review: DESLIGADO/.test(run(["list-switches"]).out), run(["list-switches"]).out);
{
  // A request written on the part in force (#5104), given by its bare id: accepted (it was refused while only #4932 counted).
  const q5104 = pedidoDe(marca("set-switch", "ready-check"), { FAKE_ISSUE: "5104" });
  r = ligar("Claude 1 A", "c1a", { args: ["--request", String(q5104.id)], env: q5104.env }, [], "ready-check");
}
is("with no sign from the named session in 60 minutes, the backup acts, and the record says why", r.ok && /ready-check: LIGADO/.test(run(["list-switches"]).out), r.out);
is("a request on #5104, the channel in force, is accepted and recorded with its own address", r.ok && /Pedido: https:\/\/github\.com\/solrenning-llc\/marktmorgen\/issues\/5104#issuecomment-/.test(run(["list-switches"]).out + run(["read", "--as", "Claude 2 Z"], as("c2")).out), r.out);
run(["set-switch", "--as", "Claude 2 X", "--name", "ready-check", "--off", "--reason", "fim do teste"], as("c2"));
const q1 = pedidoDe(`Coordinator decision.\\n${marca("set-switch", "record-review")}`);
r = ligar("Claude 5 ibqho", "ibq", q1);
is("the named session turns it on, on the coordinator's request", r.ok && /LIGADO/.test(r.out), r.out);
r = run(["read", "--as", "Claude 2 Z"], as("c2"));
is("the privileged action is announced to all in the same minute, with the request and its identifier", /interruptor record-review LIGADO/.test(r.out) && new RegExp(`issuecomment-${q1.id}`).test(r.out) && /C1-20261121-2100-TEST/.test(r.out), r.out);
r = ligar("Claude 5 ibqho", "ibq", q1);
is("a request is used once only", !r.ok && /já foi usado/.test(r.out), r.out);
{
  // Note 2 of Claude 2 upbeat on #5052: two actions with one request at the same instant could both pass the git grep;
  // each action also writes pedidos-usados/<comment>, so the second one's append is refused. Here the other action's
  // marker is already there (written raw, as by the action that won the race), and this one is refused.
  const q2 = pedidoDe(marca("set-switch", "ready-check"));
  raw(`pedidos-usados/${q2.id}`, `Pedido: x\n`);
  r = ligar("Claude 5 ibqho", "ibq", q2, [], "ready-check");
  is("a second action with the same request at the same instant is refused (its use marker already exists)", !r.ok && new RegExp(`pedidos-usados/${q2.id}`).test(r.out) && /ready-check: DESLIGADO/.test(run(["list-switches"]).out), r.out + run(["list-switches"]).out);
}
// A shallow clone whose history does not reach the named session's last write: no sign is NOT CHECKED (review of Claude 4 3Kc).
run(["send", "--from", "Claude 2 Z", "--to", "Claude 3 Z", "--subject", "s", "--text", "a"], as("c2"));
const W2 = join(T, "w2"); g(["init", "-q", W2]); g(["fetch", "-q", "--depth", "1", `file://${join(T, "mail.git")}`, "+refs/heads/correio:refs/x"], W2);
run(["send", "--from", "Claude 2 Z", "--to", "Claude 3 Z", "--subject", "s", "--text", "b"], as("c2"));
// Step 6 (A14): the mailbox lives in the tool's own repository, so the shallow history is that repository's.
r = run(["set-switch", "--as", "Claude 1 A", "--name", "record-review", "--on", "--reason", "t", ...pedidoDe(marca("set-switch", "record-review")).args], { ...as("c1a"), ...pedidoDe(marca("set-switch", "record-review")).env, FAKE_ID: String(nReq - 1), CORREIO_GIT_DIR: join(W2, ".git") }, W2);
is("in a shallow clone that does not cover 60 minutes, the backup does not act on 'no sign'", !r.ok && /NÃO FOI CONFERIDO: o histórico local do correio é raso/.test(r.out), r.out);
// Two boundaries: a merge whose side parent is 2 hours old. Coverage is the NEWEST boundary, not the oldest (review of Claude 4 AC).
{
  const c = join(T, "raw-merge"); g(["clone", "-q", "-b", "correio", join(T, "mail.git"), c]);
  const antigo = new Date(Date.now() - 2 * 3600000).toISOString();
  const env2 = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: antigo, GIT_COMMITTER_DATE: antigo };
  execFileSync("git", ["checkout", "-q", "-b", "side", "HEAD~3"], { cwd: c }); execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "old side"], { cwd: c, env: env2 });
  g(["checkout", "-q", "correio"], c); g(["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", "merge side", "side"], c); g(["push", "-q", "origin", "HEAD:correio"], c);
}
const W3 = join(T, "w3"); g(["init", "-q", W3]); g(["fetch", "-q", "--depth", "2", `file://${join(T, "mail.git")}`, "+refs/heads/correio:refs/x"], W3);
const qw3 = pedidoDe(marca("set-switch", "record-review"));
r = run(["set-switch", "--as", "Claude 1 A", "--name", "record-review", "--on", "--reason", "t", ...qw3.args], { ...as("c1a"), ...qw3.env, CORREIO_GIT_DIR: join(W3, ".git") }, W3);
is("with an old side boundary and a recent main boundary, coverage is the newest boundary: still NOT CHECKED", !r.ok && /NÃO FOI CONFERIDO: o histórico local do correio é raso/.test(r.out), r.out);
// A git failure in the single-use check refuses; it never reads as "not used" (review of Claude 4 AC).
{
  const mod = await import(TOOL);
  const antes = { PATH: process.env.PATH, FAKE_GH: process.env.FAKE_GH, FAKE_ID: process.env.FAKE_ID, FAKE_BODY: process.env.FAKE_BODY };
  Object.assign(process.env, { PATH: `${BIN}:${process.env.PATH}`, FAKE_GH: "req", FAKE_ID: "999", FAKE_BODY: marca("set-switch", "record-review") });
  let erro = "";
  try { mod.conferirPedido("999", "set-switch", "record-review", "0".repeat(40)); } catch (e) { erro = String(e.message ?? e); }
  for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  is("a git error in the single-use check refuses the request (NOT CHECKED)", /NÃO FOI CONFERIDO/.test(erro) && /uso/.test(erro), erro);
}
r = ligar("Claude 1 A", "c1a", pedidoDe(marca("set-switch", "record-review")));
is("the backup is refused while the named session signed in the last 60 minutes", !r.ok && /três casos/.test(r.out), r.out);
r = ligar("Claude 1 A", "c1a", pedidoDe(marca("set-switch", "record-review")), ["--owner-message", "OWNER-20261121-2100-TEST"]);
is("the backup acts on an owner message, and says so", r.ok && /Reserva: mensagem do dono: OWNER-20261121-2100-TEST/.test(run(["read", "--as", "Claude 2 Z"], as("c2")).out), r.out);
const qr = pedidoDe(marca("set-switch", "record-review"));
r = run(["set-switch", "--as", "Claude 5 ibqho", "--name", "record-review", "--on", ...qr.args], { ...as("ibq"), ...qr.env });
is("a reason is required", !r.ok && /--reason/.test(r.out), r.out);
is("list-switches shows it on and who", /record-review: LIGADO \(por Claude 1 A/.test(run(["list-switches"]).out), run(["list-switches"]).out);
raw(`chaves/record-review/${Date.now() + 5}-claude-5-ibqho-cd34`, "ON\nClaude 5 ibqho\nforged\nSessão: session_012ST5ibqhoHCYrphJXU5az3 (claude-5)\n");
is("an ON with the named session's line but no request line is ignored (read as off, the safe side)", /record-review: DESLIGADO .*ON IGNORADO/.test(run(["list-switches"]).out), run(["list-switches"]).out);
ligar("Claude 5 ibqho", "ibq", pedidoDe(marca("set-switch", "record-review")));

console.log("record-review (item 2)");
const rec = (who, n, sha, env, extra = []) => run(["record-review", "--as", who, "--pr", String(n), "--sha", sha.slice(0, 10), "--result", "READY", "--link", link(n), ...extra], env);
r = run(["record-review", "--as", "Claude 4 X", "--pr", "1", "--sha", H1.slice(0, 10), "--result", "READY"], as("c4"));
is("the link is required", !r.ok && /--link é obrigatório/.test(r.out), r.out);
r = run(["record-review", "--as", "Claude 4 X", "--pr", "1", "--sha", H1.slice(0, 10), "--result", "READY", "--link", link(2)], as("c4"));
is("a link to another PR is refused", !r.ok && /--link é obrigatório/.test(r.out), r.out);
r = run(["record-review", "--as", "Claude 4 X", "--pr", "1", "--sha", H1.slice(0, 10), "--result", "OK", "--link", link(1)], as("c4"));
is("the result is READY or CHANGES", !r.ok && /READY ou CHANGES|--result deve ser/.test(r.out), r.out);
r = rec("Claude 4 X", 1, H1, { ...as("c4"), FAKE_GH: "ok", FAKE_PR: "1", FAKE_SHA: H1.slice(0, 10) });
is("an identified record with a checked link is accepted with nothing unchecked", r.ok && /registrado/.test(r.out) && !/NÃO CONFERIDO/.test(r.out), r.out);
r = run(["list-review-records", "--pr", "1"]);
is("list-review-records: checked, and it takes Claude 4 out of the queue for this head", /conferido +tira a família da fila deste head/.test(r.out) && !/NÃO CONFERIDO/.test(r.out), r.out);
r = run(["request-enqueue", "--from", "Claude 2", "--pr", "1", "--sha", H1.slice(0, 10), "--text", "fila #1"], { ...as("c2"), CORREIO_SEM_COMMITS: "1" });
is("request-enqueue writes the recording family into Exclui", r.ok && /registrado/.test(r.out), r.out);
r = run(["claim-enqueue", "--as", "Claude 4 X"], as("c4"));
is("the family that recorded a review of this head cannot claim the enqueue", /excluído|nenhum pedido/.test(r.out) && !/pegou/.test(r.out), r.out);
r = run(["claim-enqueue", "--as", "Claude 6 X"], as("c6"));
is("another family claims it, and the head matches the request", /pegou/.test(r.out) && /igual ao do pedido/.test(r.out), r.out);
is("1442: the claim says which READY the tool checks and that the opener's family on an unprefixed branch is the enqueuer's to check (NIT of Claude 3 yaQt on #5408)",
  /READY de fora no verify-enqueue/.test(r.out) && /não confere a família de quem abriu o PR num ramo sem prefixo de família/.test(r.out), r.out);
const idf = /pegou: (\S+)/.exec(r.out)?.[1];
run(["complete-enqueue", "--as", "Claude 6 X", idf, "--result", "enqueued", "--text", "t"], { ...as("c6"), FAKE_READY_ALL: "1" });

r = rec("Claude 7 X", 2, H2, { FAKE_GH: "ok", FAKE_PR: "2", FAKE_SHA: H2.slice(0, 10) });
is("an unidentified record is accepted but NOT CHECKED and does not take anyone out (R3)", r.ok && /NÃO CONFERIDO: sessão não identificada/.test(r.out) && /NÃO tira a sua família da fila/.test(r.out), r.out);
const id7 = /registrado: (\S+)/.exec(r.out)?.[1];
r = run(["confirm-review-record", "--as", "Claude 6 X", id7, "--reason", "t"], as("c6"));
is("only the named session confirms a record", !r.ok && /sessão nomeada/.test(r.out), r.out);
let qc = pedidoDe(marca("confirm-review-record", id7));
r = run(["confirm-review-record", "--as", "Claude 5 X", id7, "--reason", "t", ...qc.args], { ...as("c5"), ...qc.env });
is("another Claude 5 session cannot confirm a record", !r.ok && /sessão nomeada/.test(r.out), r.out);
qc = pedidoDe(marca("confirm-review-record", "other-id"));
r = run(["confirm-review-record", "--as", "Claude 5 ibqho", id7, "--reason", "conferido no PR", ...qc.args], { ...as("ibq"), ...qc.env });
is("a request that does not name the record is refused", !r.ok && new RegExp(`não traz a linha .*confirm-review-record ${id7}`).test(r.out), r.out);
qc = pedidoDe(marca("confirm-review-record", id7));
r = run(["confirm-review-record", "--as", "Claude 5 ibqho", id7, "--reason", "conferido no PR", ...qc.args], { ...as("ibq"), ...qc.env });
is("the named session confirms it, on the coordinator's request", r.ok, r.out);
// Condition 3: never on a PR the privileged session wrote, reviewed or enqueued.
r = rec("Claude 4 X", 1, H1, { ...as("c4"), FAKE_GH: "ok", FAKE_PR: "1", FAKE_SHA: H1.slice(0, 10) });
const idr1 = /registrado: (\S+)/.exec(r.out)?.[1];
raw("revisao/feitas/20261121T000000Z-claude-5-ibqho-0001.md", `Resultado: READY\nPR: 1\nHead: ${H1.slice(0, 10)}\nPor: Claude 5 ibqho\n\nok\nSessão: session_012ST5ibqhoHCYrphJXU5az3 (claude-5)\n`);
qc = pedidoDe(marca("confirm-review-record", idr1));
r = run(["confirm-review-record", "--as", "Claude 5 ibqho", idr1, "--reason", "t", ...qc.args], { ...as("ibq"), ...qc.env });
is("the named session does not confirm a record of a PR it reviewed", !r.ok && /revisou/.test(r.out), r.out);
g(["checkout", "-q", "-B", "pr8", M], P); const H8 = commit("f8.txt", "8\n", "pr8\n\nClaude-Session: https://claude.ai/code/session_012ST5ibqhoHCYrphJXU5az3"); g(["push", "-q", "../prs.git", "HEAD:refs/pull/8/head"], P);
r = rec("Claude 4 X", 8, H8, { ...as("c4"), FAKE_GH: "ok", FAKE_PR: "8", FAKE_SHA: H8.slice(0, 10) });
const idr8 = /registrado: (\S+)/.exec(r.out)?.[1];
qc = pedidoDe(marca("confirm-review-record", idr8));
r = run(["confirm-review-record", "--as", "Claude 5 ibqho", idr8, "--reason", "t", ...qc.args], { ...as("ibq"), ...qc.env });
is("the named session does not confirm a record of a PR it wrote", !r.ok && /escreveu/.test(r.out), r.out);
raw("fila/feitas/20261121T000000Z-claude-2-0003.md", `Resultado: enfileirado\nPR: 2\nHead: ${H2.slice(0, 10)}\nPor: Claude 5 ibqho\n\nfila #2\nSessão: session_012ST5ibqhoHCYrphJXU5az3 (claude-5)\n`);
r = rec("Claude 4 X", 2, H2, { ...as("c4"), FAKE_GH: "ok", FAKE_PR: "2", FAKE_SHA: H2.slice(0, 10) });
const idr2 = /registrado: (\S+)/.exec(r.out)?.[1];
qc = pedidoDe(marca("confirm-review-record", idr2));
r = run(["confirm-review-record", "--as", "Claude 5 ibqho", idr2, "--reason", "t", ...qc.args], { ...as("ibq"), ...qc.env });
is("the named session does not confirm a record of a PR it enqueued", !r.ok && /enfileirou/.test(r.out), r.out);
is("a confirmed record takes the family out of the queue", /confirmado pelo coordenador\) +tira a família/.test(run(["list-review-records", "--pr", "2"]).out));

r = rec("Claude 3 X", 2, H2, { FAKE_GH: "ok", FAKE_PR: "2", FAKE_SHA: H2.slice(0, 10) });
const id3 = /registrado: (\S+)/.exec(r.out)?.[1];
raw(`revisao/confirmados/${id3}`, "Claude 5 X\n2026-11-21T00:00:00Z\nraw\n");
is("a confirmation written without the coordinator's session takes no one out", new RegExp(`${id3}.*não tira ninguém da fila`).test(run(["list-review-records", "--pr", "2"]).out));
r = rec("Claude 2 X", 2, H2, { ...as("c2"), FAKE_GH: "down" });
is("gh down: the record is kept, its link shown as NÃO CONFERIDO (R2)", r.ok && /link NÃO CONFERIDO/.test(r.out), r.out);
r = rec("Claude 2 X", 2, H2, { ...as("c2"), FAKE_GH: "nohead", FAKE_PR: "2" });
is("a comment that does not cite the head is shown as not checked", r.ok && /não cita o head/.test(r.out), r.out);
r = run(["record-review", "--as", "Claude 2 X", "--pr", "2", "--sha", H2.slice(0, 10), "--result", "READY", "--link", link(2)], as("c6"));
is("a Claude 6 session cannot record under Claude 2's name", !r.ok && /identidade/.test(r.out), r.out);
// Step 6, A15: the comment must carry the verdict given, and come from someone who works on the repository.
r = rec("Claude 2 X", 2, H2, { ...as("c2"), FAKE_GH: "rev", FAKE_PR: "2", FAKE_BODY: `Review @${H2.slice(0, 10)}: CHANGES, one MEDIUM` });
is("a READY record whose comment says CHANGES is shown as not checked (A15)", r.ok && /não traz o veredito READY/.test(r.out), r.out);
r = rec("Claude 2 X", 2, H2, { ...as("c2"), FAKE_GH: "rev", FAKE_PR: "2", FAKE_BODY: `Review @${H2.slice(0, 10)}: READY`, FAKE_ASSOC: "NONE" });
is("a comment from someone outside the repository does not check the record (A15)", r.ok && /não é de quem trabalha no repositório/.test(r.out), r.out);
// LOW 1 of Claude 2 lpgvy on #5113: a CHANGES review that mentions READY further down is not a READY.
r = rec("Claude 2 X", 2, H2, { ...as("c2"), FAKE_GH: "rev", FAKE_PR: "2", FAKE_BODY: `Review #2 @${H2.slice(0, 10)} — CHANGES, one MEDIUM.\\nNeeds 2 focal READY on the head that fixes it.` });
is("a CHANGES comment that mentions READY below its first line does not check a READY record (A15)", r.ok && /não traz o veredito READY/.test(r.out), r.out);
r = rec("Claude 2 X", 2, H2, { ...as("c2"), FAKE_GH: "rev", FAKE_PR: "2", FAKE_BODY: `Review #2 @${H2.slice(0, 10)} — READY, 0 findings.\\nNo CHANGES asked.` });
is("a READY first line checks the record even when CHANGES appears below it (A15)", r.ok && !/não traz o veredito/.test(r.out) && !/Link conferido: NÃO/.test(r.out), r.out);

console.log("a record counts only for its head (2.3)");
g(["checkout", "-q", "pr1"], P); const H1b = commit("f1.txt", "1b\n", "pr1 b"); g(["push", "-q", "../prs.git", "HEAD:refs/pull/1/head"], P);
r = run(["list-review-records", "--pr", "1"]);
is("after a new head, the old record shows the head difference", new RegExp(`head ${H1.slice(0, 10)} diferente do atual ${H1b.slice(0, 10)}`).test(r.out), r.out);
r = run(["request-enqueue", "--from", "Claude 2", "--pr", "1", "--sha", H1b.slice(0, 10), "--text", "fila #1 b"], { ...as("c2"), CORREIO_SEM_COMMITS: "1" });
r = run(["claim-enqueue", "--as", "Claude 4 X"], as("c4"));
is("the family that reviewed the old head may claim the enqueue of the new head", /pegou/.test(r.out), r.out);
run(["release-enqueue", "--as", "Claude 4 X", /pegou: (\S+)/.exec(r.out)?.[1] ?? "x", "--reason", "teste"], as("c4"));

console.log("head changed between request and claim (0.2)");
r = run(["claim-enqueue", "--as", "Claude 6 X"], as("c6"));
const idb = /pegou: (\S+)/.exec(r.out)?.[1];
run(["complete-enqueue", "--as", "Claude 6 X", idb ?? "x", "--result", "enqueued", "--text", "t"], { ...as("c6"), FAKE_READY_ALL: "1" });
const H3req = H3.slice(0, 10);
run(["request-enqueue", "--from", "Claude 2", "--pr", "3", "--sha", H3req, "--text", "fila #3"], { ...as("c2"), CORREIO_SEM_COMMITS: "1" });
g(["checkout", "-q", "pr3"], P); commit("a.txt", "um b\n", "pr3 b"); g(["push", "-q", "../prs.git", "HEAD:refs/pull/3/head"], P);
r = run(["claim-enqueue", "--as", "Claude 6 X"], as("c6"));
is("a changed head is declined with the reason", /mudou de/.test(r.out) && /recusado/.test(r.out), r.out);

console.log("stale refs/pull/N/head: the head is read from the PR's branch (#5040, 21/11/2026)");
// PR 4 has a branch, and its refs/pull/4/head lags one commit behind the branch, as GitHub's did for #5040.
g(["checkout", "-q", "-B", "pr4", M], P); const H4a = commit("f4.txt", "4\n", "pr4"); g(["push", "-q", "../prs.git", "HEAD:refs/pull/4/head"], P);
const H4b = commit("f4.txt", "4b\n", "pr4 b"); g(["push", "-q", "../prs.git", "HEAD:refs/heads/feature-4"], P);
r = run(["request-enqueue", "--from", "Claude 2", "--pr", "4", "--sha", H4b.slice(0, 10), "--text", "fila #4"], { ...as("c2"), CORREIO_SEM_COMMITS: "" });
is("request-enqueue records the PR's branch from the head", r.ok && new RegExp("Ramo: feature-4").test(g(["show", `refs/heads/correio:fila/pedidos/${/registrado: (\S+)/.exec(r.out)?.[1]}.md`], join(T, "mail.git"))), r.out);
r = run(["claim-enqueue", "--as", "Claude 6 X"], as("c6"));
is("a request at the branch head is not declined while refs/pull/N/head lags", /pegou/.test(r.out) && /igual ao do pedido \(pelo ramo feature-4\)/.test(r.out), r.out);
run(["complete-enqueue", "--as", "Claude 6 X", /pegou: (\S+)/.exec(r.out)?.[1] ?? "x", "--result", "enqueued", "--text", "t"], { ...as("c6"), FAKE_READY_ALL: "1" });
g(["checkout", "-q", "pr4"], P); const H4c = commit("f4.txt", "4c\n", "pr4 c");
// H4c is not pushed yet, so the request finds no branch, and the local refs/pull/4/head (still H4a) is authoritative:
// since step 4 the request itself is refused, instead of being recorded and declined at the take.
r = run(["request-enqueue", "--from", "Claude 2", "--pr", "4", "--sha", H4c.slice(0, 10), "--text", "fila #4 c"], { ...as("c2"), CORREIO_SEM_COMMITS: "" });
is("without a recorded branch, a local repository's refs/pull is authoritative and a request for another head is refused", !r.ok && /não é o head atual/.test(r.out), r.out);
g(["push", "-q", "../prs.git", "HEAD:refs/heads/feature-4"], P);
g(["checkout", "-q", "pr4"], P); const H4d = commit("f4.txt", "4d\n", "pr4 d"); g(["push", "-q", "../prs.git", "HEAD:refs/heads/feature-4"], P);
run(["request-enqueue", "--from", "Claude 2", "--pr", "4", "--sha", H4d.slice(0, 10), "--text", "fila #4 d"], { ...as("c2"), CORREIO_SEM_COMMITS: "" });
const H4e = commit("f4.txt", "4e\n", "pr4 e"); g(["push", "-q", "../prs.git", "HEAD:refs/heads/feature-4"], P);
r = run(["claim-enqueue", "--as", "Claude 6 X"], as("c6"));
is("a real push to the branch after the request is declined as a changed head", /mudou de/.test(r.out) && new RegExp(H4e.slice(0, 10)).test(r.out), r.out);

console.log("a backup branch at an old head is not taken for the PR's branch (review of Claude 2 upbeat)");
g(["checkout", "-q", "-B", "pr7", M], P); const H7a = commit("f7.txt", "7\n", "pr7");
g(["push", "-q", "../prs.git", "HEAD:refs/heads/backup-7"], P);
const H7b = commit("f7.txt", "7b\n", "pr7 b"); g(["push", "-q", "../prs.git", "HEAD:refs/heads/feature-7"], P); g(["push", "-q", "../prs.git", "HEAD:refs/pull/7/head"], P);
r = run(["request-enqueue", "--from", "Claude 2", "--pr", "7", "--sha", H7a.slice(0, 10), "--text", "fila #7 (old head)\nRamo: backup-7"], { ...as("c2"), CORREIO_SEM_COMMITS: "" });
is("a request for an old head held only by a backup branch is refused (step 4), naming the PR's head", !r.ok && /não é o head atual/.test(r.out) && new RegExp(H7b.slice(0, 10)).test(r.out), r.out);
is("a 'Ramo:' line in the free text does not make it pass: nothing is recorded for #7", !/#7 @/.test(run(["list-queue"]).out), run(["list-queue"]).out);

console.log("switch off returns to the old behaviour (R1)");
r = run(["set-switch", "--as", "Claude 2 X", "--name", "record-review", "--off", "--reason", "parar"], as("c2"));
is("any session can turn a switch off", r.ok && /DESLIGADO/.test(r.out), r.out);
r = rec("Claude 4 X", 2, H2, { ...as("c4"), FAKE_GH: "ok", FAKE_PR: "2", FAKE_SHA: H2.slice(0, 10) });
is("with the switch off, record-review is refused", !r.ok && /DESLIGADO/.test(r.out), r.out);
is("with the switch off, no record takes anyone out of the queue", !/tira a família/.test(run(["list-review-records", "--pr", "2"]).out));

console.log("concurrency and order");
ligar("Claude 5 ibqho", "ibq", pedidoDe(marca("set-switch", "record-review")));
const par = await Promise.all(["c4", "c2"].map((k) => new Promise((ok) => {
  const p = spawn("node", [TOOL, "record-review", "--as", k === "c4" ? "Claude 4 Y" : "Claude 2 Y", "--pr", "2", "--sha", H2.slice(0, 10), "--result", "READY", "--link", link(2)],
    { cwd: join(T, "w"), env: { ...base, ...as(k), FAKE_GH: "ok", FAKE_PR: "2", FAKE_SHA: H2.slice(0, 10) } });
  let out = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; }); p.on("close", (c) => ok({ c, out }));
})));
is("two agents recording at the same time both land", par.every((x) => x.c === 0 && /registrado/.test(x.out)), par.map((x) => x.out).join("\n"));
const fila = run(["list-queue"]).out.trim().split("\n");
is("the queue keeps request order (ids ascending)", fila.map((l) => l.split(" ")[0]).join() === [...fila.map((l) => l.split(" ")[0])].sort().join(), fila.join("\n"));

console.log("GitHub refs/pull/N/head alone, different head: held first, no take (review of Claude 4 3Kc)");
// A PR repository whose path contains github.com is read as GitHub: refs/pull/N/head alone can lag there.
const GH = join(T, "github.com", "o", "r.git"); mkdirSync(GH, { recursive: true }); g(["init", "-q", "--bare", GH]);
g(["push", "-q", GH, `${M}:refs/heads/main`], P);
g(["checkout", "-q", "-B", "pr6", M], P); const H6a = commit("f6.txt", "6\n", "pr6"); g(["push", "-q", GH, "HEAD:refs/pull/6/head"], P);
const H6b = commit("f6.txt", "6b\n", "pr6 b");
const ghEnv = (k) => ({ ...as(k), CORREIO_PR_REPO: GH, CORREIO_SEM_COMMITS: "" });

// Since step 4 (Claude 5 ibuF's MEDIUM on #5069): on GitHub, a request needs the PR's branch, found from the head or,
// for a stale head, from the PR's current reference; without it nothing is requested, so no request can hold the queue.
r = run(["request-enqueue", "--from", "Claude 2", "--pr", "6", "--sha", H6b.slice(0, 10), "--text", "fila #6"], ghEnv("c2"));
is("on GitHub, with no branch of the PR found, the request is refused (it could never be delivered)", !r.ok && /ramo de #6 não foi achado/.test(r.out), r.out);
is("so nothing holds the first place of the queue", !/#6 @/.test(run(["list-queue"]).out), run(["list-queue"]).out);
g(["push", "-q", GH, `${H6b}:refs/heads/feature-6`], P);
r = run(["request-enqueue", "--from", "Claude 2", "--pr", "6", "--sha", H6b.slice(0, 10), "--text", "fila #6"], ghEnv("c2"));
const id6 = /registrado: (\S+)/.exec(r.out)?.[1];
is("with the branch at the new head while refs/pull/6/head lags, the request records the branch and the full head", r.ok && /^Ramo: feature-6$/m.test(g(["show", `refs/heads/correio:fila/pedidos/${id6}.md`], join(T, "mail.git"))) && new RegExp(`^Head: ${H6b}$`, "m").test(g(["show", `refs/heads/correio:fila/pedidos/${id6}.md`], join(T, "mail.git"))), r.out);
r = run(["claim-enqueue", "--as", "Claude 6 X"], ghEnv("c6"));
is("the take checks the head by the branch, not by the lagging reference, and delivers it", /pegou/.test(r.out) && /pelo ramo feature-6/.test(r.out), r.out);
run(["complete-enqueue", "--as", "Claude 6 X", id6, "--result", "declined", "--text", "fim do teste"], ghEnv("c6"));
g(["checkout", "-q", "pr6"], P); const H6c = commit("f6.txt", "6c\n", "pr6 c"); g(["push", "-q", GH, `${H6c}:refs/heads/feature-6`], P); g(["push", "-q", GH, `${H6c}:refs/pull/6/head`], P);
r = run(["request-enqueue", "--from", "Claude 2", "--pr", "6", "--sha", H6b.slice(0, 10), "--text", "fila #6 stale"], ghEnv("c2"));
is("on GitHub, a request for a stale head is refused: the branch is found from the PR's reference", !r.ok && /não é o head atual/.test(r.out) && new RegExp(H6c.slice(0, 10)).test(r.out), r.out);
// A request recorded before step 4, with no Ramo:, is held at the take; the hint must be one that works: pedir refuses a
// second request for the same PR and head, so the author cancels first (Claude 7 3uv's LEVE on #5069).
{
  g(["init", "-q", "--bare", "mail5.git"]); g(["push", "-q", "../mail5.git", "HEAD:refs/heads/correio"], join(T, "w"));
  const m5 = { CORREIO_REPO: join(T, "mail5.git") };
  run(["request-enqueue", "--from", "Claude 2", "--pr", "6", "--sha", H6c.slice(0, 10), "--text", "old-style, no branch"], { ...ghEnv("c2"), ...m5, CORREIO_SEM_COMMITS: "1" });
  r = run(["claim-enqueue", "--as", "Claude 6 X"], { ...ghEnv("c6"), ...m5 });
  is("an old request without a branch is held, and the hint says to cancel it first and request again", /NÃO CONFERIDO agora/.test(r.out) && /cancel-enqueue/.test(r.out), r.out);
}

console.log("unidentified writes are marked when read (OWNER-20261121-1904 step 2)");
run(["send", "--from", "Codex X", "--to", "Claude 3 Z", "--subject", "s", "--text", "sem sessão"]);
r = run(["read", "--as", "Claude 3 Z"], { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_014YNUxAAAAAAAAAAAAAAAAA" });
is("a message written outside the Claude Code cloud is shown as unidentified", /ATENÇÃO: escrita não identificada/.test(r.out), r.out);

console.log("order by the commit sequence; instants in the future refused; off prevails (OWNER-20261121-1904 step 3)");
{
  const H10 = pr(10, "f10.txt", "10\n");
  run(["request-enqueue", "--from", "Claude 2", "--pr", "10", "--sha", H10.slice(0, 10), "--text", "fila #10"], { ...as("c2"), CORREIO_SEM_COMMITS: "1" });
  // A request written later with an old-looking id must not jump the queue.
  raw("fila/pedidos/20200101T000000Z-claude-3-x-aaaa.md", `Tipo: fila\nPR: 11\nHead: ${"b".repeat(10)}\nAutor: Claude 3 X\nId: 20200101T000000Z-claude-3-x-aaaa\n`);
  const linhasFila = run(["list-queue"]).out.split("\n");
  const i10 = linhasFila.findIndex((l) => /#10 @/.test(l)), i11 = linhasFila.findIndex((l) => /#11 @/.test(l));
  is("a request is placed by the commit that wrote it, not by its self-declared id", i10 >= 0 && i11 > i10, linhasFila.join("\n"));
  const id10 = /^(\S+) +#10 @/m.exec(run(["list-queue"]).out)?.[1];
  raw(`fila/tomadas/${id10}/0`, "20991231T000000Z-claude-7-x-ffff\nClaude 7 X\n");
  is("a take dated in the future does not hold the request", /#10 @\S+ +autor Claude 2 +aberto/.test(run(["list-queue"]).out), run(["list-queue"]).out);
  // A valid ON, copied with a filename far in the future, is ignored.
  const mail = join(T, "mail.git");
  const ons = g(["ls-tree", "-r", "--name-only", "refs/heads/correio", "chaves/record-review"], mail).split("\n")
    .map((c) => ({ c, t: g(["show", `refs/heads/correio:${c}`], mail) })).filter((x) => /^ON\nClaude 5 ibqho\n/.test(x.t) && /^Pedido: /m.test(x.t));
  // Run against the audited version (step 7), no valid ON was ever written: a fixed one stands in, so the run goes on.
  const valido = ons.length ? ons[ons.length - 1].t : "ON\nClaude 5 ibqho\nteste\nPedido: https://github.com/solrenning-llc/marktmorgen/issues/4932#issuecomment-1\nSessão: session_012ST5ibqhoHCYrphJXU5az3 (claude-5)\n";
  raw("chaves/on-call/4102444800000-claude-5-ibqho-ab12", valido);
  is("an ON whose instant is in the future is ignored", /on-call: DESLIGADO/.test(run(["list-switches"]).out), run(["list-switches"]).out);
  // A valid ON stamped 3 minutes ahead and written first, then an OFF written after it: the OFF, written last, holds.
  raw(`chaves/ready-check/${Date.now() + 180000}-claude-5-ibqho-cd56`, valido);
  run(["set-switch", "--as", "Claude 2 X", "--name", "ready-check", "--off", "--reason", "depois"], as("c2"));
  is("the switch follows the commit order: an OFF written after an ON stamped later still holds", /ready-check: DESLIGADO/.test(run(["list-switches"]).out), run(["list-switches"]).out);
  // An OFF stamped 3 minutes ahead and written first, then a valid ON written after it: off prevails.
  raw(`chaves/record-review/${Date.now() + 180000}-claude-2-x-ef78`, "OFF\nClaude 2 X\nparar\n");
  ligar("Claude 5 ibqho", "ibq", pedidoDe(marca("set-switch", "record-review")));
  is("off prevails: an ON is not on while an OFF carries a later instant", /record-review: DESLIGADO/.test(run(["list-switches"]).out), run(["list-switches"]).out);
  raw("prs/12/0", "Ação: CLAIMED\nPR: 12\nPor: Claude 7 X\nData: 2099-01-01T00:00:00.000Z\n");
  is("a CLAIMED dated in the future is not active", !/\(ativo\)/.test(run(["pr-status", "--pr", "12"]).out), run(["pr-status", "--pr", "12"]).out);
  run(["set-quota", "--as", "Claude 3 X", "--available"], { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_014YNUxAAAAAAAAAAAAAAAAA" });
  raw("estado/claude-3/20200101T000000Z-claude-3-x-aaaa", "Cota: sem\nVolta: 2099-01-01T00:00:00.000Z\nPor: Claude 3 X\n");
  is("the quota written last holds, whatever its mark says", /claude-3: SEM COTA/.test(run(["list-quotas"]).out), run(["list-quotas"]).out);
}

console.log("takes by commit, a capped future OFF, the maximum take, the coordinator's release (OWNER-20261121-1904 step 3, part 2)");
{
  const carimbo = (ms) => new Date(Date.now() + ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const H13 = pr(13, "f13.txt", "13\n");
  run(["request-enqueue", "--from", "Claude 2", "--pr", "13", "--sha", H13.slice(0, 10), "--text", "fila #13"], { ...as("c2"), CORREIO_SEM_COMMITS: "1" });
  const id13 = /^(\S+) +#13 @/m.exec(run(["list-queue"]).out)?.[1];
  // Takes by commit, not by their number (note 2 of Claude 5 ibqho on #5055).
  raw(`fila/tomadas/${id13}/7`, `${carimbo(-60000)}-claude-7-x-aa01\nClaude 7 X\n`);
  raw(`fila/tomadas/${id13}/3`, `${carimbo(-30000)}-claude-1-x-aa02\nClaude 1 X\n`);
  is("the latest take is the one written last, whatever its number", /#13 @\S+ +autor Claude 2 +tomado por Claude 1 X/.test(run(["list-queue"]).out), run(["list-queue"]).out);
  // The maximum take: renewals by the same holder stop counting 30 minutes after the first take of the run.
  const H14 = pr(14, "f14.txt", "14\n");
  run(["request-enqueue", "--from", "Claude 2", "--pr", "14", "--sha", H14.slice(0, 10), "--text", "fila #14"], { ...as("c2"), CORREIO_SEM_COMMITS: "1" });
  const id14 = /^(\S+) +#14 @/m.exec(run(["list-queue"]).out)?.[1];
  [-40, -31, -22, -13, -4].forEach((m, n) => raw(`fila/tomadas/${id14}/${n}`, `${carimbo(m * 60000)}-claude-7-x-bb0${n}\nClaude 7 X\n`));
  is("a take renewed for more than 30 minutes no longer holds the request", /#14 @\S+ +autor Claude 2 +aberto/.test(run(["list-queue"]).out), run(["list-queue"]).out);
  // A fresh take by the same session after its old take lapsed starts a new run (review of Claude 4 AC on #5057).
  const H16 = pr(16, "f16.txt", "16\n");
  run(["request-enqueue", "--from", "Claude 2", "--pr", "16", "--sha", H16.slice(0, 10), "--text", "fila #16"], { ...as("c2"), CORREIO_SEM_COMMITS: "1" });
  const id16 = /^(\S+) +#16 @/m.exec(run(["list-queue"]).out)?.[1];
  raw(`fila/tomadas/${id16}/0`, `${carimbo(-50 * 60000)}-claude-7-x-ee01\nClaude 7 X\n`);
  raw(`fila/tomadas/${id16}/1`, `${carimbo(-60000)}-claude-7-x-ee02\nClaude 7 X\n`);
  is("a fresh take by the same session after its old take lapsed holds the request", /#16 @\S+ +autor Claude 2 +tomado por Claude 7 X/.test(run(["list-queue"]).out), run(["list-queue"]).out);
  // A future-dated OFF is capped at its commit time (note 1 of Claude 5 ibqho and of Claude 4 Z on #5055).
  raw("chaves/on-call/4102444800001-claude-2-x-cc01", "OFF\nClaude 2 X\nrelógio errado\n");
  ligar("Claude 5 ibqho", "ibq", pedidoDe(marca("set-switch", "on-call")), [], "on-call");
  is("an OFF stamped far in the future no longer blocks a later ON", /on-call: LIGADO/.test(run(["list-switches"]).out), run(["list-switches"]).out);
  run(["set-switch", "--as", "Claude 2 X", "--name", "on-call", "--off", "--reason", "fim do teste"], as("c2"));
  // The coordinator's release of a stuck take: privileged, on a #4932 request that names the request id.
  const H15 = pr(15, "f15.txt", "15\n");
  run(["request-enqueue", "--from", "Claude 2", "--pr", "15", "--sha", H15.slice(0, 10), "--text", "fila #15"], { ...as("c2"), CORREIO_SEM_COMMITS: "1" });
  const id15 = /^(\S+) +#15 @/m.exec(run(["list-queue"]).out)?.[1];
  raw(`fila/tomadas/${id15}/0`, `${carimbo(-60000)}-claude-7-x-dd01\nClaude 7 X\n`);
  let q = pedidoDe(marca("release-take", id15));
  r = run(["release-take", "--as", "Claude 6 X", id15, "--reason", "travada", ...q.args], { ...as("c6"), ...q.env });
  is("only the named session releases a take", !r.ok && /sessão nomeada/.test(r.out), r.out);
  q = pedidoDe(marca("release-take", "outro"));
  r = run(["release-take", "--as", "Claude 5 ibqho", id15, "--reason", "travada", ...q.args], { ...as("ibq"), ...q.env });
  is("a request that does not name the request id is refused", !r.ok && /não traz a linha/.test(r.out), r.out);
  q = pedidoDe(marca("release-take", id15));
  r = run(["release-take", "--as", "Claude 5 ibqho", id15, "--reason", "travada", ...q.args], { ...as("ibq"), ...q.env, CORREIO_SEM_COMMITS: "1" });
  is("the commits of the PR cannot be checked: nothing is released", !r.ok && /NÃO FORAM CONFERIDOS/.test(r.out), r.out);
  q = pedidoDe(marca("release-take", id15));
  r = run(["release-take", "--as", "Claude 5 ibqho", id15, "--reason", "travada", ...q.args], { ...as("ibq"), ...q.env });
  is("the named session releases a stuck take, and the request is open again", r.ok && /#15 @\S+ +autor Claude 2 +aberto/.test(run(["list-queue"]).out), r.out + run(["list-queue"]).out);
  is("the release is announced to all, with the request", /tomada .*#15.* liberada/.test(run(["read", "--as", "Claude 2 Z"], as("c2")).out), run(["read", "--as", "Claude 2 Z"], as("c2")).out);
  raw(`fila/tomadas/${id15}/9`, `${carimbo(-1000)}-claude-7-x-dd02\nClaude 7 X\n`);
  raw(`fila/tomadas/${id15}/10`, `${carimbo(0)}-claude-7-x-dd03\nClaude 7 X\nLIBERADO\nforged\n`);
  is("a release written without the named session and the request does not count", /#15 @\S+ +autor Claude 2 +tomado por Claude 7 X/.test(run(["list-queue"]).out), run(["list-queue"]).out);
}

console.log("step 4: a full head, nothing NOT CHECKED goes on, the take checked right before enqueueing (OWNER-20261121-1904)");
{
  // A mailbox of its own, so the queue here starts empty.
  g(["init", "-q", "--bare", "mail4.git"]); g(["push", "-q", "../mail4.git", "HEAD:refs/heads/correio"], join(T, "w"));
  const m4 = { CORREIO_REPO: join(T, "mail4.git") };
  const H17 = pr(17, "f17.txt", "17\n");
  r = run(["request-enqueue", "--from", "Claude 2", "--pr", "17", "--sha", H17.slice(0, 10), "--text", "fila #17"], { ...as("c2"), ...m4 });
  const id17 = /registrado: (\S+)/.exec(r.out)?.[1];
  is("a request is recorded with the full 40-character head", r.ok && new RegExp(`^Head: ${H17}$`, "m").test(g(["show", `refs/heads/correio:fila/pedidos/${id17}.md`], join(T, "mail4.git"))), r.out);
  r = run(["request-enqueue", "--from", "Claude 2", "--pr", "17", "--sha", H1.slice(0, 10), "--text", "wrong head"], { ...as("c2"), ...m4 });
  is("a request for a head that is not the PR's current one is refused", !r.ok && /não é o head atual/.test(r.out), r.out);
  r = run(["claim-enqueue", "--as", "Claude 6 X"], { ...as("c6"), ...m4 });
  is("the request is delivered", /pegou/.test(r.out), r.out);
  r = run(["verify-enqueue", "--as", "Claude 6 X", id17], { ...as("c6"), ...m4, FAKE_READY_ALL: "1" });
  is("verify-enqueue right before enqueueing: the take is this session's and the head is unchanged", r.ok && new RegExp(`enfileire ${H17}`).test(r.out), r.out);
  r = run(["verify-enqueue", "--as", "Claude 6 Y", id17], { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_018ZjhHYYYYYYYYYYYYYYYYYY", ...m4 });
  is("another session of the same family does not hold that take", !r.ok && /não é desta sessão/.test(r.out), r.out);
  g(["checkout", "-q", "pr17"], P); const H17b = commit("f17.txt", "17b\n", "pr17 b"); g(["push", "-q", "../prs.git", "HEAD:refs/pull/17/head"], P);
  r = run(["verify-enqueue", "--as", "Claude 6 X", id17], { ...as("c6"), ...m4 });
  is("after a new push, verify-enqueue refuses: the head changed", !r.ok && /mudou/.test(r.out), r.out);
  r = run(["complete-enqueue", "--as", "Claude 6 X", id17, "--result", "enqueued", "--text", "t"], { ...as("c6"), ...m4 });
  is("complete-enqueue as enqueued is refused when the head changed", !r.ok && /mudou/.test(r.out), r.out);
  run(["complete-enqueue", "--as", "Claude 6 X", id17, "--result", "declined", "--text", "head changed"], { ...as("c6"), ...m4 });
  r = run(["request-enqueue", "--from", "Claude 2", "--pr", "17", "--sha", H17b.slice(0, 10), "--text", "fila #17 b"], { ...as("c2"), ...m4 });
  const id17b = /registrado: (\S+)/.exec(r.out)?.[1];
  run(["claim-enqueue", "--as", "Claude 6 X"], { ...as("c6"), ...m4 });
  r = run(["complete-enqueue", "--as", "Claude 6 X", id17b, "--result", "enqueued", "--text", "fila #17 b"], { ...as("c6"), ...m4, FAKE_READY_ALL: "1" });
  is("the completion records the head that was enqueued", r.ok && new RegExp(`^Head enfileirado: ${H17b}$`, "m").test(g(["show", `refs/heads/correio:fila/feitas/${id17b}.md`], join(T, "mail4.git"))), r.out);
  // A git command that hangs is stopped by the time limit.
  const mod = await import(TOOL);
  let erro = "";
  try { mod.git(["-c", "alias.dorme=!sleep 5", "dorme"], undefined, 500); } catch (e) { erro = String(e.message ?? e); }
  is("a git command past its time limit is stopped, with a clear error", /limite de tempo|ETIMEDOUT/.test(erro), erro);
}

console.log("test variables only with the marker and local repositories (OWNER-20261121-1904 step 4, part 2)");
{
  const mod = await import(TOOL);
  const antes = { m: process.env.AGENT_MAIL_TEST, c: process.env.CORREIO_SEM_COMMITS };
  process.env.AGENT_MAIL_TEST = "1"; process.env.CORREIO_SEM_COMMITS = "1";
  // Imported here without CORREIO_REPO, the tool points at the real GitHub mailbox: a test variable must not count.
  is("with the marker but the real GitHub repositories, a test variable does not count", typeof mod.testeLigado === "function" && mod.testeLigado("CORREIO_SEM_COMMITS") === false, String(mod.REPO));
  for (const [k, v] of [["AGENT_MAIL_TEST", antes.m], ["CORREIO_SEM_COMMITS", antes.c]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
// "Local" means a local path: an absolute path or file://, never another remote form (LOW of Claude 1 2as and Claude 4 Z on #5088).
const ligadoCom = (repo) => spawnSync("node", ["--input-type=module", "-e", `const m = await import(${JSON.stringify(TOOL)}); console.log(String(m.testeLigado("CORREIO_SEM_COMMITS")));`],
  { env: { ...base, CORREIO_REPO: repo, CORREIO_SEM_COMMITS: "1" }, encoding: "utf8" }).stdout.trim().split("\n").pop();
for (const remoto of ["deploy@github.com:solrenning-llc/repo-id-transfer-test", "github.com:solrenning-llc/repo-id-transfer-test", "ftp://h/x", "ext::sh -c true", "relative/mail.git"]) {
  is(`a test variable does not count with the mailbox at ${remoto}`, ligadoCom(remoto) === "false", ligadoCom(remoto));
}
is("it counts with an absolute local path", ligadoCom(join(T, "mail.git")) === "true", ligadoCom(join(T, "mail.git")));
is("and with a file:// address", ligadoCom(`file://${join(T, "mail.git")}`) === "true", ligadoCom(`file://${join(T, "mail.git")}`));

console.log("whose mark it is: another family's quota, the HOLD and the CLAIMED per session (OWNER-20261121-1904 step 5)");
{
  g(["init", "-q", "--bare", "mail6.git"]); g(["push", "-q", "../mail6.git", "HEAD:refs/heads/correio"], join(T, "w"));
  const m6 = { CORREIO_REPO: join(T, "mail6.git") };
  const C3 = "cse_014YNUxAAAAAAAAAAAAAAAAA", C3B = "cse_014YNUxBBBBBBBBBBBBBBBBB", C4B = "cse_01S9eVAzzzzzzzzzzzzzzzzz";
  const em = (k) => (k.startsWith("cse_") ? { CLAUDE_CODE_REMOTE_SESSION_ID: k } : as(k));
  const q6 = (who, k, args, extra = {}) => run([...args, ...(who ? ["--as", who] : [])], { ...m6, ...em(k), ...extra });
  const quotas = () => run(["list-quotas"], m6).out;
  // PR 20 is Claude 3's: its commit carries a Claude 3 session trailer.
  g(["checkout", "-q", "-B", "pr20", M], P); commit("f20.txt", "20\n", "pr20\n\nClaude-Session: https://claude.ai/code/session_014YNUxAAAAAAAAAAAAAAAAA"); g(["push", "-q", "../prs.git", "HEAD:refs/pull/20/head"], P);
  g(["checkout", "-q", "-B", "pr21", M], P); commit("f21.txt", "21\n", "pr21\n\nClaude-Session: https://claude.ai/code/session_014YNUxAAAAAAAAAAAAAAAAA"); g(["push", "-q", "../prs.git", "HEAD:refs/pull/21/head"], P);

  // A6: another family's quota only by that family or the coordinator.
  r = q6("Claude 3 Z", "c6", ["set-quota", "--exhausted", "--until", "2099-01-01T00:00Z", "--by", "Claude 6 Z"]);
  is("Claude 6 cannot declare Claude 3 out of quota", !r.ok && /própria família ou (pelo )?coordenador/.test(r.out), r.out);
  is("so Claude 3 still counts as with quota", /claude-3: com cota/.test(quotas()), quotas());
  r = q6("Claude 3 Z", C3B, ["set-quota", "--exhausted", "--until", "2099-01-01T00:00Z", "--by", "Claude 3 B"]);
  is("another Claude 3 session declares its own family", r.ok && /SEM COTA/.test(quotas()), r.out + quotas());
  r = q6("Claude 3 Z", C3, ["set-quota", "--available"]);
  is("and Claude 3 declares the quota back", r.ok && /claude-3: com cota/.test(quotas()), r.out + quotas());
  let q = pedidoDe(marca("set-quota", "claude-3"));
  r = q6("Claude 3 Z", "ibq", ["set-quota", "--exhausted", "--until", "2099-01-01T00:00Z", "--by", "Claude 5 ibqho", ...q.args], q.env);
  is("the named session declares another family's quota on a coordinator request", r.ok && /claude-3: SEM COTA/.test(quotas()), r.out + quotas());
  r = q6("Claude 3 Z", "ibq", ["set-quota", "--available", "--by", "Claude 5 ibqho", ...q.args], q.env);
  is("the same request is not used twice", !r.ok && /já foi usado/.test(r.out), r.out);
  q6("Claude 3 Z", C3, ["set-quota", "--available"]);
  // A record of another family's quota written by raw git from a Claude 6 session does not count.
  raw(`estado/claude-3/29990101T000000Z-claude-6-z-ab12`, "Cota: sem\nVolta: 2099-01-01T00:00:00.000Z\nPor: Claude 6 Z\nData (UTC): 2026-11-22 05:00\nSessão: session_018ZjhHhUoHAGLUkhRVBUuAW (claude-6)\n", m6.CORREIO_REPO);
  is("a raw record of Claude 3's quota written by a Claude 6 session is ignored", /claude-3: com cota/.test(quotas()), quotas());
  raw(`estado/claude-7/20261121T050751Z-claude-7-b445`, "Cota: sem\nVolta: 2099-01-01T00:00:00.000Z\nPor: Claude 6 (informado pelo dono)\nData (UTC): 2026-11-21 05:07\n", m6.CORREIO_REPO);
  is("an old record, written before this version without a session line, still counts as before", /claude-7: SEM COTA/.test(quotas()), quotas());

  // A7: a HOLD is released only by whoever placed it, the PR's author or the coordinator.
  const st = (n) => run(["pr-status", "--pr", String(n)], m6).out;
  r = q6("Claude 4 X", "c4", ["hold-pr", "--pr", "20", "--reason", "cost ceiling"]);
  is("Claude 4 holds #20", r.ok && /HOLD por Claude 4 X/.test(st(20)), r.out + st(20));
  r = q6("Claude 2 X", "c2", ["release-pr", "--pr", "20"]);
  is("Claude 2 (not the one who held it, not the author) cannot release the HOLD", !r.ok && /HOLD/.test(r.out) && /HOLD por Claude 4 X/.test(st(20)), r.out + st(20));
  r = q6("Claude 4 X", C4B, ["claim-pr", "--pr", "20"]);
  is("a CLAIMED does not replace an active HOLD, even from the family that held it", !r.ok && /HOLD por Claude 4 X/.test(st(20)), r.out + st(20));
  r = q6("Claude 3 Z", C3, ["release-pr", "--pr", "20"]);
  is("the PR's author (a family with commits on it) releases the HOLD", r.ok && /LIBERADO/.test(st(20)), r.out + st(20));
  q6("Claude 4 X", "c4", ["hold-pr", "--pr", "20", "--reason", "cost ceiling"]);
  q6("Claude 2 X", "c2", ["hold-pr", "--pr", "20", "--reason", "money review"]);
  r = q6("Claude 4 X", "c4", ["release-pr", "--pr", "20"]);
  is("with two HOLDs on top of each other, the first holder cannot release the second one's", !r.ok && /HOLD por Claude 2 X/.test(st(20)), r.out + st(20));
  q = pedidoDe(marca("release-pr", "20"));
  r = q6("Claude 5 ibqho", "ibq", ["release-pr", "--pr", "20", ...q.args], q.env);
  is("the coordinator's named session releases it on a request on #4932", r.ok && /LIBERADO/.test(st(20)), r.out + st(20));
  q6("Claude 4 X", "c4", ["hold-pr", "--pr", "20", "--reason", "cost ceiling"]);
  r = q6("Claude 5 ibqho", "ibq", ["release-pr", "--pr", "20", ...q.args], q.env);
  is("a release request is used once", !r.ok && /já foi usado/.test(r.out) && /HOLD por Claude 4 X/.test(st(20)), r.out + st(20));
  raw("prs/20/99", `Ação: LIBERADO\nPR: 20\nPor: Claude 2 X\nData: ${new Date().toISOString()}\nSessão: session_01FR6Z1Q87JZvTFBRpZ8SNo8 (claude-2)\n`, m6.CORREIO_REPO);
  is("a raw release written by a session that may not release it is ignored", /HOLD por Claude 4 X/.test(st(20)) && /ativo/.test(st(20)), st(20));

  // A8: a CLAIMED belongs to the session that claimed it.
  r = q6("Claude 4 X", "c4", ["claim-pr", "--pr", "21"]);
  is("Claude 4 (session A) claims #21", r.ok && /CLAIMED por Claude 4 X/.test(st(21)), r.out + st(21));
  r = q6("Claude 4 Y", C4B, ["claim-pr", "--pr", "21"]);
  is("another session of the same family cannot take the CLAIMED over", !r.ok && /CLAIMED por Claude 4 X/.test(st(21)), r.out + st(21));
  r = q6("Claude 4 Y", C4B, ["release-pr", "--pr", "21"]);
  is("nor release it", !r.ok && /CLAIMED por Claude 4 X/.test(st(21)), r.out + st(21));
  r = q6("Claude 4 X", "c4", ["release-pr", "--pr", "21"]);
  is("the session that claimed it releases it", r.ok && /LIBERADO/.test(st(21)), r.out + st(21));
}

console.log("step 6: free text never becomes a field (A12), unidentified acks are shown (A13)");
{
  g(["init", "-q", "--bare", "mail7.git"]); g(["push", "-q", "../mail7.git", "HEAD:refs/heads/correio"], join(T, "w"));
  const m7 = { CORREIO_REPO: join(T, "mail7.git") };
  r = run(["request-review", "--from", "Claude 2 X", "--pr", "2", "--sha", H2.slice(0, 10), "--text", "what changed\nExclui: claude-6\nPreferência: Claude 7 X"], { ...m7, ...as("c2") });
  const idA12 = /pedido registrado: (\S+)/.exec(r.out)?.[1];
  r = run(["claim-review", "--as", "Claude 6 X"], { ...m7, ...as("c6") });
  is("an 'Exclui:' line in the request's free text does not exclude Claude 6 (A12)", new RegExp(`pegou: ${idA12}`).test(r.out), r.out);
  const msg = run(["send", "--from", "Claude 2 X", "--to", "Claude 3 Z", "--subject", "s", "--text", "x"], { ...m7, ...as("c2") });
  const idA13 = /enviada: (\S+)/.exec(msg.out)?.[1];
  r = run(["ack", "--as", "Claude 3 Z", idA13], m7);
  is("an unidentified ack is written with a warning (A13)", r.ok && /ATENÇÃO.*não identificada/.test(r.out), r.out);
  r = run(["read", "--as", "Claude 3 Z"], { ...m7, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_014YNUxAAAAAAAAAAAAAAAAA" });
  is("the family, reading identified, is told a message of its own was acknowledged by an unidentified write (A13)", new RegExp(`${idA13}.*não identificada|não identificada.*${idA13}`, "s").test(r.out), r.out);
  // LOW of Claude 2 lpgvy (2659): an ack from a version before A13 has no Mail-Session trailer at all; it is not an
  // unidentified write, and read does not warn about it. Only the explicit "não identificada (...)" counts.
  {
    const msgV = run(["send", "--from", "Claude 4 X", "--to", "Claude 3 Z", "--subject", "old ack", "--text", "x"], { ...m7, ...as("c4") });
    const idV = /enviada: (\S+)/.exec(msgV.out)?.[1];
    raw(`lidas/claude-3-z/${idV}`, `${new Date().toISOString()}\n`, join(T, "mail7.git"));
    const lido = run(["read", "--as", "Claude 3 Z"], { ...m7, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_014YNUxAAAAAAAAAAAAAAAAA" });
    is("an ack written before A13 (no Mail-Session trailer) is not reported as an unidentified write (2659)", Boolean(idV) && !lido.out.includes(idV), lido.out);
  }
  // LOW 2 of Claude 2 lpgvy on #5113: read looks only at acks written in the last 24 hours, not at every ack of the family.
  {
    const c = join(T, `velhas-${Math.random().toString(16).slice(2)}`);
    g(["clone", "-q", "-b", "correio", join(T, "mail7.git"), c]); mkdirSync(join(c, "lidas", "claude-3-z"), { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(join(c, "lidas", "claude-3-z", `20261101T00000${i}Z-velha-${i}`), "2026-11-01T00:00:00.000Z\nSessão: não identificada (fora da nuvem do Claude Code)\n");
    const velho = new Date(Date.now() - 3 * 86400000).toISOString();
    execFileSync("git", ["add", "."], { cwd: c }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "old acks"], { cwd: c, env: { ...process.env, GIT_AUTHOR_DATE: velho, GIT_COMMITTER_DATE: velho } });
    g(["push", "-q", "origin", "HEAD:correio"], c);
    const tr = join(T, `trace-show-${Math.random().toString(16).slice(2)}.txt`);
    spawnSync("node", [TOOL, "read", "--as", "Claude 3 Z"], { cwd: join(T, "w"), env: { ...base, ...m7, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_014YNUxAAAAAAAAAAAAAAAAA", GIT_TRACE: tr }, encoding: "utf8" });
    const lidasLidas = readFileSync(tr, "utf8").split("\n").filter((l) => /trace: built-in: git show /.test(l) && /lidas\/claude-3-z\/20261101T/.test(l)).length;
    is("read does not open the family's acks older than 24 hours (LOW 2 on #5113)", lidasLidas === 0, `${lidasLidas} old acks opened`);
  }
  // A11: one decision reads one snapshot of the mailbox. GIT_TRACE records every git command; only fetches of the mailbox count.
  const buscas = (args, env) => {
    const tr = join(T, `trace-${Math.random().toString(16).slice(2)}.txt`);
    const x = spawnSync("node", [TOOL, ...args], { cwd: join(T, "w"), env: { ...base, ...m7, ...env, GIT_TRACE: tr }, encoding: "utf8" });
    // Only reads of the mailbox branch count; a push's own negotiation (fetch --negotiate-only) is part of the write.
    const n = readFileSync(tr, "utf8").split("\n").filter((l) => /trace: built-in: git fetch /.test(l) && l.includes("mail7.git") && l.includes("+refs/heads/correio:")).length;
    return { n, out: `${x.stdout}${x.stderr}` };
  };
  let b = buscas(["claim-review", "--as", "Claude 4 X"], as("c4"));
  is("a claim with nothing to take reads the mailbox once (A11)", b.n === 1, `${b.n} fetches\n${b.out}`);
  g(["checkout", "-q", "-B", "pr22", M], P); const H22 = commit("f22.txt", "22\n", "pr22"); g(["push", "-q", "../prs.git", "HEAD:refs/pull/22/head"], P);
  run(["request-review", "--from", "Claude 2 X", "--pr", "22", "--sha", H22.slice(0, 10), "--text", "second"], { ...m7, ...as("c2") });
  b = buscas(["claim-review", "--as", "Claude 4 X"], as("c4"));
  is("a claim that takes reads one snapshot to decide and one more to write (A11)", /pegou/.test(b.out) && b.n === 2, `${b.n} fetches\n${b.out}`);
  b = buscas(["pr-status", "--pr", "2"], {});
  is("pr-status reads the mailbox once (A11)", b.n === 1, `${b.n} fetches`);
  b = buscas(["hold-pr", "--as", "Claude 4 X", "--pr", "2", "--reason", "t"], as("c4"));
  is("hold-pr reads one snapshot to decide and one more to write (A11)", b.n === 2, `${b.n} fetches\n${b.out}`);
}

console.log("step 6: the private mailbox never lands in the public clone (A14)");
{
  const W = join(T, "w");
  for (const ref of g(["for-each-ref", "--format=%(refname)", "refs/correio", "refs/agent-mail"], W).split("\n").filter(Boolean)) g(["update-ref", "-d", ref], W);
  r = run(["send", "--from", "Claude 2 X", "--to", "Claude 3 Z", "--subject", "s", "--text", "private words"], { ...as("c2"), CORREIO_REPO: join(T, "mail7.git") });
  const ponta = g(["rev-parse", "refs/heads/correio"], join(T, "mail7.git"));
  run(["watch", "--as", "Claude 3 Z", "--seconds", "1"], { CORREIO_REPO: join(T, "mail7.git"), CLAUDE_CODE_REMOTE_SESSION_ID: "cse_014YNUxAAAAAAAAAAAAAAAAA" });
  is("after a send and a watch, the clone the tool runs in has no mailbox ref (A14)", r.ok && g(["for-each-ref", "--format=%(refname)", "refs/correio", "refs/agent-mail"], W) === "", g(["for-each-ref", "refs/correio", "refs/agent-mail"], W));
  let tem = true; try { g(["cat-file", "-e", ponta], W); } catch { tem = false; }
  is("and no mailbox commit in its objects (A14)", tem === false, ponta);
  g(["update-ref", "refs/agent-mail/append-only-checked", g(["rev-parse", "HEAD"], W)], W);
  r = run(["list-queue"], { CORREIO_REPO: join(T, "mail7.git") });
  is("a mailbox ref left by an older version in the clone is reported, with the command to delete it (A14)", /ATENÇÃO.*refs\/agent-mail\/append-only-checked/.test(r.out) && /update-ref -d/.test(r.out), r.out);
  g(["update-ref", "-d", "refs/agent-mail/append-only-checked"], W);
  // NIT 1 of Claude 1 on #5113: the first run of the new repository keeps the old anchor of the clone, so a rewrite
  // made before the switch is still caught.
  g(["init", "-q", "--bare", "mail8.git"]); g(["push", "-q", "../mail8.git", "HEAD:refs/heads/correio"], W);
  const m8 = { CORREIO_REPO: join(T, "mail8.git"), CORREIO_GIT_DIR: join(T, "dir8-antigo.git") };
  run(["send", "--from", "Claude 2 X", "--to", "Claude 3 Z", "--subject", "s", "--text", "um"], { ...as("c2"), ...m8 });
  const ancora = g(["rev-parse", "refs/heads/correio"], join(T, "mail8.git"));
  g(["fetch", "-q", join(T, "mail8.git"), `+refs/heads/correio:refs/agent-mail/old-copy`], W);
  g(["update-ref", "refs/agent-mail/append-only-checked", ancora], W); g(["update-ref", "-d", "refs/agent-mail/old-copy"], W);
  const re = join(T, `rewrite-${Math.random().toString(16).slice(2)}`);
  g(["clone", "-q", "-b", "correio", join(T, "mail8.git"), re]); g(["reset", "-q", "--hard", "HEAD~1"], re);
  g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "rewritten"], re); g(["push", "-q", "-f", "origin", "HEAD:correio"], re);
  r = run(["watch", "--as", "Claude 3 Z", "--seconds", "1"], { CORREIO_REPO: join(T, "mail8.git"), CORREIO_GIT_DIR: join(T, "dir8-novo.git"), CLAUDE_CODE_REMOTE_SESSION_ID: "cse_014YNUxAAAAAAAAAAAAAAAAA" });
  is("on the first run of a new mailbox repository, a rewrite made before it is caught by the clone's old anchor (NIT 1 on #5113)", /ALERTA: o ramo correio não só acrescentou: o ramo foi reescrito/.test(r.out), r.out);
  g(["update-ref", "-d", "refs/agent-mail/append-only-checked"], W);
  // MEDIUM of Claude 4 3Kc on #5117: in CO (b)'s order (read first, then the warned delete, then the watch), the old anchor
  // is kept when the tool's repository is created by any command, so the watch still catches the rewrite.
  {
    g(["init", "-q", "--bare", "mail9.git"]); g(["push", "-q", "../mail9.git", "HEAD:refs/heads/correio"], W);
    run(["send", "--from", "Claude 2 X", "--to", "Claude 3 Z", "--subject", "s", "--text", "um"], { ...as("c2"), CORREIO_REPO: join(T, "mail9.git"), CORREIO_GIT_DIR: join(T, "dir9-antigo.git") });
    const a9 = g(["rev-parse", "refs/heads/correio"], join(T, "mail9.git"));
    g(["fetch", "-q", join(T, "mail9.git"), "+refs/heads/correio:refs/agent-mail/old-copy"], W);
    g(["update-ref", "refs/agent-mail/append-only-checked", a9], W); g(["update-ref", "-d", "refs/agent-mail/old-copy"], W);
    const novo = { CORREIO_REPO: join(T, "mail9.git"), CORREIO_GIT_DIR: join(T, "dir9-novo.git"), CLAUDE_CODE_REMOTE_SESSION_ID: "cse_014YNUxAAAAAAAAAAAAAAAAA" };
    run(["read", "--as", "Claude 3 Z"], novo);
    for (const ref of g(["for-each-ref", "--format=%(refname)", "refs/correio", "refs/agent-mail"], W).split("\n").filter(Boolean)) g(["update-ref", "-d", ref], W);
    const re9 = join(T, `rewrite9-${Math.random().toString(16).slice(2)}`);
    g(["clone", "-q", "-b", "correio", join(T, "mail9.git"), re9]); g(["reset", "-q", "--hard", `${a9}~1`], re9); // before the anchor itself: read and watch also write a signal (#5080)
    g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "rewritten"], re9); g(["push", "-q", "-f", "origin", "HEAD:correio"], re9);
    r = run(["watch", "--as", "Claude 3 Z", "--seconds", "1"], novo);
    is("read first, the clone's refs deleted as warned, then the watch: the rewrite made before the switch is still caught (MEDIUM on #5117)", /ALERTA: o ramo correio não só acrescentou: o ramo foi reescrito/.test(r.out), r.out);
  }
  // NIT 2: the shared-folder warning looks at the folder's permissions, not at its path.
  for (const [modo, aviso] of [[0o700, false], [0o777, true]]) {
    const d = join(T, `pasta-${modo.toString(8)}`); mkdirSync(d); chmodSync(d, modo);
    writeFileSync(join(d, "agent-mail.mjs"), readFileSync(TOOL));
    const x = spawnSync("node", [join(d, "agent-mail.mjs"), "list-switches"], { cwd: W, env: { ...base, AGENT_MAIL_TEST: "", CORREIO_SEM_VERSAO: "" }, encoding: "utf8" });
    is(`a copy in a folder with mode ${modo.toString(8)} ${aviso ? "is" : "is not"} warned about a folder anyone can write (NIT 2 on #5113)`, /pasta que todos podem escrever/.test(`${x.stdout}${x.stderr}`) === aviso, `${x.stdout}${x.stderr}`.slice(0, 300));
  }
}

console.log("two branches at the PR's head: the PR's own branch, from GitHub's head.ref (LOW of Claude 6 z5v4, #5080)");
{
  g(["init", "-q", "--bare", "mail11.git"]); g(["push", "-q", "../mail11.git", "HEAD:refs/heads/correio"], join(T, "w"));
  const m11 = { CORREIO_REPO: join(T, "mail11.git") };
  g(["checkout", "-q", "-B", "pr41", M], P); const H41 = commit("f41.txt", "41\n", "pr41");
  for (const ref of ["refs/pull/41/head", "refs/heads/feature-41", "refs/heads/helper-41"]) g(["push", "-q", "../prs.git", `HEAD:${ref}`], P);
  const ramoDo = (out) => /registrado: (\S+)/.exec(out)?.[1] ? (/^Ramo: (.*)$/m.exec(g(["show", `refs/heads/correio:fila/pedidos/${/registrado: (\S+)/.exec(out)[1]}.md`], join(T, "mail11.git")))?.[1] ?? "") : null;
  r = run(["request-enqueue", "--from", "Claude 2", "--pr", "41", "--sha", H41.slice(0, 10), "--text", "fila #41"], { ...m11, ...as("c2"), CORREIO_SEM_COMMITS: "", FAKE_GH: "headref", FAKE_REF: "feature-41" });
  is("with two branches at the head, the request records the PR's own branch, named by GitHub (LOW on #5080)", ramoDo(r.out) === "feature-41", r.out);
  run(["cancel-enqueue", "--as", "Claude 2", /registrado: (\S+)/.exec(r.out)?.[1] ?? "x", "--reason", "t"], { ...m11, ...as("c2") });
  r = run(["request-enqueue", "--from", "Claude 2", "--pr", "41", "--sha", H41.slice(0, 10), "--text", "fila #41"], { ...m11, ...as("c2"), CORREIO_SEM_COMMITS: "", FAKE_GH: "down" });
  is("with GitHub unreachable, no branch is guessed among the two", ramoDo(r.out) === "" || ramoDo(r.out) === null, r.out);
}

console.log("append-only check (OWNER-20261121-1904 step 3, part 3)");
{
  r = run(["check-append-only"]);
  is("a history that only adds files passes the append-only check", r.ok && /só acrescentou/.test(r.out), r.out);
  const alvo = g(["ls-tree", "-r", "--name-only", "refs/heads/correio", "caixas"], join(T, "mail.git")).split("\n")[0];
  raw(alvo, "rewritten by raw git\n");
  r = run(["check-append-only"]);
  is("a commit that changes a data file is reported, with the file", !r.ok && new RegExp(`ALTEROU ${alvo.replace(/[.]/g, "[.]")}`).test(r.out), r.out);
  r = run(["watch", "--as", "Claude 3 Z", "--seconds", "1"], { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_014YNUxAAAAAAAAAAAAAAAAA" });
  is("the watch raises the alarm once, and says to tell the coordinator and the owner", /ALERTA: o ramo correio não só acrescentou/.test(r.out) && /coordenador e o dono/.test(r.out), r.out);
  r = run(["watch", "--as", "Claude 3 Z", "--seconds", "1"], { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_014YNUxAAAAAAAAAAAAAAAAA" });
  is("the same change is not raised again on the next watch", !/ALERTA: o ramo correio/.test(r.out), r.out);
  // The audit's proof of concept 3 (step 7): a request deleted by a plain commit is reported too, by name.
  const pedidoAlvo = g(["ls-tree", "-r", "--name-only", "refs/heads/correio", "fila/pedidos"], join(T, "mail.git")).split("\n")[0];
  const cl = join(T, `rm-${Math.random().toString(16).slice(2)}`);
  g(["clone", "-q", "-b", "correio", join(T, "mail.git"), cl]); g(["rm", "-q", pedidoAlvo], cl);
  g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "raw delete"], cl); g(["push", "-q", "origin", "HEAD:correio"], cl);
  r = run(["check-append-only"]);
  is("a commit that deletes a request is reported, with the file (proof of concept 3)", !r.ok && new RegExp(`APAGOU ${pedidoAlvo.replace(/[.]/g, "[.]")}`).test(r.out), r.out);
}

console.log("availability: last signal, percent of quota, Codex preference (owner, OWNER-20261122-0121-MAIL-AVAILABILITY)");
{
  // A mailbox whose history starts 4 hours ago, so "no signal for more than 2 hours" can be observed.
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const M2 = join(T, "mail2.git"); g(["init", "-q", "--bare", "mail2.git"]);
  const W2 = join(T, "w2"); g(["init", "-q", "w2"]);
  const env2 = { CORREIO_REPO: M2 };
  const dated = (min) => ({ ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: ago(min), GIT_COMMITTER_DATE: ago(min) });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: W2, env: dated(240) });
  g(["push", "-q", M2, "HEAD:refs/heads/correio"], W2);
  // A commit written `min` minutes ago with the given trailers, as the tool writes them.
  const old = (path, text, min, trailers) => {
    g(["pull", "-q", M2, "correio"], W2);
    mkdirSync(join(W2, path, ".."), { recursive: true }); writeFileSync(join(W2, path), text); g(["add", "."], W2);
    execFileSync("git", ["commit", "-q", "-m", `old\n\n${trailers}`], { cwd: W2, env: dated(min) });
    g(["push", "-q", M2, "HEAD:refs/heads/correio"], W2);
  };
  const q2 = () => run(["list-quotas"], env2).out;
  old("estado/claude-3/20261121T000000Z-claude-3-x-aa01", "Cota: com\nPor: Claude 3 X\n", 180, "Mail-Session: session_014YNUxAAAAAAAAAAAAAAAAA (claude-3)\nMail-From: Claude 3 X");
  old("sinal/claude-7/20261121T000000Z-claude-7-x-aa02", "Claude 7 X\n", 30, "Mail-Session: session_01HfzozAAAAAAAAAAAAAAAAA (claude-7)\nMail-From: Claude 7 X");
  // Item 1: list-quotas shows each family's last signal; more than 2 hours without one counts as no quota.
  r = run(["send", "--from", "Claude 2 Z", "--to", "Claude 4 Z", "--subject", "s", "--text", "oi"], { ...env2, ...as("c2") });
  is("list-quotas shows the last signal of a family that just wrote", /claude-2: com cota; .*último sinal há 0 min/.test(q2()), q2());
  is("a family that last wrote 3 hours ago is shown without quota, for lack of signal", /claude-3: SEM COTA \(sem sinal há mais de 2 h\)/.test(q2()), q2());
  is("a family that wrote 30 minutes ago keeps its quota", /claude-7: com cota; .*último sinal há 3\d min/.test(q2()), q2());
  is("a family with no signal in a history that covers 2 hours is also without quota", /claude-5: SEM COTA \(sem sinal/.test(q2()), q2());
  is("in a mailbox younger than 2 hours, nobody is without quota for lack of signal", !/sem sinal/.test(run(["list-quotas"]).out), run(["list-quotas"]).out);
  // The preference for a family without signal falls at once: another family takes the review now.
  const H31 = pr(31, "f31.txt", "31\n");
  run(["request-review", "--from", "Claude 6", "--pr", "31", "--sha", H31.slice(0, 10), "--to", "Claude 3", "--text", "t"], { ...env2, ...as("c6") });
  r = run(["claim-review", "--as", "Claude 4 Z"], { ...env2, ...as("c4") });
  is("the preference for a family without signal falls at once: another family takes the review", r.ok && /pegou:/.test(r.out), r.out);
  // The watch writes a signal, at most one every 15 minutes per family.
  r = run(["watch", "--as", "Claude 3 Z", "--seconds", "1"], { ...env2, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_014YNUxAAAAAAAAAAAAAAAAA" });
  is("the watch writes a signal: the family is back with quota", /claude-3: com cota; .*último sinal há 0 min/.test(q2()), r.out + q2());
  run(["watch", "--as", "Claude 3 Y", "--seconds", "1"], { ...env2, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_014YNUxBBBBBBBBBBBBBBBBB" });
  const nSinais = () => g(["ls-tree", "-r", "--name-only", "refs/heads/correio", "sinal/claude-3"], M2).split("\n").filter(Boolean).length;
  is("a second watch of the same family within 15 minutes writes no new signal", nSinais() === 1, String(nSinais()));
  // The Codex, outside the cloud, signals by reading.
  r = run(["read", "--as", "Codex"], env2);
  is("the Codex's read writes its signal, under its declared name", /codex: com cota; .*último sinal há 0 min/.test(q2()), r.out + q2());
  // Item 2: the percent of quota and the renewal date.
  r = run(["set-quota", "--as", "Claude 2 Z", "--remaining", "35", "--renews", "2099-11-29T10:00-03:00"], { ...env2, ...as("c2") });
  is("set-quota takes the percent left and the renewal date", r.ok && /claude-2: com cota; resta 35% até 2099-11-29T13:00:00\.000Z/.test(q2()), r.out + q2());
  r = run(["set-quota", "--as", "Claude 2 Z", "--remaining", "35"], { ...env2, ...as("c2") });
  is("a percent without the renewal date is refused", !r.ok && /--renews/.test(r.out), r.out);
  r = run(["set-quota", "--as", "Claude 2 Z", "--remaining", "8", "--renews", "2099-11-29T10:00-03:00"], { ...env2, ...as("c2") });
  is("at 10% or less the family shows a low quota", r.ok && /claude-2: COTA BAIXA; resta 8%/.test(q2()), r.out + q2());
  const aviso = run(["read", "--as", "Claude 4 Z"], { ...env2, ...as("c4") }).out;
  is("the other families are told when a quota gets low", /Cota baixa: Claude 2 com 8%/.test(aviso), aviso);
  run(["set-quota", "--as", "Claude 2 Z", "--remaining", "6", "--renews", "2099-11-29T10:00-03:00"], { ...env2, ...as("c2") });
  is("a lower percent while already low is not announced again", (run(["read", "--as", "Claude 5 Z"], { ...env2, ...as("c5") }).out.match(/Cota baixa: Claude 2/g) ?? []).length === 1, run(["read", "--as", "Claude 5 Z"], { ...env2, ...as("c5") }).out);
  // A long review (more than 400 lines outside tests) is not handed to a family with a low quota; a short one is.
  const H32 = pr(32, "big.txt", `${Array.from({ length: 450 }, (_, i) => `linha ${i}`).join("\n")}\n`);
  run(["request-review", "--from", "Claude 6", "--pr", "32", "--sha", H32.slice(0, 10), "--text", "longa"], { ...env2, ...as("c6") });
  r = run(["claim-review", "--as", "Claude 2 Z"], { ...env2, ...as("c2") });
  is("a long review is not handed to a family with a low quota", /nada para pegar/.test(r.out), r.out);
  const H33 = pr(33, "big.test.ts", `${Array.from({ length: 450 }, (_, i) => `// ${i}`).join("\n")}\n`);
  run(["request-review", "--from", "Claude 6", "--pr", "33", "--sha", H33.slice(0, 10), "--text", "só testes"], { ...env2, ...as("c6") });
  r = run(["claim-review", "--as", "Claude 2 Z"], { ...env2, ...as("c2") });
  is("a review whose lines are tests only is short, and goes to the low family", r.ok && /pegou:/.test(r.out) && /#33|PR: 33/.test(r.out), r.out);
  r = run(["claim-review", "--as", "Claude 4 Z"], { ...env2, ...as("c4") });
  is("the long review goes to a family with quota", r.ok && /PR: 32/.test(r.out), r.out);
  // Item 3: a preference for the Codex holds 30 minutes, then any other family with quota takes the review.
  run(["read", "--as", "Codex"], env2);
  const H34 = pr(34, "f34.txt", "34\n");
  run(["request-review", "--from", "Claude 6", "--pr", "34", "--sha", H34.slice(0, 10), "--to", "Codex", "--text", "t"], { ...env2, ...as("c6") });
  r = run(["claim-review", "--as", "Claude 4 Z"], { ...env2, ...as("c4") });
  is("a fresh preference for the Codex, with signal, holds", /nada para pegar/.test(r.out), r.out);
  const stamp = new Date(Date.now() - 31 * 60000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const H35 = pr(35, "f35.txt", "35\n");
  old(`revisao/pedidos/${stamp}-claude-6-ab35.md`, `Tipo: revisão\nPR: 35\nHead: ${H35.slice(0, 10)}\nAutor: Claude 6\nPreferência: Codex\nCommits de: codex\nLinhas fora dos testes: 1\nId: ${stamp}-claude-6-ab35\n\nt\n`, 31, "Mail-From: Claude 6");
  r = run(["claim-review", "--as", "Claude 4 Z"], { ...env2, ...as("c4") });
  is("after 30 minutes the preference for the Codex no longer holds: another family takes it", r.ok && /PR: 35/.test(r.out), r.out);
  run(["set-quota", "--as", "Claude 2 Z", "--remaining", "0", "--renews", "2099-11-29T10:00-03:00"], { ...env2, ...as("c2") });
  is("0% is without quota until the renewal", /claude-2: SEM COTA até 2099-11-29T13:00:00\.000Z/.test(q2()), q2());
}

console.log("a busy mailbox: a write that loses the race to another agent tries again quickly (22/11/2026, 166 commits in 10 minutes)");
{
  // A mailbox whose server moves the branch under the first N pushes (a pre-receive hook commits on top of the tip), so
  // each of those pushes is rejected exactly as when another agent wrote first. race-left holds N.
  const M3 = join(T, "mail3.git"); g(["init", "-q", "--bare", "mail3.git"]);
  g(["push", "-q", M3, "refs/heads/correio:refs/heads/correio"], join(T, "mail.git"));
  writeFileSync(join(M3, "hooks", "pre-receive"), `#!/bin/sh
[ -f race-left ] || exit 0
n=$(cat race-left); [ "$n" -gt 0 ] || exit 0
echo $((n-1)) > race-left
unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
tip=$(git rev-parse refs/heads/correio)
c=$(GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=x@x GIT_COMMITTER_NAME=x GIT_COMMITTER_EMAIL=x@x git commit-tree "$tip^{tree}" -p "$tip" -m race)
git update-ref refs/heads/correio "$c" "$tip"
exit 0
`); chmodSync(join(M3, "hooks", "pre-receive"), 0o755);
  const left = () => readFileSync(join(M3, "race-left"), "utf8").trim();
  const caixa3 = () => g(["ls-tree", "-r", "--name-only", "refs/heads/correio", "caixas/claude-3-z"], M3).split("\n").filter(Boolean).length;
  const antes3 = caixa3();
  writeFileSync(join(M3, "race-left"), "8\n");
  const t0 = Date.now();
  r = run(["send", "--from", "Claude 2 Z", "--to", "Claude 3 Z", "--subject", "race", "--text", "x"], { ...as("c2"), CORREIO_REPO: M3 });
  is("a write that loses the race 8 times in a row still goes through", r.ok && /enviada/.test(r.out) && left() === "0", `${r.out} left=${left()}`);
  is("and it retries quickly, not with waits of seconds (under 15 s for 8 lost races)", Date.now() - t0 < 15000, `${Date.now() - t0} ms`);
  is("the message is in the mailbox once", caixa3() === antes3 + 1, `${antes3} -> ${caixa3()}`);
  writeFileSync(join(M3, "race-left"), "1000\n");
  r = run(["send", "--from", "Claude 2 Z", "--to", "Claude 3 Z", "--subject", "race 2", "--text", "x"], { ...as("c2"), CORREIO_REPO: M3 });
  is("a race that never ends stops after 30 tries and says why", !r.ok && /30 por o correio ter andado no meio/.test(r.out), r.out);
  writeFileSync(join(M3, "race-left"), "0\n");
}

console.log("a passing git failure while building a write is tried again, and git's upkeep runs in the foreground (CI, 22/11/2026)");
{
  // A git that fails write-tree once, as when a detached gc removed an empty objects/ folder in the middle of the write.
  const BINF = join(T, "bin-flaky"); mkdirSync(BINF);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(BINF, "git"), `#!/bin/sh
for a in "$@"; do if [ "$a" = "write-tree" ] && [ -f "$FAKE_GIT_FAIL" ]; then rm -f "$FAKE_GIT_FAIL"; echo "error: unable to create temporary file: No such file or directory" >&2; echo "fatal: git-write-tree: error building trees" >&2; exit 128; fi; done
exec ${realGit} "$@"
`); chmodSync(join(BINF, "git"), 0o755);
  const marcaF = join(T, "flaky-once"); writeFileSync(marcaF, "1\n");
  r = run(["send", "--from", "Claude 2 Z", "--to", "Claude 3 Z", "--subject", "flaky", "--text", "x"], { ...as("c2"), PATH: `${BINF}:${base.PATH}`, FAKE_GIT_FAIL: marcaF });
  is("a write-tree that fails once with 'unable to create temporary file' is tried again and the message goes through", r.ok && /enviada/.test(r.out) && !existsSync(marcaF), r.out);
  // The same for the blob written before the loop (LEVE of Claude 4 3Kc on #5147).
  writeFileSync(join(BINF, "git"), `#!/bin/sh
for a in "$@"; do if [ "$a" = "hash-object" ] && [ -f "$FAKE_GIT_FAIL" ]; then rm -f "$FAKE_GIT_FAIL"; echo "error: unable to create temporary file: No such file or directory" >&2; echo "fatal: unable to write loose object file" >&2; exit 128; fi; done
exec ${realGit} "$@"
`);
  writeFileSync(marcaF, "1\n");
  r = run(["send", "--from", "Claude 2 Z", "--to", "Claude 3 Z", "--subject", "flaky blob", "--text", "y"], { ...as("c2"), PATH: `${BINF}:${base.PATH}`, FAKE_GIT_FAIL: marcaF });
  is("a hash-object that fails once with 'unable to create temporary file' is tried again too (LEVE of Claude 4 3Kc)", r.ok && /enviada/.test(r.out) && !existsSync(marcaF), r.out);
  const cfg = (k) => { try { return g(["--git-dir", base.CORREIO_GIT_DIR, "config", k]); } catch { return ""; } };
  is("the mailbox's git runs gc and maintenance in the foreground (no detached upkeep under a write)", cfg("gc.autoDetach") === "false" && cfg("maintenance.autoDetach") === "false", `${cfg("gc.autoDetach")} ${cfg("maintenance.autoDetach")}`);
}

console.log("outside a git clone: the version check says to run from inside one (22/11/2026)");
{
  const fora = mkdtempSync(join(tmpdir(), "fora-de-clone-"));
  const x = spawnSync("node", [TOOL, "list-switches"], { cwd: fora, env: { ...base, CORREIO_SEM_VERSAO: "", GIT_CEILING_DIRECTORIES: tmpdir() }, encoding: "utf8" });
  is("run outside a git clone, the tool says the folder is not a git clone and to run from inside one", /não é um clone git/.test(`${x.stdout}${x.stderr}`), `${x.stdout}${x.stderr}`.slice(0, 300));
}

console.log("version: the copy's SHA-256 against the reviewed one on main (owner, OWNER-20261121-1904, step 1)");
const meu = createHash("sha256").update(readFileSync(TOOL)).digest("hex");
const comHash = (h) => { g(["checkout", "-q", "-B", "mainh", M], P); mkdirSync(join(P, "tooling", "agent-mail"), { recursive: true });
  writeFileSync(join(P, "tooling", "agent-mail", "agent-mail.sha256"), `${h}  agent-mail.mjs\n`); g(["add", "."], P);
  g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "hash"], P); g(["push", "-q", "-f", "../prs.git", "HEAD:refs/heads/main"], P); };
comHash(meu);
r = run(["list-switches"], { CORREIO_SEM_VERSAO: "" });
is("the reviewed hash on main: no version warning", r.ok && !/ATENÇÃO/.test(r.out), r.out);
comHash("0".repeat(64));
r = run(["list-switches"], { CORREIO_SEM_VERSAO: "" });
is("a different hash on main: the copy is reported as not the reviewed one", /não é a versão revisada do main do Marktmorgen/.test(r.out), r.out);
r = run(["send", "--from", "Claude 2 Z", "--to", "Claude 3 Z", "--subject", "s", "--text", "x"], { ...as("c2"), CORREIO_SEM_VERSAO: "" });
is("an old copy cannot write: the send is refused, with the install command to run", !r.ok && /escrita recusada/.test(r.out) && /CO \(b\)/.test(r.out), r.out);
// Step 4, part 2: a test variable counts only with the marker AGENT_MAIL_TEST=1 and local repositories.
r = run(["send", "--from", "Claude 2 Z", "--to", "Claude 3 Z", "--subject", "s", "--text", "x"], { ...as("c2"), CORREIO_SEM_VERSAO: "1", AGENT_MAIL_TEST: "" });
is("without the marker, CORREIO_SEM_VERSAO=1 is ignored: the old copy is still refused, and the tool says the variable was ignored", !r.ok && /escrita recusada/.test(r.out) && /CORREIO_SEM_VERSAO.*ignorada/.test(r.out), r.out);
r = run(["list-queue"], { CORREIO_SEM_VERSAO: "" });
is("an old copy can still read, with the warning", r.ok && /não é a versão revisada/.test(r.out), r.out);
r = run(["list-switches"], { CORREIO_SEM_VERSAO: "", CORREIO_PR_REPO: join(T, "nao-existe.git") });
is("main unreachable: the version is reported as NOT CHECKED", /NÃO FOI CONFERIDA/.test(r.out), r.out);
// Old copies are refused (step 3): a write needs the reviewed copy, checked now; reading still works, with the warning.
r = run(["send", "--from", "Claude 2 Z", "--to", "Claude 3 Z", "--subject", "s", "--text", "x"], { ...as("c2"), CORREIO_SEM_VERSAO: "", CORREIO_PR_REPO: join(T, "nao-existe.git") });
is("main unreachable: a write is refused, the version NOT CHECKED", !r.ok && /escrita recusada/.test(r.out), r.out);
// file:// behaves like a real remote (a plain path would ignore --depth), as the reviewer reproduced on GitHub.
// The version check must never fetch with --depth: a shallow fetch makes the user's repository shallow (review of
// Claude 1 A on #5044, reproduced on GitHub). GIT_TRACE records every git command the tool runs.
comHash(meu);
r = run(["send", "--from", "Claude 2 Z", "--to", "Claude 3 Z", "--subject", "s", "--text", "x"], { ...as("c2"), CORREIO_SEM_VERSAO: "" });
is("the reviewed copy writes", r.ok && /enviada/.test(r.out), r.out);
const trace = join(T, "git-trace.txt");
spawnSync("node", [TOOL, "list-switches"], { cwd: join(T, "w"), env: { ...base, CORREIO_SEM_VERSAO: "", GIT_TRACE: trace }, encoding: "utf8" });
const linhas = readFileSync(trace, "utf8").split("\n").filter((l) => /git(\.c:\d+)?\s.*trace: (built-in|exec): git fetch/.test(l) || /trace: built-in: git fetch/.test(l));
is("the version check runs a fetch (so the next check means something)", linhas.length > 0, readFileSync(trace, "utf8").slice(0, 600));
is("no git fetch of the tool uses --depth (review of Claude 1 A)", !linhas.some((l) => /--depth/.test(l)), linhas.filter((l) => /--depth/.test(l)).join("\n").slice(0, 600));

console.log("secrets never printed: a credential in the mailbox address stays out of every message (CodeQL alert 257 on #5080)");
{
  const TOKEN = "ghp_FAKEtoken0123456789abcdefABCDEF0000";
  comHash(meu); // the copy is the reviewed one for real, so a write and the watch get as far as git
  const longe = { CORREIO_REPO: `https://x-access-token:${TOKEN}@127.0.0.1:9/mail.git`, CORREIO_GIT_DIR: join(T, "dir-secret.git"), CORREIO_SEM_VERSAO: "" };
  r = run(["read", "--as", "Claude 2 Z"], { ...as("c2"), ...longe });
  is("a failed read does not print the token in the mailbox address (CodeQL 257)", !r.ok && !r.out.includes(TOKEN) && !/x-access-token:[^*]/.test(r.out), r.out);
  r = run(["send", "--from", "Claude 2 Z", "--to", "Claude 3 Z", "--subject", "s", "--text", "x"], { ...as("c2"), ...longe });
  is("a failed send gets as far as git and does not print the token either (CodeQL 257)", !r.ok && !/escrita recusada/.test(r.out) && !r.out.includes(TOKEN), r.out);
  r = run(["watch", "--as", "Claude 2 Z", "--seconds", "1"], { ...as("c2"), ...longe });
  is("the watch, failing to reach the mailbox, says so and does not print the token (CodeQL 257)", /vigia: /.test(r.out) && !r.out.includes(TOKEN), r.out);
  const mod = await import(TOOL);
  const limpo = mod.semSegredo?.(`fetch https://user:${TOKEN}@github.com/x.git; Authorization: Bearer abc.def; http.extraheader=AUTHORIZATION: basic Zm9v; ${TOKEN}; github_pat_11AAAAAAAAAAAAAAAAAAAA_bbbb`) ?? "";
  is("semSegredo removes the URL credential, a bearer header, an extraheader and bare GitHub tokens (CodeQL 257)",
    limpo && !limpo.includes(TOKEN) && !/abc\.def|Zm9v|github_pat_11/.test(limpo) && /https:\/\/\*\*\*@github\.com\/x\.git/.test(limpo), limpo);
  const eg = mod.erroDoGit?.(["fetch", "-q", `https://x-access-token:${TOKEN}@github.com/o/correio.git`, "+refs/heads/correio:refs/x"],
    { status: 128, stderr: "fatal: unable to access 'https://github.com/o/correio.git/': 403\n", message: `Command failed: git fetch -q https://x-access-token:${TOKEN}@github.com/o/correio.git` });
  is("a failed git becomes an error without the command line: subcommand, exit code and git's own last line only (CodeQL 257 at line 2013)",
    eg && eg.message === "git fetch falhou (código 128): fatal: unable to access 'https://github.com/o/correio.git/': 403" && eg.status === 128 && !eg.message.includes(TOKEN) && !/Command failed|refs\/heads/.test(eg.message), eg?.message);
  const egs = mod.erroDoGit?.(["push"], { status: 1, stderr: `remote: denied to https://u:${TOKEN}@github.com/o/c.git\n` });
  is("the stderr kept on a git error has its credential masked too (NIT of Claude 5 iacVn3r on #5080)",
    Boolean(egs) && !egs.stderr.includes(TOKEN) && !egs.message.includes(TOKEN) && /https:\/\/\*\*\*@github\.com/.test(egs.stderr), egs?.stderr);
  is("a subcommand outside the tool's list is named 'comando', never taken from the arguments (CodeQL 257)", mod.erroDoGit?.([`https://${TOKEN}@x`], { status: 1 })?.message === "git comando falhou (código 1)");
  // CodeQL 257 at line 2028: the session comes from CLAUDE_CODE_REMOTE_SESSION_ID, a sensitive name for CodeQL; no error
  // message carries it, and the family named comes from the fixed list.
  r = run(["send", "--from", "Claude 3 X", "--to", "Claude 4 X", "--subject", "s", "--text", "x"], as("c2"));
  is("the identity error names the family, never the session id read from the environment (CodeQL 257)",
    !r.ok && /esta sessão é da família claude-2/.test(r.out) && !r.out.includes("01FR6Z1Q87"), r.out);
  r = run(["set-switch", "--as", "Claude 2 X", "--name", "ready-check", "--on", "--reason", "t", "--request", "x"], as("c2"));
  is("the privileged-action refusal does not print the session id either (CodeQL 257)",
    !r.ok && /esta sessão não é nenhuma das duas/.test(r.out) && !r.out.includes("01FR6Z1Q87"), r.out);
  is("familiaDaLista returns a family from the fixed list, and 'desconhecida' for anything else (CodeQL 257)",
    mod.familiaDaLista?.("claude-2") === "claude-2" && mod.familiaDaLista?.("01FR6Z1Q87JZvT") === "desconhecida");
  is("semSegredo keeps an ordinary message as it is (CodeQL 257)", mod.semSegredo?.("já existe no correio: prs/3/0; nada é reescrito") === "já existe no correio: prs/3/0; nada é reescrito");
}

console.log("a session's own box: an ack under the family name does not hide it from that session (22/11/2026, 88a1)");
{
  const irma = { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_018ZjhHhsz3gLez5RRaBkkvu" }; // another Claude 6 session, reading as "Claude 6"
  r = run(["send", "--from", "Claude 2 X", "--to", "Claude 6 UoHAG", "--subject", "only for UoHAG", "--text", "pessoal"], as("c2"));
  const id = /enviada: (\S+)/.exec(r.out)?.[1];
  r = run(["ack", "--as", "Claude 6", id], irma);
  is("a sibling reading as the family can acknowledge it (the box of a closed session is not lost)", r.ok && /confirmadas: 1/.test(r.out), r.out);
  r = run(["read", "--as", "Claude 6 UoHAG"], as("c6"));
  is("the session it was sent to still sees it, marked as already acknowledged by the family", r.ok && r.out.includes(id) && /já confirmada com o nome da família/.test(r.out), r.out);
  r = run(["ack", "--as", "Claude 6 UoHAG", id], as("c6"));
  is("once the session acknowledges it, it no longer shows", r.ok && !run(["read", "--as", "Claude 6 UoHAG"], as("c6")).out.includes(id), r.out);
  is("the family reader does not see it again after its own ack (unchanged)", !run(["read", "--as", "Claude 6"], irma).out.includes(id));
  r = run(["send", "--from", "Claude 2 X", "--to", "Claude 6", "--subject", "for the family", "--text", "familia"], as("c2"));
  const idF = /enviada: (\S+)/.exec(r.out)?.[1];
  run(["ack", "--as", "Claude 6", idF], irma);
  r = run(["send", "--from", "Claude 2 X", "--to", "Claude 6 UoHAG, Claude 6 z5v4", "--subject", "to two sessions", "--text", "duas"], as("c2"));
  const idDuas = /enviada: (\S+)/.exec(r.out)?.[1];
  run(["ack", "--as", "Claude 6 UoHAG", idDuas], as("c6"));
  is("a message to two sessions of a family, acknowledged by one, still shows to the other (the 7f0a of 22/11/2026)",
    Boolean(idDuas) && run(["read", "--as", "Claude 6 z5v4"], { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_018ZjhHhz5v4kPZ3osC8Cr6g" }).out.includes(idDuas), r.out);
  is("a message to the family, acknowledged by the family, does not show to a session (unchanged)", !run(["read", "--as", "Claude 6 UoHAG"], as("c6")).out.includes(idF));
  // 23/11/2026 (coordinator 33d5): a repeated --to kept only the last name, so a note meant for five sessions reached one.
  r = run(["send", "--from", "Claude 2 X", "--to", "Claude 6 UoHAG", "--to", "Claude 6 z5v4", "--subject", "repeated", "--text", "duas"], as("c2"));
  is("a repeated --to is refused with a clear error, and nothing is sent", !r.ok && /--to.*mais de uma vez/.test(r.out) && !/enviada:/.test(r.out), r.out);
  r = run(["send", "--from", "Claude 2 X", "--to", "Claude 6 UoHAG", "--para", "Claude 6 z5v4", "--subject", "alias", "--text", "duas"], as("c2"));
  is("and so is the same option given under its English and its old name", !r.ok && /mais de uma vez/.test(r.out) && !/enviada:/.test(r.out), r.out);
  // Claude 2 lpgvy's LOW on #5279 (#5010 row 161): an option the tool does not know was kept and read by no command,
  // so "send --to A --cc B" went to A only and said nothing.
  r = run(["send", "--from", "Claude 2 X", "--to", "Claude 6 UoHAG", "--cc", "Claude 6 z5v4", "--subject", "cc", "--text", "duas"], as("c2"));
  is("an unknown option such as --cc is refused with the right one named, and nothing is sent", !r.ok && /--cc não existe/.test(r.out) && /--to "A, B"/.test(r.out) && !/enviada:/.test(r.out), r.out);
  r = run(["request-review", "--from", "Claude 4 X", "--pr", "1", "--sha", "0".repeat(40), "--reviewer", "Claude 5", "--text", "t"], as("c4"));
  is("and so in any command (request-review --reviewer)", !r.ok && /--reviewer não existe/.test(r.out) && !/pedido registrado/.test(r.out), r.out);
  r = run(["send", "--from", "Claude 2 X", "--to", "Claude 6 UoHAG, Claude 6 z5v4", "--subject", "listed", "--text", "duas"], as("c2"));
  is("control: one --to with the names separated by commas still goes to each, and says to whom", r.ok && /enviada: \S+ \(para: Claude 6 UoHAG, Claude 6 z5v4\)/.test(r.out), r.out);
  // 23/11/2026: Claude 6 UoHAG's own "push minute" note to its family woke its own watch and showed as unread to it.
  r = run(["send", "--from", "Claude 6 UoHAG", "--to", "Claude 6", "--subject", "own note", "--text", "minuto"], as("c6"));
  const idProprio = /enviada: (\S+)/.exec(r.out)?.[1];
  is("a session's own message to its family box does not show to that session as unread", Boolean(idProprio) && !run(["read", "--as", "Claude 6 UoHAG"], as("c6")).out.includes(idProprio), r.out);
  is("but it still shows to a sister session", Boolean(idProprio) && run(["read", "--as", "Claude 6 z5v4"], { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_018ZjhHhz5v4kPZ3osC8Cr6g" }).out.includes(idProprio));
}

console.log("a family with a verdict on the head written only on the PR does not take it (coordinator ce2d, #5118)");
{
  const g5 = (args) => g(args, join(T, "p"));
  g5(["checkout", "-q", "-B", "ce2d", M]); writeFileSync(join(T, "p", "ce2d.txt"), "x\n"); g5(["add", "."]); g5(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "ce2d\n\nClaude-Session: https://claude.ai/code/session_01S9eVA3KcXUkc6qPJmpNg4a"]);
  g5(["push", "-q", "-f", "../prs.git", "HEAD:refs/heads/ce2d", "HEAD:refs/pull/60/head"]);
  const H60 = g5(["rev-parse", "HEAD"]);
  g(["init", "-q", "--bare", "mail60.git"]); g(["push", "-q", "../mail60.git", "HEAD:refs/heads/correio"], join(T, "w"));
  const m60 = { CORREIO_REPO: join(T, "mail60.git"), CORREIO_GIT_DIR: join(T, "dir60.git") };
  const veredito = (familiaTxt, v) => JSON.stringify([`${familiaTxt} review #60 @${H60.slice(0, 10)}: ${v}\n\nbody`, "COLLABORATOR"]);
  const fora = JSON.stringify([`re-review needed #60 @${H60.slice(0, 10)} — revisores: Claude 7 X e Claude 3 X`, "COLLABORATOR"]);
  const comentarios = [veredito("Claude 2 X", "READY"), fora, JSON.stringify([`Claude 3 X review #60 @0000000000: READY`, "COLLABORATOR"]), JSON.stringify([`Claude 7 X review #60 @${H60.slice(0, 10)}: CHANGES`, "NONE"])].join("\n") + "\n";
  // The request is made before the verdicts are written on the PR (c944 now leaves out a family that has one already),
  // so the take is where ce2d still has to catch them.
  r = run(["request-review", "--from", "Claude 4 X", "--pr", "60", "--sha", H60, "--text", "t"], { ...m60, ...as("c4"), FAKE_COMMENTS: "" });
  is("ce2d: the review request is written", r.ok, r.out);
  r = run(["claim-review", "--as", "Claude 2 X"], { ...m60, ...as("c2"), FAKE_COMMENTS: comentarios });
  is("ce2d: a family that gave READY on this head only in a PR comment does not take the review; it is returned with the reason", !/pegou:/.test(r.out) && /nenhum pedido/.test(r.out), r.out);
  const id60 = /^(\S+)\s+#60\b/m.exec(run(["list-reviews"], m60).out)?.[1] ?? "";
  const devolucao = (() => { try { return g(["show", `refs/heads/correio:revisao/tomadas/${id60}/0`], join(T, "mail60.git")); } catch { return ""; } })();
  is("ce2d: and the request records why, so the watch stops offering it to that family", /DEVOLVIDO/.test(devolucao) && /veredito neste head no PR/.test(devolucao), `${id60}\n${devolucao}`);
  r = run(["claim-review", "--as", "Claude 7 X"], { ...m60, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01Hfzoz3uVKpUo5Wosq4VYjL", FAKE_COMMENTS: comentarios });
  is("ce2d: a verdict from outside the repository (author_association NONE) does not exclude anyone", /pegou:/.test(r.out), r.out);
  r = run(["claim-review", "--as", "Claude 3 X"], { ...m60, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_014YNUxAAAAAAAAAAAAAAAAA", FAKE_COMMENTS: comentarios });
  is("ce2d: a verdict on another head, or a family only named in a line that is not a review, does not exclude", /nenhum pedido|já/.test(r.out) || /pegou:/.test(r.out), r.out);
  r = run(["request-enqueue", "--from", "Claude 4 X", "--pr", "60", "--sha", H60, "--text", "t"], { ...m60, ...as("c4"), FAKE_COMMENTS: comentarios });
  const fila60 = r;
  r = run(["claim-enqueue", "--as", "Claude 2 X"], { ...m60, ...as("c2"), FAKE_COMMENTS: comentarios });
  is("ce2d: the queue is not delivered to a family with a verdict on this head only in the PR (FQ (1))", fila60.ok && !/pegou:/.test(r.out) && /veredito da sua família neste head no PR/.test(r.out), fila60.out + r.out);
  r = run(["claim-enqueue", "--as", "Claude 3 X"], { ...m60, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_014YNUxAAAAAAAAAAAAAAAAA", FAKE_COMMENTS_DOWN: "1" });
  is("ce2d: with the PR's comments unreadable, the queue waits (NOT CHECKED)", !/pegou:/.test(r.out) && /NÃO CONFERIDO/.test(r.out), r.out);
  r = run(["claim-review", "--as", "Claude 2 X"], { ...m60, ...as("c2"), FAKE_COMMENTS_DOWN: "1" });
  is("ce2d: when the PR's comments cannot be read, nothing is taken (NOT CHECKED)", !/pegou:/.test(r.out), r.out);
}

console.log("a family with a verdict on the head is left out of a new review request, by mail or on the PR (coordinator 999b, Claude 1 yatz's c944)");
{
  const g6 = (args) => g(args, join(T, "p"));
  g6(["checkout", "-q", "-B", "c944", M]); writeFileSync(join(T, "p", "c944.txt"), "x\n"); g6(["add", "."]); g6(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c944\n\nClaude-Session: https://claude.ai/code/session_01S9eVA3KcXUkc6qPJmpNg4a"]);
  g6(["push", "-q", "-f", "../prs.git", "HEAD:refs/heads/c944", "HEAD:refs/pull/944/head"]);
  const H62 = g6(["rev-parse", "HEAD"]);
  g(["init", "-q", "--bare", "mail944.git"]); g(["push", "-q", "../mail944.git", "HEAD:refs/heads/correio"], join(T, "w"));
  const m62 = { CORREIO_REPO: join(T, "mail944.git"), CORREIO_GIT_DIR: join(T, "dir944.git") };
  const noPr = JSON.stringify([`Claude 2 X review #944 @${H62.slice(0, 10)}: READY\n\nbody`, "COLLABORATOR"]) + "\n";
  const pedido = (id) => { try { return g(["show", `refs/heads/correio:revisao/pedidos/${id}.md`], join(T, "mail944.git")); } catch { return ""; } };
  r = run(["request-review", "--from", "Claude 4 X", "--pr", "944", "--sha", H62, "--text", "t"], { ...m62, ...as("c4"), FAKE_COMMENTS: noPr });
  const idA = /pedido registrado: (\S+)/.exec(r.out)?.[1] ?? "";
  is("c944: a family with READY on this head in a PR comment goes into the request's Exclui", r.ok && /^Exclui: .*claude-2/m.test(pedido(idA)), r.out + pedido(idA));
  is("c944: and is not listed among those who may review", /podem revisar: (?![^\n]*claude-2)/.test(r.out), r.out);
  r = run(["watch", "--as", "Claude 2 X", "--also", "review", "--seconds", "1"], { ...m62, ...as("c2"), FAKE_COMMENTS: noPr });
  is("c944: the watch does not wake that family for this request", !/revisao #944/.test(r.out), r.out);
  r = run(["claim-review", "--as", "Claude 5 X"], { ...m62, ...as("c5"), FAKE_COMMENTS: noPr });
  is("c944: another family takes it", /pegou:/.test(r.out), r.out);
  r = run(["complete-review", "--as", "Claude 5 X", idA, "--result", "READY", "--text", "ok"], { ...m62, ...as("c5"), FAKE_COMMENTS: noPr });
  r = run(["request-review", "--from", "Claude 4 X", "--pr", "944", "--sha", H62, "--text", "again"], { ...m62, ...as("c4"), FAKE_COMMENTS: noPr });
  const idB = /pedido registrado: (\S+)/.exec(r.out)?.[1] ?? "";
  is("c944: a family whose READY on this head is in the mail goes into Exclui of a new request on the same head", r.ok && /^Exclui: .*claude-5/m.test(pedido(idB)) && /podem revisar: (?![^\n]*claude-5)/.test(r.out), r.out + pedido(idB));
  r = run(["claim-review", "--as", "Claude 5 Y"], { ...m62, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_012ST5iYYYYYYYYYYYYYYYYY", FAKE_COMMENTS: noPr });
  is("c944: and another session of that family does not take it", !/pegou:/.test(r.out), r.out);
  r = run(["claim-review", "--as", "Claude 6 X"], { ...m62, ...as("c6"), FAKE_COMMENTS: noPr });
  const outroDaFamilia = noPr + JSON.stringify([`Claude 6 Y review #944 @${H62.slice(0, 10)}: READY\n\nbody`, "COLLABORATOR"]) + "\n";
  r = run(["complete-review", "--as", "Claude 6 X", idB, "--result", "READY", "--text", "ok"], { ...m62, ...as("c6"), FAKE_COMMENTS: outroDaFamilia });
  is("c944: a verdict written on the PR by the same family during the take is warned about at completion, without refusing", r.ok && /concluído/.test(r.out) && /aviso: .*claude-6.*já tem veredito/.test(r.out), r.out);
  // LOW of Claude 2 main on #5261: a CHANGES on this head is not a reason to leave that family out. The author may answer
  // in writing with no code change and ask the same family to look again on the same head.
  // Claude 1 RevB's nit on #5261: a CHANGES on the second line (a family header, then "Verdict: CHANGES") is read as
  // a CHANGES too, so that family is not left out either.
  const comMudancas = noPr + JSON.stringify([`Claude 7 X review #944 @${H62.slice(0, 10)}: CHANGES (1 LOW)\n\nbody`, "COLLABORATOR"]) + "\n"
    + JSON.stringify([`Claude 3 X — #944 @${H62.slice(0, 10)}\nVerdict: CHANGES (1 MEDIUM)\n\nbody`, "COLLABORATOR"]) + "\n";
  r = run(["request-review", "--from", "Claude 4 X", "--pr", "944", "--sha", H62, "--text", "changes"], { ...m62, ...as("c4"), FAKE_COMMENTS: comMudancas });
  const idC = /pedido registrado: (\S+)/.exec(r.out)?.[1] ?? "";
  is("c944: a family whose verdict on this head is CHANGES, on the PR, is not left out of a new review request", r.ok && !/^Exclui: .*claude-7/m.test(pedido(idC)) && /podem revisar: [^\n]*claude-7/.test(r.out), r.out + pedido(idC));
  is("c944: nor one whose CHANGES is on the second line of its comment", r.ok && !/^Exclui: .*claude-3/m.test(pedido(idC)) && /podem revisar: [^\n]*claude-3/.test(r.out), r.out + pedido(idC));
  run(["claim-review", "--as", "Claude 7 X"], { ...m62, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01Hfzoz3uVKpUo5Wosq4VYjL", FAKE_COMMENTS: "" });
  run(["complete-review", "--as", "Claude 7 X", idC, "--result", "CHANGES", "--text", "1 LOW"], { ...m62, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01Hfzoz3uVKpUo5Wosq4VYjL", FAKE_COMMENTS: "" });
  r = run(["request-review", "--from", "Claude 4 X", "--pr", "944", "--sha", H62, "--text", "answered in writing"], { ...m62, ...as("c4"), FAKE_COMMENTS: "" });
  const idD = /pedido registrado: (\S+)/.exec(r.out)?.[1] ?? "";
  is("c944: nor a family whose CHANGES on this head is in the mail", r.ok && !/^Exclui: .*claude-7/m.test(pedido(idD)) && /podem revisar: [^\n]*claude-7/.test(r.out), r.out + pedido(idD));
  // LOW 1 of Claude 7 xAF on #5261: the family listed as able to review is the one claim-review gives it to, also when
  // its CHANGES on this head is written on the PR.
  r = run(["claim-review", "--as", "Claude 7 X"], { ...m62, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01Hfzoz3uVKpUo5Wosq4VYjL", FAKE_COMMENTS: comMudancas });
  is("c944: and that family can take it, with its CHANGES on the PR too", /pegou:/.test(r.out), r.out);
  run(["release-review", "--as", "Claude 7 X", idD], { ...m62, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01Hfzoz3uVKpUo5Wosq4VYjL" });
  run(["cancel-review", "--as", "Claude 4 X", idD, "--reason", "test"], { ...m62, ...as("c4") });
  // LOW 2 of Claude 7 xAF on #5261: as in the mail, any READY on this head takes the family out, also after its CHANGES.
  const mudouParaPronto = comMudancas + JSON.stringify([`Claude 7 X review #944 @${H62.slice(0, 10)}: READY (the LOW answered)\n\nbody`, "COLLABORATOR"]) + "\n";
  r = run(["request-review", "--from", "Claude 4 X", "--pr", "944", "--sha", H62, "--text", "after ready"], { ...m62, ...as("c4"), FAKE_COMMENTS: mudouParaPronto });
  const idE = /pedido registrado: (\S+)/.exec(r.out)?.[1] ?? "";
  is("c944: a family with CHANGES and then READY on this head, on the PR, is left out, as in the mail", r.ok && /^Exclui: .*claude-7/m.test(pedido(idE)) && /podem revisar: (?![^\n]*claude-7)/.test(r.out), r.out + pedido(idE));
  run(["cancel-review", "--as", "Claude 4 X", idE, "--reason", "test"], { ...m62, ...as("c4") });
  r = run(["request-review", "--from", "Claude 4 X", "--pr", "944", "--sha", H62, "--text", "down"], { ...m62, ...as("c4"), FAKE_COMMENTS_DOWN: "1" });
  is("c944: with the PR's comments unreadable, the request is still written and says so (NOT CHECKED)", r.ok && /pedido registrado/.test(r.out) && /NÃO FORAM CONFERIDOS/.test(r.out), r.out);
}

console.log("ce2d: the reviewer of a comment, on the real formats of today (Claude 5 ibuF and Claude 1 E on #5141)");
{
  const mod = await import(TOOL);
  const h = "065afee703";
  const casos = [
    // [comment, expected family or null, why]
    [`Claude 1 review #5135 ＠${h}a87a81f9bc0b94d60a60900c5098: **CHANGES (1 MEDIUM, privacy/erasure; 1 LOW)**\nReviewer: Claude 1 DKvY (cloud)`, "claude-1", "family before 'review', fullwidth at sign"],
    [`**Cost review #5135 @${h}788aae9928a25a7a9d55a3d3f4b4a5 — READY, 0 new findings** — Claude 2 lpgvy (cloud, session 01FR6Z1LpGvy).`, "claude-2", "family after 'review', in the signature"],
    [`Focal cost review (Claude 1 cloud, money-reviewer lane, session f9afa7) ＠${h}: **READY** on \`5f33642e2e..${h}\``, "claude-1", "family in parentheses after 'review'"],
    [`Independent review (Codex G) of head ${h}b0bf0b8bb6600b1da30117701de865b03.\nVerdict: CHANGES.`, "codex", "Codex, with the verdict on the second line"],
    [`Codex N1 CHANGES (transcrito por Claude 5, cloud iacVn3r) @${h}: **MEDIUM, scope (commission).**`, "codex", "the transcriber does not count"],
    [`**Focal MONEY review #3651 @${h} — CHANGES (2 LEVE)** (Claude 5 iacVn3r, session_012ST5iacVn3rzNGmvRWy4Up). Families with commits on the branch: Claude 4 and Claude 1.`, "claude-5", "the families with commits do not count"],
    [`**READY #3651 @${h}** (focal on the main merge only). This is a focal review from the Claude 2 family (cloud C).`, "claude-2", "verdict first, family later on the line"],
    [`Focal review #5141 @${h} — READY (tests pass, audit 18/18) — Claude 5 ibuF`, "claude-5", "the format of Claude 5 ibuF's finding"],
    [`re-review needed #5135 @${h}, pushed by Claude 4 AC at 19:49 UTC.\nThis answers Claude 1 DKvY's CHANGES (7084720841).`, null, "a re-review request is not a review (Claude 1 E's finding)"],
    [`CLAIMED — Claude 1 E (nuvem c1-revisoes-e), revisão focal de #5135 @${h}. Confiro a correção do CHANGES 4534 do Claude 1 DKvY.`, null, "a CLAIMED is not a verdict"],
    [`fila #5135 @${h}: 2 READY (Claude 2 lpgvy, Claude 1 E) — Claude 5 ibuF`, null, "a queue record is not a review"],
    [`Claude 2 X review #61\nnotes on the diff\nREADY on @${h}, in the third line`, null, "head and verdict only from the third line on"],
    [`Claude 6 review #2048 @0123456789: CHANGES`, null, "a verdict on another head"],
    [`Claude 3 X review #61 @${h}: looks fine`, null, "no verdict word"],
    [`Fixed the MEDIUM from Claude 5 ibuF (https://github.com/solrenning-llc/marktmorgen/pull/5141#issuecomment-7085207019) in ${h}.\n- \`revisoresNoPr\` now reads the first two lines. When they hold this head and a verdict (READY or CHANGES), every family named on them is excluded.`, null, "the author's fix note of #5141 (7085420176) is not Claude 5's review (Claude 5 ibqho's finding)"],
    [`**Fixed at ${h}** (Claude 7 xAF, author), answering Claude 6 i51q's CHANGES at 899e35bbdc.`, null, "a 'Fixed at' note with CHANGES on its line is not a review"],
    [`Note on my review above (7081962031): Claude 1 E had already given a focal money READY on ${h} (7081897226)`, null, "a note on another review is not a review"],
    [`This answers Claude 2 X's CHANGES on ${h}: the merge is redone.`, null, "an answer to a review is not a review"],
    [`Claude 4 2Wb — #5143 @${h}\nREADY: tests pass`, "claude-4", "family and head on line 1, the verdict on line 2, without the word review (LEVE of Claude 5 ibqho on #5141)"],
    [`Claude 1 coord: #5141 @${h}, 1 of 2 READY, waiting on a second family`, null, "a status line counting verdicts is not a review (LEVE of Claude 4 Z on #5141)"],
    [`Claude 1 coord: #5141 @${h}, 1 de 2 READY`, null, "the same status line in Portuguese"],
    [`Claude 7 fdy review #5145 @${h}: READY (1 of 2 READY from outside Claude 6)`, "claude-7", "a review that states its count on its own header line still counts (LEVE of Claude 5 ibqho on #5145)"],
    [`**Claude 7 fdy review #5145 @${h}: READY.** This makes 2 of 2 READY.`, "claude-7", "the same, with the count after the verdict"],
    [`Claude 1 coord panel: #5145 @${h} waiting\nCHANGES requested by Claude 4 earlier`, null, "a status line followed by a line that only mentions a verdict is not a review (LEVE of Claude 5 ibqho on #5145)"],
    [`Claude 4 2Wb — #5143 @${h}\nVerdict: CHANGES (1 MEDIUM)`, "claude-4", "family header with 'Verdict:' opening line 2"],
    [`Claude 4 2Wb — #5143 @${h}\n**READY** (0 findings)`, "claude-4", "family header with a bold verdict opening line 2"],
    [`Claude 4 2Wb — #5145 @${h}\nREADY (2 of 2 READY from outside Claude 6)`, "claude-4", "a review with its count on line 2 counts (Claude 4 AC on #5145)"],
    [`**Focal review #5145 @${h} — READY, 2 of 2 READY now** — Claude 2 lpgvy`, "claude-2", "a review with its count on line 1 counts (Claude 4 AC on #5145)"],
    [`Claude 1 coord: #5145 @${h}, 1 of 2 READY, 1 de 2 CHANGES`, null, "a status line with only counts has no verdict left"],
  ];
  for (const [corpo, esperado, porque] of casos) {
    const achou = typeof mod.revisoraDoComentario === "function" ? mod.revisoraDoComentario(corpo, h) : "(missing)";
    is(`ce2d reviewer: ${porque} -> ${esperado ?? "nobody"}`, achou === esperado, `got ${achou}: ${corpo.slice(0, 120)}`);
  }
}

console.log("ce2d: claim-review and claim-enqueue on those formats");
{
  const g6 = (args) => g(args, join(T, "p"));
  g6(["checkout", "-q", "-B", "ce2d61", M]); writeFileSync(join(T, "p", "ce2d61.txt"), "y\n"); g6(["add", "."]); g6(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "ce2d61\n\nClaude-Session: https://claude.ai/code/session_01S9eVA3KcXUkc6qPJmpNg4a"]);
  g6(["push", "-q", "-f", "../prs.git", "HEAD:refs/heads/ce2d61", "HEAD:refs/pull/61/head"]);
  const H61 = g6(["rev-parse", "HEAD"]), c61 = H61.slice(0, 10);
  g(["init", "-q", "--bare", "mail61.git"]); g(["push", "-q", "../mail61.git", "HEAD:refs/heads/correio"], join(T, "w"));
  const m61 = { CORREIO_REPO: join(T, "mail61.git"), CORREIO_GIT_DIR: join(T, "dir61.git") };
  const comentarios = [
    // A READY: since #5261 only a READY keeps a family out of a review request or a take (a CHANGES does not), and the
    // point here is that the verdict on the second line is read.
    JSON.stringify([`Focal cost review (Claude 1 cloud, money-reviewer lane)\n#61 @${c61}: READY, 0 findings\n\nbody`, "COLLABORATOR"]),
    JSON.stringify([`re-review needed #61 @${c61}, pushed by Claude 4 X\nThis answers Claude 2 X's CHANGES`, "COLLABORATOR"]),
    JSON.stringify([`Codex N1 CHANGES (transcrito por Claude 5, cloud X) @${c61}: MEDIUM`, "COLLABORATOR"]),
  ].join("\n") + "\n";
  const env = (k) => ({ ...m61, ...as(k), FAKE_COMMENTS: comentarios });
  r = run(["request-review", "--from", "Claude 4 X", "--pr", "61", "--sha", H61, "--text", "t"], env("c4"));
  is("ce2d61: the review request is written", r.ok, r.out);
  r = run(["claim-review", "--as", "Claude 1 A"], env("c1a"));
  is("ce2d61: 'Focal cost review (Claude 1 cloud, ...)' with the head and the verdict on the second line keeps Claude 1 out", !/pegou:/.test(r.out) && /nenhum pedido/.test(r.out), r.out);
  r = run(["claim-review", "--as", "Claude 5 X"], env("c5"));
  is("ce2d61: the family that only transcribed a verdict (Claude 5) takes the review", /pegou:/.test(r.out), r.out);
  r = run(["request-enqueue", "--from", "Claude 4 X", "--pr", "61", "--sha", H61, "--text", "t"], env("c4"));
  const fila61 = r;
  r = run(["claim-enqueue", "--as", "Claude 1 A"], env("c1a"));
  is("ce2d61: the queue is not delivered to Claude 1, whose verdict is on the second line", fila61.ok && !/pegou:/.test(r.out) && /veredito da sua família neste head no PR/.test(r.out), fila61.out + r.out);
  r = run(["claim-enqueue", "--as", "Claude 2 X"], env("c2"));
  is("ce2d61: a family named only in a re-review request ('This answers Claude 2's CHANGES') is not kept out of the queue", !/veredito da sua família neste head no PR/.test(r.out), r.out);
}

console.log("the owner's HOLD: only the named session releases it, on a coordinator request and the owner's decision (coordinator 3c47)");
{
  g(["init", "-q", "--bare", "mail62.git"]); g(["push", "-q", "../mail62.git", "HEAD:refs/heads/correio"], join(T, "w"));
  const m62 = { CORREIO_REPO: join(T, "mail62.git"), CORREIO_GIT_DIR: join(T, "dir62.git") };
  const st61 = () => run(["pr-status", "--pr", "20"], m62).out;
  r = run(["hold-pr", "--as", "Claude 4 X", "--pr", "20", "--reason", "owner", "--owner-hold", "bad id"], { ...m62, ...as("c4") });
  is("an owner's HOLD needs the owner's decision id in its format", !r.ok && /OWNER-AAAAMMDD-HHMM-ASSUNTO/.test(r.out), r.out);
  r = run(["hold-pr", "--as", "Claude 4 X", "--pr", "20", "--reason", "child-safety set", "--owner-hold", "OWNER-20261122-0700-HOLD-TEST"], { ...m62, ...as("c4") });
  is("an owner's HOLD is written with the decision id and shown as such", r.ok && /HOLD do dono \(OWNER-20261122-0700-HOLD-TEST\)/.test(st61()), r.out + st61());
  r = run(["release-pr", "--as", "Claude 4 X", "--pr", "20"], { ...m62, ...as("c4") });
  is("whoever placed it cannot release an owner's HOLD", !r.ok && /HOLD do dono/.test(st61()), r.out + st61());
  r = run(["release-pr", "--as", "Claude 3 Z", "--pr", "20"], { ...m62, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_014YNUxAAAAAAAAAAAAAAAAA" });
  is("the PR's author cannot release it either", !r.ok && /HOLD do dono/.test(st61()), r.out + st61());
  raw("prs/20/1", `Ação: LIBERADO\nPR: 20\nPor: Claude 3 Z\nData: ${new Date().toISOString()}\n`, join(T, "mail62.git"));
  is("a release written by raw git, unidentified, does not count against an owner's HOLD", /HOLD do dono/.test(st61()), st61());
  r = run(["hold-pr", "--as", "Claude 2 X", "--pr", "20", "--reason", "another hold"], { ...m62, ...as("c2") });
  is("another HOLD on top keeps the owner's HOLD", /HOLD do dono \(OWNER-20261122-0700-HOLD-TEST\)/.test(st61()), r.out + st61());
  let q = pedidoDe(marca("release-pr", "20"));
  r = run(["release-pr", "--as", "Claude 5 ibqho", "--pr", "20", ...q.args], { ...m62, ...as("ibq"), ...q.env });
  is("the named session, with a request but without the owner's decision, cannot release it", !r.ok && /HOLD do dono/.test(st61()), r.out + st61());
  q = pedidoDe(marca("release-pr", "20"));
  r = run(["release-pr", "--as", "Claude 5 ibqho", "--pr", "20", ...q.args, "--owner-decision", "OWNER-20261122-0800-RELEASE-TEST"], { ...m62, ...as("ibq"), ...q.env });
  is("the named session releases it with the coordinator's request and the owner's decision", r.ok && /LIBERADO/.test(st61()), r.out + st61());
  // A raw git write cannot create an owner's HOLD (review of Claude 4 2Wb on #5145).
  const st21 = () => run(["pr-status", "--pr", "21"], m62).out;
  raw("prs/21/0", `Ação: HOLD\nPR: 21\nPor: Claude 4 X\nMotivo: raw\nHOLD do dono: OWNER-20261122-2200-RAW-TEST\nData: ${new Date().toISOString()}\n`, join(T, "mail62.git"));
  is("a raw HOLD with an owner's line and no session is a plain HOLD, not an owner's HOLD", /#21: HOLD por/.test(st21()) && !/HOLD do dono/.test(st21()), st21());
  r = run(["release-pr", "--as", "Claude 4 X", "--pr", "21"], { ...m62, ...as("c4") });
  is("and the family that signs it releases it as any HOLD", r.ok && /LIBERADO/.test(st21()), r.out + st21());
  raw("prs/21/2", `Ação: HOLD\nPR: 21\nPor: Claude 4 X\nMotivo: raw\nHOLD do dono: OWNER-20261122-2200-RAW-TEST\nData: ${new Date().toISOString()}\nSessão: session_${SES.c2.slice(4)}\n`, join(T, "mail62.git"));
  is("an owner's line under another family's session is not an owner's HOLD either", /#21: HOLD por/.test(st21()) && !/HOLD do dono/.test(st21()), st21());
}

console.log("queue: only the author's family and the head's reviewers are left out; a family with commits takes it (owner 0410, 3 (b))");
{
  g(["init", "-q", "--bare", "mail63.git"]); g(["push", "-q", "../mail63.git", "HEAD:refs/heads/correio"], join(T, "w"));
  const m63 = { CORREIO_REPO: join(T, "mail63.git"), CORREIO_GIT_DIR: join(T, "dir63.git"), CORREIO_SEM_COMMITS: "" };
  const c4trailer = "\n\nClaude-Session: https://claude.ai/code/session_01S9eVA3KcXUkc6qPJmpNg4a";
  g(["checkout", "-q", "-B", "pr63", M], P); const H63 = commit("f63.txt", "63\n", `pr63 by Claude 4${c4trailer}`);
  g(["push", "-q", "../prs.git", "HEAD:refs/heads/claude2/feature-63", "HEAD:refs/pull/63/head"], P);
  r = run(["request-enqueue", "--from", "Claude 2", "--pr", "63", "--sha", H63, "--text", "fila #63"], { ...m63, ...as("c2") });
  is("request-enqueue no longer leaves the families with commits out of the queue", r.ok && /podem enfileirar[^\n]*: [^\n]*claude-4/.test(r.out) && !/605b/.test(r.out) && !/4acb/.test(r.out), r.out);
  r = run(["claim-enqueue", "--as", "Claude 2 Y"], { ...m63, ...as("c2") });
  is("the author's own family still does not take it", !/pegou/.test(r.out) && /é da sua família/.test(r.out), r.out);
  r = run(["claim-enqueue", "--as", "Claude 4 X"], { ...m63, ...as("c4") });
  is("a family with commits on the PR, not the author's nor a reviewer, takes its queue request", /pegou/.test(r.out) && !/EXCEÇÃO 4acb/.test(r.out) && !/tem commits da sua família/.test(r.out), r.out);
  run(["complete-enqueue", "--as", "Claude 4 X", /pegou: (\S+)/.exec(r.out)?.[1] ?? "x", "--result", "enqueued", "--text", "t"], { ...m63, ...as("c4"), FAKE_READY_ALL: "1" });
  // The branch prefix names the author too: a PR on claude7/... asked by an adopting Claude 2 leaves both families out.
  g(["checkout", "-q", "-B", "pr64", M], P); const H64 = commit("f64.txt", "64\n", `pr64 by Claude 4${c4trailer}`);
  g(["push", "-q", "../prs.git", "HEAD:refs/heads/claude7/adopted-64", "HEAD:refs/pull/64/head"], P);
  r = run(["request-enqueue", "--from", "Claude 2", "--pr", "64", "--sha", H64, "--text", "fila #64"], { ...m63, ...as("c2") });
  is("request-enqueue names the branch's family as the author too", r.ok && /família do ramo do PR \(claude-7\)/.test(r.out) && /podem enfileirar[^\n]*: (?![^\n]*claude-7)[^\n]*claude-4/.test(r.out), r.out);
  r = run(["claim-enqueue", "--as", "Claude 7 X"], { ...m63, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01Hfzoz3uVKpUo5Wosq4VYjL" });
  is("the family of the PR's branch does not take it", !/pegou/.test(r.out) && /ramo da sua família \(claude7\/adopted-64\)/.test(r.out), r.out);
  r = run(["claim-enqueue", "--as", "Claude 4 X"], { ...m63, ...as("c4") });
  is("and a family with commits, outside both, takes it", /pegou/.test(r.out), r.out);
  run(["complete-enqueue", "--as", "Claude 4 X", /pegou: (\S+)/.exec(r.out)?.[1] ?? "x", "--result", "enqueued", "--text", "t"], { ...m63, ...as("c4"), FAKE_READY_ALL: "1" });
  // A branch with no family prefix (claude/...): the family with most commits is the author (coordinator, dd03).
  g(["checkout", "-q", "-B", "pr65", M], P); commit("f65a.txt", "65\n", `pr65 by Claude 4${c4trailer}`); const H65 = commit("f65b.txt", "65\n", `pr65 again by Claude 4${c4trailer}`);
  g(["push", "-q", "../prs.git", "HEAD:refs/heads/claude/no-family-65", "HEAD:refs/pull/65/head"], P);
  r = run(["request-enqueue", "--from", "Claude 2", "--pr", "65", "--sha", H65, "--text", "fila #65"], { ...m63, ...as("c2") });
  is("with no family in the branch, request-enqueue names the family with most commits as the author", r.ok && /mais commits no PR, num ramo sem prefixo de família \(claude-4\)/.test(r.out) && /podem enfileirar[^\n]*: (?![^\n]*claude-4)/.test(r.out), r.out);
  r = run(["claim-enqueue", "--as", "Claude 4 X"], { ...m63, ...as("c4") });
  is("and claim-enqueue does not hand it to that family", !/pegou/.test(r.out) && /maior parte dos commits da sua família/.test(r.out), r.out);
  r = run(["claim-enqueue", "--as", "Claude 7 X"], { ...m63, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01Hfzoz3uVKpUo5Wosq4VYjL" });
  is("but another family takes it", /pegou/.test(r.out), r.out);
  run(["complete-enqueue", "--as", "Claude 7 X", /pegou: (\S+)/.exec(r.out)?.[1] ?? "x", "--result", "enqueued", "--text", "t"], { ...m63, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01Hfzoz3uVKpUo5Wosq4VYjL", FAKE_READY_ALL: "1" });
  // LEVE of Claude 4 AC on #5284: merges do not count for the dominant family. Two author commits (Claude 4), then an
  // adopter (Claude 2) merges main three times and asks for the queue: the author is still Claude 4, and is refused.
  const c2trailer = "\n\nClaude-Session: https://claude.ai/code/session_01FR6Z1Q87JZvTFBRpZ8SNo8";
  g(["fetch", "-q", "../prs.git", "main"], P); let mainAgora = g(["rev-parse", "FETCH_HEAD"], P);
  g(["checkout", "-q", "-B", "pr66", mainAgora], P); commit("f66a.txt", "66\n", `pr66 by Claude 4${c4trailer}`); commit("f66b.txt", "66\n", `pr66 again by Claude 4${c4trailer}`);
  for (const k of [1, 2, 3]) {
    g(["checkout", "-q", "-B", "main66", mainAgora], P); mainAgora = commit(`main66-${k}.txt`, `${k}\n`, `main ${k}`); g(["push", "-q", "../prs.git", "HEAD:refs/heads/main"], P);
    g(["checkout", "-q", "pr66"], P); g(["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", `Merge main ${k} (adopted by Claude 2)${c2trailer}`, mainAgora], P);
  }
  const H66 = g(["rev-parse", "HEAD"], P);
  g(["push", "-q", "../prs.git", "HEAD:refs/heads/claude/adopted-66", "HEAD:refs/pull/66/head"], P);
  r = run(["request-enqueue", "--from", "Claude 2", "--pr", "66", "--sha", H66, "--text", "fila #66"], { ...m63, ...as("c2") });
  is("an adopter's merges of main do not make it the author: the family with most non-merge commits is", r.ok && /mais commits no PR, num ramo sem prefixo de família \(claude-4\)/.test(r.out), r.out);
  r = run(["claim-enqueue", "--as", "Claude 4 X"], { ...m63, ...as("c4") });
  is("and the real author's family is refused the queue request of its own PR", !/pegou/.test(r.out) && /maior parte dos commits da sua família/.test(r.out), r.out);
  for (const id of (run(["list-queue"], m63).out.match(/^\S+/gm) ?? [])) run(["cancel-enqueue", "--as", "Claude 2", id, "--reason", "fim do caso"], { ...m63, ...as("c2") });
  // LEVE of Claude 2 lpgvy on #5284: a PR made only of merges (no commit of its own) counts them again, so it has an author.
  g(["fetch", "-q", "../prs.git", "main"], P); let base67 = g(["rev-parse", "FETCH_HEAD"], P);
  g(["checkout", "-q", "-B", "pr67", base67], P);
  for (const k of [1, 2]) {
    g(["checkout", "-q", "-B", "main67", base67], P); base67 = commit(`main67-${k}.txt`, `${k}\n`, `main67 ${k}`); g(["push", "-q", "../prs.git", "HEAD:refs/heads/main"], P);
    g(["checkout", "-q", "pr67"], P); g(["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", `Merge main ${k}${c2trailer}`, base67], P);
  }
  g(["checkout", "-q", "-B", "main67", base67], P); base67 = commit("main67-3.txt", "3\n", "main67 3"); g(["push", "-q", "../prs.git", "HEAD:refs/heads/main"], P);
  g(["checkout", "-q", "pr67"], P);
  const H67 = g(["rev-parse", "HEAD"], P);
  g(["push", "-q", "../prs.git", "HEAD:refs/heads/claude/merges-only-67", "HEAD:refs/pull/67/head"], P);
  r = run(["request-enqueue", "--from", "Claude 5", "--pr", "67", "--sha", H67, "--text", "fila #67"], { ...m63, ...as("c5") });
  is("a PR made only of merges still has an author: the family of its merges", r.ok && /mais commits no PR, num ramo sem prefixo de família \(claude-2\)/.test(r.out), r.out);
  r = run(["claim-enqueue", "--as", "Claude 2 Y"], { ...m63, ...as("c2") });
  is("and that family is refused the queue request", !/pegou/.test(r.out) && /maior parte dos commits da sua família/.test(r.out), r.out);
  // Claude 4 3Kc's note (da28): the watch applies claim-enqueue's own rule, so it no longer wakes a family every 30 s for
  // a queue request it can never take (the author family, or a verdict by the family on this head in the PR).
  const vereditoNoPr = JSON.stringify([`Claude 7 X review #67 @${H67.slice(0, 10)}: READY\n\nbody`, "COLLABORATOR"]) + "\n";
  r = run(["watch", "--as", "Claude 2 Y", "--also", "enqueue", "--seconds", "1"], { ...m63, ...as("c2"), FAKE_COMMENTS: "" });
  is("the watch does not wake the author family for its own queue request", !/fila #67/.test(r.out), r.out);
  r = run(["watch", "--as", "Claude 7 X", "--also", "enqueue", "--seconds", "1"], { ...m63, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01Hfzoz3uVKpUo5Wosq4VYjL", FAKE_COMMENTS: vereditoNoPr });
  is("nor a family with a verdict on this head written only on the PR (ce2d)", !/fila #67/.test(r.out), r.out);
  r = run(["watch", "--as", "Claude 3 X", "--also", "enqueue", "--seconds", "1"], { ...m63, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_014YNUxAAAAAAAAAAAAAAAAA", FAKE_COMMENTS: vereditoNoPr });
  is("but it still wakes a family that can take it", /fila #67/.test(r.out), r.out);
}

console.log("the watch fetches again before it says 'rewritten': a mark set by another watch on the same repository is not a rewrite");
{
  // Two commits X1 <- X2 in a mailbox repository of the tool's own: a watch that read X1 while another one already set the
  // mark at X2 fetches again (here, it then sees X2); only a mark still outside the fresh history is a rewrite.
  const d = join(T, "dir-conferir.git"); g(["init", "-q", "--bare", d]);
  const w = join(T, "w-conferir"); g(["init", "-q", w]);
  const c1 = (() => { writeFileSync(join(w, "a"), "1\n"); g(["add", "a"], w); g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x1"], w); return g(["rev-parse", "HEAD"], w); })();
  const c2 = (() => { writeFileSync(join(w, "b"), "2\n"); g(["add", "b"], w); g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x2"], w); return g(["rev-parse", "HEAD"], w); })();
  g(["push", "-q", d, "HEAD:refs/heads/x"], w);
  const conferir = (primeira, segunda, desde) => spawnSync("node", ["--input-type=module", "-e",
    // The values go in as arguments, never into the code text (CodeQL js/bad-code-sanitization on the first head).
    "const [tool, desde, a, b] = process.argv.slice(1); const m = await import(tool); const r = m.conferirDesde(desde, () => a, () => b); console.log(JSON.stringify({ c: r.c, reescrito: r.r.reescrito }));",
    TOOL, desde, primeira, segunda],
    { env: { ...base, CORREIO_GIT_DIR: d }, encoding: "utf8" }).stdout.trim().split("\n").pop();
  const lido = (x) => { try { return JSON.parse(x); } catch { return {}; } };
  let v = lido(conferir(c1, c2, c2));
  is("a read older than the mark, fetched again and holding it, is not a rewrite", v.reescrito === false && v.c === c2, JSON.stringify(v));
  v = lido(conferir(c1, c1, c2));
  is("a mark still outside the fresh history (the branch went back) is a rewrite", v.reescrito === true, JSON.stringify(v));
  v = lido(conferir(c2, c2, c1));
  is("an ordinary forward read is not a rewrite and needs no second fetch", v.reescrito === false && v.c === c2, JSON.stringify(v));
}

console.log("d993: a review request on a moved head is closed as superseded; a release by one session keeps only that session off");
{
  const g7 = (args) => g(args, join(T, "p"));
  const novoHead = (texto) => {
    writeFileSync(join(T, "p", "d993.txt"), texto); g7(["add", "."]);
    g7(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "d993\n\nClaude-Session: https://claude.ai/code/session_01S9eVA3KcXUkc6qPJmpNg4a"]);
    g7(["push", "-q", "-f", "../prs.git", "HEAD:refs/heads/d993", "HEAD:refs/pull/993/head"]);
    return g7(["rev-parse", "HEAD"]);
  };
  g7(["checkout", "-q", "-B", "d993", M]);
  const HA = novoHead("1\n");
  g(["init", "-q", "--bare", "mail993.git"]); g(["push", "-q", "../mail993.git", "HEAD:refs/heads/correio"], join(T, "w"));
  const m = { CORREIO_REPO: join(T, "mail993.git"), CORREIO_GIT_DIR: join(T, "dir993.git"), FAKE_COMMENTS: "" };
  const feita = (id) => { try { return g(["show", `refs/heads/correio:revisao/feitas/${id}.md`], join(T, "mail993.git")); } catch { return ""; } };
  const idDe = (out) => /pedido registrado: (\S+)/.exec(out)?.[1] ?? "";
  let r = run(["request-review", "--from", "Claude 4 X", "--pr", "993", "--sha", HA, "--text", "a"], { ...m, ...as("c4") });
  const idA = idDe(r.out);
  const HB = novoHead("2\n");
  r = run(["claim-review", "--as", "Claude 5 X"], { ...m, ...as("c5") });
  is("d993: claim-review does not hand out a request whose head moved", r.ok && !/pegou:/.test(r.out) && /nenhum pedido/.test(r.out), r.out);
  is("d993: that request is closed as superseded, with the request's head and the current one", /Resultado: substituído/.test(feita(idA)) && feita(idA).includes(HA) && feita(idA).includes(HB), feita(idA));
  r = run(["read", "--as", "Claude 4 X"], { ...m, ...as("c4") });
  is("d993: and the author is told, in the mail", /: substituído/.test(r.out) && r.out.includes(idA), r.out);

  r = run(["request-review", "--from", "Claude 4 X", "--pr", "993", "--sha", HB, "--text", "b"], { ...m, ...as("c4") });
  const idB = idDe(r.out);
  const HC = novoHead("3\n");
  r = run(["request-review", "--from", "Claude 4 X", "--pr", "993", "--sha", HC, "--text", "c"], { ...m, ...as("c4") });
  const idC = idDe(r.out);
  is("d993: a new request on a new head closes the author family's older open request for that PR", r.ok && idC && r.out.includes(`substituído: ${idB}`) && /Resultado: substituído/.test(feita(idB)), r.out + feita(idB));
  r = run(["list-reviews"], m);
  is("d993: and only the new one is listed as open", !r.out.includes(idB) && r.out.includes(idC), r.out);

  r = run(["claim-review", "--as", "Claude 5 X"], { ...m, ...as("c5") });
  is("d993: the request on the current head is handed out", /pegou:/.test(r.out) && r.out.includes(idC), r.out);
  r = run(["release-review", "--as", "Claude 5 X", idC, "--reason", "taken by mistake"], { ...m, ...as("c5") });
  is("d993: a release says only this session is off", r.ok && /só esta sessão fica de fora/.test(r.out), r.out);
  r = run(["claim-review", "--as", "Claude 5 X"], { ...m, ...as("c5") });
  is("d993: the session that released does not take it again", !/pegou:/.test(r.out), r.out);
  r = run(["claim-review", "--as", "Claude 5 Y"], { ...m, ...as("ibq") });
  is("d993: another session of the same family takes it (the release was not the family's)", /pegou:/.test(r.out) && r.out.includes(idC), r.out);
  r = run(["release-review", "--as", "Claude 5 Y", "--family", idC], { ...m, ...as("ibq") });
  is("d993: --family with a value (the id after it) is refused, and nothing is released", !r.ok && /--family não leva valor/.test(r.out), r.out);
  r = run(["release-review", "--as", "Claude 5 Y", idC, "--reason", "the family has a commit", "--family"], { ...m, ...as("ibq") });
  is("d993: a release with --family says the whole family is off", r.ok && /família claude-5 inteira fica de fora/.test(r.out), r.out);
  r = run(["claim-review", "--as", "Claude 5 Z"], { ...m, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_012ST5iZUmuf9ob1UKKczQnH" });
  is("d993: then no session of that family takes it", !/pegou:/.test(r.out), r.out);
  r = run(["claim-review", "--as", "Claude 7 X"], { ...m, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01Hfzoz3uVKpUo5Wosq4VYjL" });
  is("d993: and another family does", /pegou:/.test(r.out) && r.out.includes(idC), r.out);
  // A release written before this change (no scope line) keeps the family off, as it did.
  const mod = await import(TOOL);
  is("d993: the scope lines are exact, and a release without one is the family's, as before", mod.ESCOPO_SESSAO === "escopo: sessão" && mod.ESCOPO_FAMILIA === "escopo: família" &&
    mod.devolvidoPara({ devolveram: new Set(["claude-5"]), devolveramSessoes: new Set() }, "Claude 5 Q") === true &&
    mod.devolvidoPara({ devolveram: new Set(), devolveramSessoes: new Set(["claude-5-x"]) }, "Claude 5 Q") === false, "");
}

console.log("e0bc: complete-review knows its own verdict on the PR, also for a name like 'Claude 2 (main, 01FR6Z1)' (coordinator ee5e)");
{
  const g8 = (args) => g(args, join(T, "p"));
  const prDe = (n) => {
    g8(["checkout", "-q", "-B", `e0bc-${n}`, M]); writeFileSync(join(T, "p", `e0bc-${n}.txt`), `${n}\n`); g8(["add", "."]);
    g8(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `e0bc ${n}\n\nClaude-Session: https://claude.ai/code/session_01S9eVA3KcXUkc6qPJmpNg4a`]);
    g8(["push", "-q", "-f", "../prs.git", `HEAD:refs/heads/e0bc-${n}`, `HEAD:refs/pull/${n}/head`]);
    return g8(["rev-parse", "HEAD"]);
  };
  g(["init", "-q", "--bare", "mail-e0bc.git"]); g(["push", "-q", "../mail-e0bc.git", "HEAD:refs/heads/correio"], join(T, "w"));
  const m = { CORREIO_REPO: join(T, "mail-e0bc.git"), CORREIO_GIT_DIR: join(T, "dir-e0bc.git") };
  const linha = (texto) => JSON.stringify([texto, "COLLABORATOR"]) + "\n";
  // One review per PR: a review requested, taken and completed by `nome` (session `ses`) with `noPr` as the PR's comments.
  const conclui = (n, nome, ses, noPr) => {
    const H = prDe(n);
    const id = /pedido registrado: (\S+)/.exec(run(["request-review", "--from", "Claude 4 X", "--pr", String(n), "--sha", H, "--text", "t"], { ...m, ...as("c4"), FAKE_COMMENTS: "" }).out)?.[1] ?? "";
    run(["claim-review", "--as", nome], { ...m, CLAUDE_CODE_REMOTE_SESSION_ID: ses, FAKE_COMMENTS: "" });
    return run(["complete-review", "--as", nome, id, "--result", "READY", "--text", "ok"], { ...m, CLAUDE_CODE_REMOTE_SESSION_ID: ses, FAKE_COMMENTS: noPr(H.slice(0, 10)) });
  };
  const AVISO = /aviso: .*claude-2.*já tem veredito/;
  let r = conclui(971, "Claude 2 (main, 01FR6Z1)", SES.c2, (h) => linha(`Claude 2 main review #971 @${h}: READY\n\nmerge-tree clean against origin/main`));
  is("e0bc: the session's own verdict, named 'Claude 2 main' on the PR, is not warned about as another session's", r.ok && /concluído/.test(r.out) && !AVISO.test(r.out), r.out);
  r = conclui(972, "Claude 2 (main, 01FR6Z1)", SES.c2, (h) => linha(`Claude 2 lpgvy review #972 @${h}: READY\n\nmerge-tree clean against origin/main, read on main`));
  is("e0bc: a sibling's verdict is still warned about, even when its body says 'main' below the header", r.ok && AVISO.test(r.out), r.out);
  r = conclui(973, "Claude 2 (main, 01FR6Z1)", SES.c2, (h) => linha(`Claude 2 review #973 @${h}: READY (session \`${SES.c2.replace(/^cse_/, "").slice(0, 12)}\`)\n\nbody`));
  is("e0bc: a verdict that names only the session's id (its first 10 characters) is the session's own", r.ok && !AVISO.test(r.out), r.out);
  r = conclui(974, "Claude 2 (main, 01FR6Z1)", SES.c2, (h) => linha(`Claude 2 Pfn2k review #974 @${h}: READY\n\nbody`));
  is("e0bc: another Claude 2 session (Pfn2k), with no word of the name and no id of the session, is a sibling", r.ok && AVISO.test(r.out), r.out);
  // LEVE of Claude 5 icEJ on #5408 @51f5c361af: a name word counts only inside the reviewer's own label ("Claude N
  // <word>" or "Claude N (...)"), so "merge of main" in a sibling's header no longer reads as Claude 2 main's own verdict.
  r = conclui(975, "Claude 2 (main, 01FR6Z1)", SES.c2, (h) => linha(`**Claude 2 review #975 @${h}: READY (focal, merge of main), 0 findings** — Claude 2 lpgvy …\n\nbody`));
  is("e0bc: a sibling's header with 'merge of main' outside its label is still a sibling's verdict for Claude 2 main", r.ok && AVISO.test(r.out), r.out);
  const mod = await import(TOOL);
  is("e0bc: the marks of 'Claude 2 (main, 01FR6Z1)', 'Claude 6 UoHAG' and a Claude 1 cloud name are their own words, without generic ones, and the session id's first 10",
    JSON.stringify([mod.marcasDaSessao("Claude 2 (main, 01FR6Z1)", { id: "session_01FR6Z1MtkLEMTRT4AviXXzK" }), mod.marcasDaSessao("Claude 6 UoHAG", null),
      mod.marcasDaSessao("Claude 1 (nuvem c1-revisoes-f, cse_01DKvYQbspYs)", null)])
    // "01FR6Z1" is Claude 2's family prefix in SESSOES, not this session's mark (LEVE 2 of Claude 5 iYnra on #5408 @ca80774537).
    === JSON.stringify([{ palavras: ["main"], id: "01FR6Z1Mtk" }, { palavras: ["UoHAG"], id: "" }, { palavras: ["c1-revisoes-f", "cse_01DKvYQbspYs"], id: "" }]),
    JSON.stringify([mod.marcasDaSessao("Claude 2 (main, 01FR6Z1)", { id: "session_01FR6Z1MtkLEMTRT4AviXXzK" }), mod.marcasDaSessao("Claude 1 (nuvem c1-revisoes-f, cse_01DKvYQbspYs)", null)]));
  const C1 = "Claude 1 (nuvem c1-revisoes-f, cse_01DKvYQbspYs)";
  is("e0bc: a Claude 1 cloud sibling's label sharing only 'nuvem' is a sibling's",
    mod.comentarioDaSessao("Claude 1 (nuvem c1-revisoes-g, cse_01ZqWx8Kp2Lm) review #976 @abc: READY", C1, null) === false);
  is("e0bc: the Claude 1 cloud session's own label is its own",
    mod.comentarioDaSessao("**Claude 1 (nuvem c1-revisoes-f, cse_01DKvYQbspYs) review #977 @abc: READY**", C1, null) === true);
  is("e0bc: 'Claude 6 review ... by Claude 6 UoHAG' names the session in its second label",
    mod.comentarioDaSessao("Claude 6 review #978 @abc: READY, by Claude 6 UoHAG", "Claude 6 UoHAG", null) === true);
  // LEVE of Claude 3 yaQt on #5408 @1139d5d034: the session id counts only in the reviewer's own first line, never in
  // a sister's body that cites this session (whose finding or fix it checks).
  const S2 = { id: "session_01FR6Z1MtkLEMTRT4AviXXzK" };
  is("e0bc: a sister's verdict that cites this session's id below its header is a sister's",
    mod.comentarioDaSessao("Claude 2 lpgvy review #980 @abc1234567: READY, 0 findings\n\nFocal on the fix of the LEVE that Claude 2 main (session `01FR6Z1MtkLE`) raised in 7100000000.", "Claude 2 (main, 01FR6Z1)", S2) === false);
  is("e0bc: the session's id in its own first line is still its own",
    mod.comentarioDaSessao("Claude 2 review #981 @abc1234567: READY (session `01FR6Z1MtkLE`)\n\nbody", "Claude 2 (main, 01FR6Z1)", S2) === true);
  // LEVE of Claude 5 ibqho on #5408 @fe7b3613dd: a session with no name word that signs on a later line ("Reviewer:
  // Claude 6, session 018ZjhH...", Claude 6's real format, 7109479248) still reads its own verdict as its own; a sister
  // that only cites the id in its body is still a sister's.
  const S6 = { id: "session_018ZjhHi51AAAAAAAAAAAAAAAA" };
  is("e0bc: the session's id on its own signature line ('Reviewer: ..., session ...') is its own",
    mod.comentarioDaSessao("Claude 6 review #5422 @8fcb16aaa8: CHANGES\n\nReviewer: Claude 6, session 018ZjhHi51\n\nbody", "Claude 6", S6) === true);
  is("e0bc: a 'Por:' or 'Sessão:' signature line counts too",
    mod.comentarioDaSessao("Claude 6 review #5423 @8fcb16aaa8: READY\n\nbody\n\nPor: Claude 6 (sessão 018ZjhHi51)", "Claude 6", S6) === true
    && mod.comentarioDaSessao("Claude 6 review #5424 @8fcb16aaa8: READY\n\nSessão: 018ZjhHi51", "Claude 6", S6) === true);
  is("e0bc: a sister whose own signature names another session and whose body cites this id is a sister's",
    mod.comentarioDaSessao("Claude 6 review #5425 @8fcb16aaa8: READY\n\nReviewer: Claude 6, session 018ZjhHhUo\n\nSession 018ZjhHi51 raised the LEVE; it is fixed.", "Claude 6", S6) === false);
  // LEVE 3 of Claude 5 hed9 on #5408: only the reviewer's own label counts (the first, or one signed "by", "por", "—"
  // or "Reviewer:"), short labels and "local" are marks, and an id written longer must be this session's own.
  is("e0bc: a sibling's header that cites this session as the one whose fix it checks is a sibling's",
    mod.comentarioDaSessao("Claude 5 icEJ review #5045 @abc1234567: READY, confirms the fix of Claude 5 hed9", "Claude 5 hed9", null) === false);
  is("e0bc: a short label is a mark: 'Claude 4 Z' knows its own verdict, and not 'Claude 4 AC''s",
    mod.comentarioDaSessao("Claude 4 Z review #1 @abc1234567: READY", "Claude 4 Z", null) === true
    && mod.comentarioDaSessao("Claude 4 AC review #1 @abc1234567: READY", "Claude 4 Z", null) === false);
  is("e0bc: 'local' is a mark: 'Claude 3 local' knows its own verdict, and a cloud sibling's is not it",
    mod.comentarioDaSessao("Claude 3 local review #1 @abc1234567: READY", "Claude 3 local", null) === true
    && mod.comentarioDaSessao("Claude 3 (nuvem R) review #1 @abc1234567: READY", "Claude 3 local", null) === false);
  const S1 = { id: "session_01DKvYQc2qAAAAAAAAAAAAAA" };
  is("e0bc: an id written longer than ten characters must be this session's own (two sessions share 01DKvYQc2q)",
    mod.comentarioDaSessao("Claude 1 review #1 @abc1234567: READY (session 01DKvYQc2qBBBB)", "Claude 1", S1) === false
    && mod.comentarioDaSessao("Claude 1 review #1 @abc1234567: READY (session 01DKvYQc2qAAAA)", "Claude 1", S1) === true);
  is("e0bc: a name word in a Claude 2 sibling's label only as part of a longer word is not the session's",
    mod.comentarioDaSessao("Claude 2 mainline review #979 @abc: READY", "Claude 2 (main, 01FR6Z1)", null) === false);
}

console.log("strict to add, loose to take out: the READY the 3-READY gate counts (CO (l); Claude 5 hed9 7116086946, 7116612506 and 7117878288)");
{
  const mod = await import(TOOL);
  const H = "ca8077453709979fc2c9a95fb622d767f284752f", h = H.slice(0, 10), N = 5408;
  const soma = [
    [`Claude 5 hed9 review #${N} @${h}: READY, 0 findings`, "claude-5"],
    [`**Claude 7 review #${N} @${h}...: READY (0 findings)**`, "claude-7"],
    [`Claude 1 review #${N} @${h} (focal de imposto, …): READY (0 achados).`, "claude-1"],
    [`Codex X6 review #${N} @${h} (transcribed by Claude 5): READY`, "codex"],
    [`Claude 3 wSUb3 focal review #${N} @${h}: READY — sem achados`, "claude-3"],
    [`### Claude 2 upbeat review #${N} @${h}: **READY**`, "claude-2"],
    // never adds
    [`Claude 1 B #${N} @${h}: READY (2 of 3)`, null],
    [`Claude 1 coord #${N} @${h}: READY? 2 of 3 so far`, null],
    [`READY #${N} @${h}? not yet: Claude 3 and Claude 5 only`, null],
    [`> Claude 3 review #${N} @${h}: READY`, null],
    [`Claude 3 review #${N} @${h}: READY not yet`, null],
    [`Claude 3 review #${N} @${h}: READY once CI passes`, null],
    [`Claude 3 review #${N} @${h}: READY (conditional on fix)`, null],
    [`READY (2 of 3) #${N} @${h} — Claude 1 coord`, null],
    [`READY #${N} @${h} needs Claude 6`, null],
    [`Claude 1 coord: review status #${N} @${h} — 2 READY`, null],
    [`Claude 1 coord re-review needed #${N} @${h}: READY from Claude 2`, null],
    [`Claude 1 coord review needed #${N} @${h}: READY`, null],
    [`Claude 5 iYzLs review #${N} @${h}: READY withdrawn`, null],
    [`Claude 3 X review #${N} @${h}: READY → CHANGES (ALTO found)`, null],
    [`Claude 3 X review #${N} @${h}: READYish`, null],
    [`Claude 3 review #${N} @0000000000: READY`, null],
    [`Claude 3 review #9999 @${h}: READY`, null],
    [`- Claude 3 review #${N} @${h}: READY`, null],
  ];
  const tira = [
    [`Claude 3 X review #${N} @${h}: CHANGES requested (1 ALTO)`, "claude-3"],
    [`Claude 3 X review #${N} @${h}: NOT READY (1 ALTO)`, "claude-3"],
    [`Claude 5 iYzLs review #${N} @${h}: READY withdrawn`, "claude-5"],
    [`Claude 3 X review #${N} @${h}: CHANGES needed (1 ALTO)`, "claude-3"],
    [`Claude 3 X review #${N} @${h}: READY → CHANGES (ALTO found)`, "claude-3"],
    [`Focal review #${N} @${h} — CHANGES — Claude 3 X`, "claude-3"],
    [`WITHDRAWN: my READY 7111050238 on #${N} @${h} — Claude 3 Q`, "claude-3"],
    [`Claude 3 Q: I withdraw my approval of #${N} @${h}`, "claude-3"],
    [`Correction to my READY on #${N} @${h} — Claude 5 iYwjc: typo; READY unchanged`, "claude-5"],
    [`Claude 1 coord #${N} @${h}: READY? 2 of 3 so far`, "claude-1"],
    [`Claude 3 review #${N} @${h}: READY`, null],
    [`Claude 1 coord: #${N} @${h} — 2 READY (Claude 3, Claude 5)`, null],
  ];
  soma.push([`Claude 3 X review #${N} ＠${h}: READY`, null], [`Claude 1 coord status review #${N} @${h}: READY`, null], [`Claude 3 X review #${N} @${h}: READY if CI passes`, null],
    [`Claude 3 X review #${N} @${h}: READY unless the tests fail`, null], [`Claude 3 X review #${N} @${h}: READY until the next head`, null],
    [`Claude 3 X review #${N} @${h}: READY pending CI`, null], [`Claude 3 X review #${N} @${h}: READY after the fix`, null], [`Claude 3 X review #${N} @${h}: READY but one NIT`, null],
    [`Claude 3 X review #${N} @${h}: READY retracted`, null], [`Claude 3 X review #${N} @${h}: READY -> CHANGES`, null], [`Claude 3 X review #${N} @${h}: READY 2/3 (Claude 1, 2)`, null]);
  tira.push([`Claude 3 X review #${N} ＠${h}: CHANGES`, "claude-3"], [`Claude 3 X: I retract the READY above`, "claude-3"], [`Claude 3 X: I retract my READY on @0000000000`, null],
    [`Claude 5 icEJ focal review #${N} @${h} (\`a..b\`): CHANGES`, "claude-5"], [`Review #${N} @${h} by Claude 3 yaQt (session x), mail request y: CHANGES`, "claude-3"]);
  for (const [t, e] of soma) is(`adds: "${t.slice(0, 70)}" -> ${e ?? "nothing"}`, mod.readyEstrito?.(t, N, H) === e, String(mod.readyEstrito?.(t, N, H)));
  // Seventh round (Claude 5 hed9 7118892597 and Claude 3 7118918923 on ab697952b5).
  const H7 = H;
  soma.push([`* Claude 3 review #${N} @${h}: READY`, null], [`    Claude 3 review #${N} @${h}: READY`, null], [`\tClaude 3 review #${N} @${h}: READY`, null],
    [`Claude 3 review #${N} @${h} (not yet, waiting for CI): READY`, null], [`Claude 3 review #${N} @${h} (if CI passes): READY`, null],
    [`Claude 3 review #${N} @${h}: READY. Sorry, I meant CHANGES`, null], [`Claude 3 review #${N} @${h}: READY; scratch that`, null],
    [`Claude 3 review #${N} @${h}: READY, CI still running`, null], [`Claude 33 review #${N} @${h}: READY`, null], [`Claude 5 iZ — Codex X6 review #${N} @${h}: READY`, null]);
  tira.push([`WITHDRAWN: my READY 7111050238 — Claude 3 Q`, "claude-3"], [`Claude 3 Q: I withdraw my READY 7116000000 above (the fix was wrong)`, "claude-3"],
    [`Claude 3 Q: I withdraw my READY https://github.com/solrenning-llc/marktmorgen/pull/5408#issuecomment-7116000000 (found a GRAVE)`, "claude-3"],
    [`Queue request withdrawn: #${N} @${h} — Claude 5 icRk, 19:13 UTC`, null], [`Claude 5 icRk: my queue request for #${N} @${h} is withdrawn`, null],
    [`Withdrawn in favor of #5410.`, null], [`O PR retira a trava antiga do tax gate.`, null], [`Retiro o pedido de fila; vou juntar o main antes.`, null],
    [`#${N} @${h}: the CHANGES above are fixed in this head`, null], [`NOT READY #${N} @${h} — see inline`, null],
    [`Claude 3 review #${N} @${h}: BLOCKED, ALTO found`, "claude-3"], [`Claude 3 review #${N} @${h}: REJECTED`, "claude-3"], [`Claude 3 X #${N} @${h}: do not merge yet`, "claude-3"],
    [`Claude 3 X: I revoke my READY on #${N} @${h}`, "claude-3"], [`Claude 3 X: meu READY no #${N} @${h} fica retirado`, "claude-3"], [`Claude 3 X: I take back my review of #${N} @${h}`, "claude-3"],
    [`Claude 5 iZ — Codex X6 review #${N} @${h}: CHANGES`, "codex"], [`Claude 3 X: I retract my READY on @0000000aaa`, null], [`Claude 1 coord: #${N} @${h} — retiro o HOLD`, null],
    [`Claude 3 X\nsome text\n#${N} @${h}: CHANGES (head on line 3)`, "claude-3"]);
  // Eighth round (Claude 5 ichw 7119507303 on 0d1fe3c549): Portuguese caveats and findings never add; Portuguese take-outs.
  const n8 = soma.length;
  soma.push([`Claude 3 review #${N} @${h}: READY, sem achados.`, "claude-3"], [`Claude 3 review #${N} @${h}: READY (0 achados; sem mudança de comportamento)`, "claude-3"],
    [`Claude 3 review #${N} @${h}: READY, 0 LEVE, 0 NIT`, "claude-3"], [`Claude 3 review #${N} @${h}: READY, mas falta conferir o tsc`, null],
    [`Claude 3 review #${N} @${h}: READY (ainda rodando os testes)`, null], [`Claude 3 review #${N} @${h}: READY, depois do conserto do LEVE`, null],
    [`Claude 3 review #${N} @${h}: READY, exceto o NIT acima`, null], [`Claude 3 review #${N} @${h}: READY, com 1 LEVE`, null],
    [`Claude 3 review #${N} @${h}: READY, 1 NIT`, null],
    [`**Claude 3 review #${N} @${h}: READY, 0 findings (sem achados), no defect of any level, NIT included.** Claude 3 (cloud)`, "claude-3"],
    [`Claude 5 review #${N} @${h}: READY, sem achados (0 findings). Scope: focal on \`a..b\` plus the ZA check of every earlier finding`, "claude-5"],
    [`Claude 1 review #${N} @${h}: **READY** (apagamento/dados pessoais e custo; PR inteiro contra o main; sem achados). Conserto do Codex`, "claude-1"],
    [`Claude 5 ia5d review #${N} @${h}: **READY, 0 findings, 0 notes, 0 NIT** — Claude 5 ia5d (cloud)`, "claude-5"],
    [`Claude 3 review #${N} @${h}: READY, LEVE acima`, null], [`Claude 3 review #${N} @${h}: READY. Sorry, I meant CHANGES`, null], [`Claude 3 review #${N} @${h}: READY except the NIT above`, null], [`Claude 3 review #${N} @${h} (1 LEVE): READY`, null]);
  tira.push([`Claude 3 nota #${N} @${h}: o READY acima fica retirado`, "claude-3"], [`Claude 3 #${N} @${h}: mudanças necessárias`, "claude-3"],
    [`Claude 3 review #${N} @${h}: NÃO PRONTO`, "claude-3"], [`Claude 3 review #${N} @${h}: reprovado, 1 ALTO`, "claude-3"]);
  for (const [t, e] of tira) is(`takes out: "${t.slice(0, 70)}" -> ${e ?? "nothing"}`, (mod.tiraReady?.(t, N, H7)?.familia ?? null) === e, JSON.stringify(mod.tiraReady?.(t, N, H7)));
  for (const [t, e] of soma.slice(n8)) is(`adds (ichw): "${t.slice(0, 70)}" -> ${e ?? "nothing"}`, mod.readyEstrito?.(t, N, H) === e, String(mod.readyEstrito?.(t, N, H)));
  is("takes out: a GitHub review in the CHANGES_REQUESTED state with no family named is '?' (NOT CHECKED)", mod.tiraReady?.("Looks good to me", N, H, "CHANGES_REQUESTED")?.familia === "?");
  is("takes out: a CHANGES_REQUESTED review of another head (commit_id) takes nothing out (MÉDIO 2 of hed9)", mod.tiraReady?.("", N, H, "CHANGES_REQUESTED", "0000000aaa0000000000000000000000000000aa") === null);
  is("LEVE 5 of hed9: a header that starts with the family is its own, though it names a sibling as 'by'",
    mod.comentarioDaSessao?.(`Claude 2 main review #979 @abc: READY — confirms the fix by Claude 2 upbeat`, "Claude 2 main", null) === true);
  // LEVE 2 of Claude 5 iYnra on ca80774537: a family-wide session prefix is no session mark; an explicit signer wins.
  is("iYnra LEVE 2: '01FR6Z1' is Claude 2's family prefix, not the mark of 'Claude 2 (main, 01FR6Z1)'",
    mod.comentarioDaSessao?.(`Claude 2 (upbeat, 01FR6Z1) review #979 @abc: READY`, "Claude 2 (main, 01FR6Z1)", null) === false);
  is("iYnra LEVE 2: 'main' is still that session's mark", mod.comentarioDaSessao?.(`Claude 2 (main, 01FR6Z1) review #979 @abc: READY`, "Claude 2 (main, 01FR6Z1)", null) === true);
  is("iYnra LEVE 2: with an explicit signer, the first label is not the session's ('Focal review of the Claude 5 hed9 fix — Claude 5 ibqho')",
    mod.comentarioDaSessao?.(`Focal review of the Claude 5 hed9 fix #979 @abc — Claude 5 ibqho: READY`, "Claude 5 hed9", null) === false
    && mod.comentarioDaSessao?.(`Focal review of the Claude 5 hed9 fix #979 @abc — Claude 5 ibqho: READY`, "Claude 5 ibqho", null) === true);
  is("takes out: a CHANGES_REQUESTED review names its family when it says it", mod.tiraReady?.(`Claude 4 X: see inline notes on @${h}`, N, H, "CHANGES_REQUESTED")?.familia === "claude-4");
}

console.log("three READY from three outside families on the exact head before a PR is enqueued (owner, OWNER-20261123-1442-THREE-REVIEWS)");
{
  g(["init", "-q", "--bare", "mail1442.git"]); g(["push", "-q", "../mail1442.git", "HEAD:refs/heads/correio"], join(T, "w"));
  const MQ = join(T, "mail1442.git"), mq = { CORREIO_REPO: MQ };
  const H = pr(1442, "f1442.txt", "1442\n"), h = H.slice(0, 10);
  // A comment (or a review) on the PR as GitHub answers it: [body, association, date].
  let minuto = 0;
  const comentario = (t, em = `2026-11-23T10:${String(minuto++).padStart(2, "0")}:00Z`) => JSON.stringify([t, "COLLABORATOR", em]) + "\n";
  const ready = (quem, n = 1442, hh = h) => comentario(`${quem} review #${n} @${hh}: READY, 0 findings`);
  const verify = (id, env = {}) => run(["verify-enqueue", "--as", "Claude 6 X", id], { ...as("c6"), ...mq, ...env });
  r = run(["request-enqueue", "--from", "Claude 2", "--pr", "1442", "--sha", h, "--text", "fila #1442"], { ...as("c2"), ...mq });
  const id = /registrado: (\S+)/.exec(r.out)?.[1];
  r = run(["claim-enqueue", "--as", "Claude 6 X"], { ...as("c6"), ...mq });
  is("1442: the request is delivered", /pegou/.test(r.out), r.out);
  const dois = ready("Claude 1 Q") + ready("Claude 3 Q");
  r = verify(id, { FAKE_COMMENTS: dois });
  is("1442: two READY on the head are not enough: verify-enqueue refuses and says 3", !r.ok && /2 READY/.test(r.out) && /\b3\b/.test(r.out) && /1442/.test(r.out), r.out);
  // ALTO of Claude 5 hed9 on #5408 @c615434258: the proof is the PR comment (CO (l)); a review concluded only in the mail,
  // with nothing written on the PR, adds no READY.
  revisoesNoCorreio(MQ, 1442, H, ["Claude 4 Q", "Claude 5 Q", "Claude 7 Q"]);
  r = verify(id, { FAKE_COMMENTS: dois });
  is("1442: READY concluded only in the mail, with nothing on the PR, do not count (CO (l))", !r.ok && /2 READY/.test(r.out), r.out);
  // MEDIUM 1 of hed9 on d2e20e0a4b and on 0cebe29a68: status, tally and request lines never count, with "review" in them
  // or not.
  const status = [`Claude 1 coord: #1442 @${h} — 2 READY (Claude 3, Claude 5); needs 1 more`, `Claude 7: #1442 @${h} is READY for the queue`,
    `Claude 1 B: #1442 @${h} needs READY from 3 families (has 2)`, `Claude 1 coord: review status #1442 @${h} — 2 READY (Claude 3, Claude 5); needs 1 more`,
    `Claude 7: asked for a 3rd review on #1442 @${h}, READY so far from Claude 2`, `Claude 1 coord: re-review needed #1442 @${h} — READY from Claude 2 and Claude 6`,
    `Claude 4 B: review needed #1442 @${h} — READY from Claude 1`, `Claude 1 coord: request-review #1442 @${h}, READY from Claude 2`,
    `Claude 1 coord verdict tally #1442 @${h}: 2 READY (Claude 2, Claude 3)`, `Claude 5 C: #1442 @${h} is READY for the queue`,
    `READY for the queue: #1442 @${h} (Claude 4 coord)`];
  for (const linha of status) {
    r = verify(id, { FAKE_COMMENTS: dois + comentario(linha) });
    is(`1442: a status or request line never counts: "${linha.slice(0, 60)}"`, !r.ok && /2 READY/.test(r.out), r.out);
  }
  r = verify(id, { FAKE_COMMENTS: dois + ready("Claude 4 Q", 1442, "0000000000") });
  is("1442: a READY on another head does not count", !r.ok && /2 READY/.test(r.out), r.out);
  // On a branch with no family prefix the author is the family with most commits (coordinator dd03): here the PR's
  // commits carry no trailer and an author "t", so the Codex family (LEVE 1 of Claude 5 hed9 on #5408).
  r = verify(id, { FAKE_COMMENTS: dois + ready("Codex Q") });
  is("1442: a READY from the author's family does not count", !r.ok && /2 READY/.test(r.out), r.out);
  is("1442: on an unprefixed branch the refusal names the family it counted as the author (NIT of Claude 5 id8Ws on #5408)",
    /sem a família codex \(a dominante nos commits, num ramo sem prefixo de família\)/.test(r.out), r.out);
  r = verify(id, { FAKE_COMMENTS_DOWN: "1" });
  is("1442: the PR's comments unread: NOT CHECKED, nothing is enqueued", !r.ok && /NÃO FORAM CONFERIDAS/.test(r.out), r.out);
  r = run(["complete-enqueue", "--as", "Claude 6 X", id, "--result", "enqueued", "--text", "t"], { ...as("c6"), ...mq, FAKE_COMMENTS: dois });
  is("1442: complete-enqueue as enqueued is refused with two", !r.ok && /2 READY/.test(r.out), r.out);
  const tres = dois + ready("Claude 2 Q");
  r = verify(id, { FAKE_COMMENTS: tres });
  is("1442: on an unprefixed branch the requester's own READY counts, as on a prefixed one (LEVE 1 of Claude 5 hed9 on #5408)", r.ok && new RegExp(`enfileire ${H}`).test(r.out), r.out);
  // Strict to add (sixth design, hed9 on ca80774537): only "<family> review #N @<head>: READY" at the start of line 1
  // adds; the refusal names a READY written in another shape and the line to write (MEDIUM 3 of hed9).
  for (const [quem, linha] of [["Claude 7", `**Claude 7 review #1442 @${h}...: READY (0 findings)**`], ["Claude 4", `Claude 4 X review #1442 @${h} (focal de imposto, …): READY (0 achados).`]]) {
    r = verify(id, { FAKE_COMMENTS: dois + comentario(linha) });
    is(`1442: the strict header "${linha.slice(0, 50)}" counts as ${quem}'s READY`, r.ok, r.out);
  }
  for (const linha of [`**READY #1442 @${h}, 0 findings (sem achados).** Claude 4 X`, `Claude 4 2Wb — #1442 @${h}\nREADY: tests pass`, `Money focal review #1442 @${h} by Claude 4 upbeat: **READY**`]) {
    r = verify(id, { FAKE_COMMENTS: dois + comentario(linha) });
    is(`1442: a READY in another shape does not count, and the refusal names it with the line to write: "${linha.slice(0, 40)}"`,
      !r.ok && /2 READY/.test(r.out) && /não contaram/.test(r.out) && /claude-4:/.test(r.out) && /review #1442 @/.test(r.out), r.out);
  }
  r = verify(id, { FAKE_COMMENTS: dois + comentario(`Claude 5 C: thanks; quoting it\n> Claude 4 X review #1442 @${h}: READY`) + comentario(`> Claude 4 X review #1442 @${h}: READY`) });
  is("1442: a quoted strict line never adds a READY", !r.ok && /2 READY/.test(r.out), r.out);
  // MEDIUM 1 of hed9 on c615434258 (README: the author may answer in writing and ask the family to look again at the same
  // head): the family's LAST verdict on the head counts, in time order across comments and reviews (LEVE B of zr).
  const cedo = (t, m) => comentario(t, `2026-11-23T09:${m}:00Z`);
  r = verify(id, { FAKE_COMMENTS: dois + cedo(`Claude 2 W review #1442 @${h}: CHANGES, 1 LEVE`, "00") + ready("Claude 2 Q") });
  is("1442: a READY after a CHANGES of the same family on the head counts", r.ok, r.out);
  r = verify(id, { FAKE_COMMENTS: tres + comentario(`Claude 2 W review #1442 @${h}: CHANGES, 1 LEVE`) });
  is("1442: a CHANGES after the READY of the same family takes it out", !r.ok && /2 READY/.test(r.out), r.out);
  r = verify(id, { FAKE_COMMENTS: tres, FAKE_REVIEWS: JSON.stringify([`Claude 2 W review #1442 @${h}: CHANGES, 1 LEVE`, "COLLABORATOR", "2026-11-23T23:59:00Z"]) + "\n" });
  is("1442: a later CHANGES in the PR reviews takes out a READY from the comments (time order, LEVE B of zr)", !r.ok && /2 READY/.test(r.out), r.out);
  r = verify(id, { FAKE_COMMENTS: tres.replace(ready("Claude 2 Q"), "") + comentario(`Claude 2 W review #1442 @${h}: CHANGES`), FAKE_REVIEWS: JSON.stringify([`Claude 2 W review #1442 @${h}: READY`, "COLLABORATOR", "2026-11-23T23:59:00Z"]) + "\n" });
  is("1442: a later READY in the PR reviews counts after a CHANGES in the comments", r.ok, r.out);
  // Loose to take out (ALTO 2 of hed9 on ca80774537): any comment of the family on the head that speaks of CHANGES, NOT
  // READY, "READY?", a withdrawal or a correction takes its READY out, until a later strict READY of that family.
  for (const linha of [`Claude 3 X review #1442 @${h}: CHANGES requested (1 ALTO)`, `Claude 3 X review #1442 @${h}: NOT READY (1 ALTO)`,
    `Claude 3 iYzLs review #1442 @${h}: READY withdrawn`, `Claude 3 X review #1442 @${h}: READY → CHANGES (ALTO found)`, `Focal review #1442 @${h} — CHANGES — Claude 3 X`,
    `Re: Claude 3's CHANGES on #1442 @${h} — answered`]) {
    r = verify(id, { FAKE_COMMENTS: tres + comentario(linha) });
    is(`1442: "${linha.slice(0, 55)}" takes Claude 3's READY out`, !r.ok && /2 READY/.test(r.out), r.out);
  }
  r = verify(id, { FAKE_COMMENTS: tres + comentario(`Claude 3 X review #1442 @${h}: NOT READY (1 ALTO)`) + ready("Claude 3 X") });
  is("1442: a later strict READY of the family brings it back", r.ok, r.out);
  r = verify(id, { FAKE_COMMENTS: tres + comentario(`Claude 1 coord: #1442 @${h} — 2 READY (Claude 3, Claude 5)`) + comentario(`Claude 3 focal review #1442 @${h}: READY (the earlier finding was retirado after the fix)`)
    + comentario(`Claude 3 focal review #1442 @${h}: READY (the earlier request was withdrawn by the author)`) });
  is("1442: a status line with no CHANGES or withdrawal, and a READY that only mentions a 'retirado' finding, take nothing out", r.ok, r.out);
  // MEDIUM 2 of hed9 on ca80774537: GitHub review states.
  const revisao = (t, estado, em = "2026-11-23T23:00:00Z") => JSON.stringify([t, "COLLABORATOR", em, estado, em]) + "\n";
  r = verify(id, { FAKE_COMMENTS: dois, FAKE_REVIEWS: revisao(`Claude 4 X review #1442 @${h}: READY`, "PENDING", "") + revisao(`Claude 7 X review #1442 @${h}: READY`, "DISMISSED") });
  is("1442: a PENDING or DISMISSED GitHub review never adds a READY", !r.ok && /2 READY/.test(r.out), r.out);
  r = verify(id, { FAKE_COMMENTS: tres, FAKE_REVIEWS: revisao(`Claude 3 X: see the inline notes on @${h}`, "CHANGES_REQUESTED") });
  is("1442: a CHANGES_REQUESTED GitHub review takes its family's READY out", !r.ok && /2 READY/.test(r.out), r.out);
  r = verify(id, { FAKE_COMMENTS: tres, FAKE_REVIEWS: revisao("Please fix the tests", "CHANGES_REQUESTED") });
  is("1442: a CHANGES_REQUESTED review that names no family makes the gate NOT CHECKED", !r.ok && /NÃO FORAM CONFERIDAS/.test(r.out) && /CHANGES_REQUESTED/.test(r.out), r.out);
  // LEVE 2 of hed9 on ca80774537: an edit counts at the time of the edit; a tie goes to the taking out.
  r = verify(id, { FAKE_COMMENTS: JSON.stringify([`WITHDRAWN: my READY on #1442 @${h} — Claude 3 Q`, "COLLABORATOR", "2026-11-23T08:00:00Z", "", "2026-11-23T23:30:00Z"]) + "\n" + tres });
  is("1442: an old comment edited into a withdrawal after a newer READY takes it out", !r.ok && /2 READY/.test(r.out), r.out);
  r = verify(id, { FAKE_COMMENTS: dois + comentario(`Claude 2 Q review #1442 @${h}: READY`, "2026-11-23T11:00:00Z") + comentario(`Claude 2 Q review #1442 @${h}: CHANGES`, "2026-11-23T11:00:00Z") });
  is("1442: a READY and a CHANGES of the family in the same second: the CHANGES wins", !r.ok && /2 READY/.test(r.out), r.out);
  // MEDIUM 2 of hed9 on 0cebe29a68 and LEVE 1 on c615434258: a written withdrawal takes the family's READY out.
  for (const linha of [`WITHDRAWN: my READY 7111050238 on #1442 @${h} — Claude 3 Q`, `Claude 3 Q: I withdraw my approval of #1442 @${h}`,
    `Correction to my READY on #1442 @${h} — Claude 3 Q`, `Claude 3 Q: my READY on #1442 @${h} is withdrawn (a test I did not run)`]) {
    r = verify(id, { FAKE_COMMENTS: tres + comentario(linha) });
    is(`1442: a written withdrawal takes the READY out: "${linha.slice(0, 50)}"`, !r.ok && /2 READY/.test(r.out), r.out);
  }
  // LEVE 3 of Claude 5 iYnra on ca80774537: each guard has a check that fails without it.
  r = verify(id, { FAKE_COMMENTS: [ready("Claude 2 Q"), comentario(`Claude 2 Q review #1442 @${h}: CHANGES`, "2026-11-23T07:00:00Z")].join("") + dois });
  is("1442: the time order is used, not the order the comments arrive in (an earlier CHANGES listed after a READY)", r.ok, r.out);
  r = verify(id, { FAKE_COMMENTS: dois + JSON.stringify([`Claude 4 X review #1442 @${h}: READY`, "NONE", "2026-11-23T12:00:00Z"]) + "\n" });
  is("1442: a comment of someone who does not work in the repository never counts", !r.ok && /2 READY/.test(r.out), r.out);
  r = verify(id, { FAKE_COMMENTS: dois + comentario(`Claude 1 coord status review #1442 @${h}: READY`).replace("Claude 1 coord", "Claude 4 coord") });
  is("1442: a strict-looking line whose label has a status word does not count", !r.ok && /2 READY/.test(r.out), r.out);
  r = run(["claim-enqueue", "--as", "Claude 7 X"], { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01Hfzoz3uVKpUo5Wosq4VYjL", ...mq, FAKE_COMMENTS: tres });
  is("1442: the claim message no longer offers record-review as a way to make a review count (L4qm's LEVE)", !/record-review/.test(r.out), r.out);
  // MEDIUM of Claude 3 on ab697952b5 (#5313 @ad11d680df): a queue request's withdrawal is no withdrawn READY.
  r = verify(id, { FAKE_COMMENTS: tres + comentario(`Queue request withdrawn: #1442 @${h} — Claude 2 Q, 19:13 UTC. The 3 READY stay valid on this head.`) });
  is("1442: 'Queue request withdrawn: #N @head — <family>' keeps that family's READY (Claude 3 on #5408 @ab697952b5)", r.ok, r.out);
  r = verify(id, { FAKE_COMMENTS: tres + comentario(`Claude 2 Q review #1442 @${h}: CHANGES, 1 LEVE`) });
  is("1442: the refusal names the comment that took a READY out", !r.ok && /saiu por um comentário posterior/.test(r.out) && /claude-2: "Claude 2 Q review #1442/.test(r.out), r.out);
  r = verify(id, { FAKE_COMMENTS: tres + comentario(`Withdrawn in favor of #5410.`) + comentario(`O PR retira a trava antiga do tax gate.`) });
  is("1442: a withdrawal that names no family is ignored, never NOT CHECKED (MÉDIO 2 of hed9)", r.ok, r.out);
  r = verify(id, { FAKE_COMMENTS: tres, FAKE_REVIEWS: JSON.stringify(["", "COLLABORATOR", "2026-11-23T23:00:00Z", "CHANGES_REQUESTED", "2026-11-23T23:00:00Z", "0000000aaa0000000000000000000000000000aa"]) + "\n" });
  is("1442: a CHANGES_REQUESTED review of an older head (commit_id) leaves this head checked (MÉDIO 2 of hed9)", r.ok, r.out);
  r = verify(id, { FAKE_COMMENTS: tres, CORREIO_SEM_GH: "1" });
  is("1442: without the PR's texts the gate is NOT CHECKED, never '0 READY' (NIT 2 of iYnra)", !r.ok && /NÃO FORAM CONFERIDAS/.test(r.out), r.out);
  // LEVE 1 of iYnra: the enqueuer is outside the head's reviewers (FQ (1)).
  r = verify(id, { FAKE_COMMENTS: tres + ready("Claude 6 Q") });
  is("1442: an enqueuer whose family reviewed the head is refused (FQ (1))", !r.ok && /revisou #1442/.test(r.out), r.out);
  r = run(["complete-enqueue", "--as", "Claude 6 X", id, "--result", "enqueued", "--text", "t"], { ...as("c6"), ...mq, FAKE_COMMENTS: tres });
  is("1442: three READY from three outside families on the head: complete-enqueue records it", r.ok, r.out);

  // MEDIUM of Claude 5 id8Ws on #5408 @dcee6a68d5: on a branch with a family prefix the author is that family; a
  // reviewer of another family who files the queue request keeps its READY (live case: #5405).
  const g3 = (args) => g(args, P);
  g3(["checkout", "-q", "-B", "claude3/fix-1443", M]); const H3b = commit("f1443.txt", "1443\n", "pr1443");
  g3(["push", "-q", "../prs.git", "HEAD:refs/heads/claude3/fix-1443", "HEAD:refs/pull/1443/head"]);
  const h3 = H3b.slice(0, 10), C7 = { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01Hfzoz3uVKpUo5Wosq4VYjL" };
  r = run(["request-enqueue", "--from", "Claude 5", "--pr", "1443", "--sha", h3, "--text", "fila #1443"], { ...as("c5"), ...mq });
  const id3 = /registrado: (\S+)/.exec(r.out)?.[1];
  is("1443: the request records the PR's prefixed branch", r.ok && /Ramo: claude3\/fix-1443/.test(g(["show", `refs/heads/correio:fila/pedidos/${id3}.md`], MQ)), r.out);
  r = run(["claim-enqueue", "--as", "Claude 7 X"], { ...C7, ...mq });
  is("1443: the request is delivered to a family outside the branch's and the requester's", /pegou/.test(r.out), r.out);
  const c1443 = ["Claude 2 Q", "Claude 3 Q", "Claude 6 Q"].map((q) => ready(q, 1443, h3)).join("");
  r = run(["verify-enqueue", "--as", "Claude 7 X", id3], { ...C7, ...mq, FAKE_COMMENTS: c1443 });
  is("1443: the branch prefix's family's READY does not count", !r.ok && /2 READY/.test(r.out), r.out);
  is("1443: and the refusal names the branch prefix's family as the author", /sem a família claude-3 \(a do prefixo do ramo\)/.test(r.out), r.out);
  r = run(["verify-enqueue", "--as", "Claude 7 X", id3], { ...C7, ...mq, FAKE_COMMENTS: c1443 + ready("Claude 5 Q", 1443, h3) });
  is("1443: on a prefixed branch, the requester's READY counts: three from Claude 2, 5 and 6 pass", r.ok && new RegExp(`enfileire ${H3b}`).test(r.out), r.out);
  run(["complete-enqueue", "--as", "Claude 7 X", id3, "--result", "declined", "--text", "test done"], { ...C7, ...mq });

  // LEVE 3 of iYnra: a family with a commit on the PR does not count, even with a strict READY.
  g3(["checkout", "-q", "-B", "claude3/fix-1447", M]); commit("f1447.txt", "1447\n", "pr1447");
  writeFileSync(join(P, "g1447.txt"), "x\n"); g3(["add", "."]); g3(["-c", "user.name=Claude 7", "-c", "user.email=c@c", "commit", "-q", "-m", "c7 commit\n\nClaude-Session: https://claude.ai/code/session_01Hfzoz3uVKpUo5Wosq4VYjL"]);
  g3(["push", "-q", "../prs.git", "HEAD:refs/heads/claude3/fix-1447", "HEAD:refs/pull/1447/head"]);
  const H7 = g3(["rev-parse", "HEAD"]), h7 = H7.slice(0, 10);
  r = run(["request-enqueue", "--from", "Claude 5", "--pr", "1447", "--sha", h7, "--text", "fila #1447"], { ...as("c5"), ...mq });
  const id7 = /registrado: (\S+)/.exec(r.out)?.[1];
  r = run(["claim-enqueue", "--as", "Claude 4 X"], { ...as("c4"), ...mq });
  r = run(["verify-enqueue", "--as", "Claude 4 X", id7], { ...as("c4"), ...mq, FAKE_COMMENTS: ["Claude 1 Q", "Claude 2 Q", "Claude 7 Q"].map((q) => ready(q, 1447, h7)).join("") });
  is("1447: a strict READY of a family with a commit on the PR does not count", !r.ok && /2 READY/.test(r.out), r.out);
  run(["complete-enqueue", "--as", "Claude 4 X", id7, "--result", "declined", "--text", "test done"], { ...as("c4"), ...mq });

  // MEDIUM 2 of Claude 5 hed9 on #5408: a commit of an unknown family (a "Claude" author with no trailer) is NOT CHECKED.
  g3(["checkout", "-q", "-B", "claude3/fix-1444", M]);
  writeFileSync(join(P, "f1444.txt"), "1444\n"); g3(["add", "."]); g3(["-c", "user.name=Claude", "-c", "user.email=c@c", "commit", "-q", "-m", "pr1444 no trailer"]);
  g3(["push", "-q", "../prs.git", "HEAD:refs/heads/claude3/fix-1444", "HEAD:refs/pull/1444/head"]);
  const H4 = g3(["rev-parse", "HEAD"]), h4 = H4.slice(0, 10);
  r = run(["request-enqueue", "--from", "Claude 5", "--pr", "1444", "--sha", h4, "--text", "fila #1444"], { ...as("c5"), ...mq });
  const id4 = /registrado: (\S+)/.exec(r.out)?.[1];
  r = run(["claim-enqueue", "--as", "Claude 7 X"], { ...C7, ...mq });
  const c1444 = ["Claude 1 Q", "Claude 2 Q", "Claude 6 Q"].map((q) => ready(q, 1444, h4)).join("");
  r = run(["verify-enqueue", "--as", "Claude 7 X", id4], { ...C7, ...mq, FAKE_COMMENTS: c1444 });
  is("1444: a commit of an unknown family makes the 3 READY NOT CHECKED, and nothing is enqueued", !r.ok && /NÃO FORAM CONFERIDAS/.test(r.out) && /família desconhecida/.test(r.out), r.out);
  run(["complete-enqueue", "--as", "Claude 7 X", id4, "--result", "declined", "--text", "test done"], { ...C7, ...mq });

  // MEDIUM 3 of Claude 5 hed9 on #5408 @c615434258: a merge of main made without a trailer is an unknown family, even
  // when its tree is git's own merge (CO (e): "nem de junção do main"); whether a pure merge stops blocking is the
  // coordinator's decision, to be written in CO (e).
  g3(["checkout", "-q", "-B", "side-1445", M]); commit("s1445.txt", "side\n", "side");
  g3(["checkout", "-q", "-B", "claude3/fix-1445", M]); commit("f1445.txt", "1445\n", "pr1445");
  g3(["-c", "user.name=Claude", "-c", "user.email=c@c", "merge", "-q", "--no-edit", "side-1445"]);
  g3(["push", "-q", "../prs.git", "HEAD:refs/heads/claude3/fix-1445", "HEAD:refs/pull/1445/head"]);
  const H5 = g3(["rev-parse", "HEAD"]), h5 = H5.slice(0, 10);
  r = run(["request-enqueue", "--from", "Claude 5", "--pr", "1445", "--sha", h5, "--text", "fila #1445"], { ...as("c5"), ...mq });
  const id5 = /registrado: (\S+)/.exec(r.out)?.[1];
  r = run(["claim-enqueue", "--as", "Claude 7 X"], { ...C7, ...mq });
  const c1445 = ["Claude 1 Q", "Claude 2 Q", "Claude 6 Q"].map((q) => ready(q, 1445, h5)).join("");
  r = run(["verify-enqueue", "--as", "Claude 7 X", id5], { ...C7, ...mq, FAKE_COMMENTS: c1445 });
  is("1445: a trailerless merge, even git's own, leaves the 3 READY NOT CHECKED (CO (e))", !r.ok && /NÃO FORAM CONFERIDAS/.test(r.out) && /família desconhecida/.test(r.out), r.out);
}

console.log(`\n${total} checks, ${falhas ? `${falhas} failing` : "all passing"}.`);
process.exitCode = falhas ? 1 : 0;
