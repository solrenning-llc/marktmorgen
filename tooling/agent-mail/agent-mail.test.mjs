#!/usr/bin/env node
// Tests for agent-mail.mjs (owner, OWNER-20261121-1749-QUEUE-IMPROVEMENTS-AUTH, R5): local throwaway git repositories and
// a fake `gh`, never the real mailbox or GitHub. Run: node agent-mail.test.mjs [path/to/agent-mail.mjs]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
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
  req) printf '%s\\n' '["https://github.com/solrenning-llc/marktmorgen/issues/'"\${FAKE_ISSUE:-4932}"'#issuecomment-'"$FAKE_ID"'","'"$FAKE_BODY"'","'"\${FAKE_CREATED:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"'"]' ;;
  nohead) echo '["https://github.com/solrenning-llc/marktmorgen/pull/'"$FAKE_PR"'#issuecomment-1","READY, no head here",""]' ;;
  *) echo '["https://github.com/solrenning-llc/marktmorgen/pull/'"$FAKE_PR"'#issuecomment-1","Review @'"$FAKE_SHA"' READY",""]' ;;
esac
`); chmodSync(join(BIN, "gh"), 0o755);

const base = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", CORREIO_REPO: join(T, "mail.git"), CORREIO_PR_REPO: join(T, "prs.git"), CORREIO_SEM_VERSAO: "1", PATH: `${BIN}:${process.env.PATH}` };
delete base.CLAUDE_CODE_REMOTE_SESSION_ID;
// Both outputs are read: warnings go to stderr even when the command succeeds.
const run = (args, env = {}, cwd = join(T, "w")) => {
  const r = spawnSync("node", [TOOL, ...args], { cwd, env: { ...base, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const as = (k) => ({ CLAUDE_CODE_REMOTE_SESSION_ID: SES[k] });
let falhas = 0, total = 0;
const is = (nome, cond, extra = "") => { total++; if (!cond) falhas++; console.log(`${cond ? "  ok  " : "  FAIL"}  ${nome}${!cond && extra ? `\n        ${String(extra).slice(0, 400).replace(/\n/g, "\n        ")}` : ""}`); };
// Writes a file straight into the mailbox with git, as an old or edited copy of the tool could (review of Claude 2 upbeat).
const raw = (path, text) => {
  const c = join(T, `raw-${Math.random().toString(16).slice(2)}`);
  g(["clone", "-q", "-b", "correio", join(T, "mail.git"), c]);
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
is("a request comment that is not on #4932 is refused", !r.ok && /não é da #4932/.test(r.out), r.out);
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
is("nothing was turned on by the refused attempts", /record-review: DESLIGADO/.test(run(["list-switches"]).out), run(["list-switches"]).out);
r = ligar("Claude 1 A", "c1a", pedidoDe(marca("set-switch", "ready-check")), [], "ready-check");
is("with no sign from the named session in 60 minutes, the backup acts, and the record says why", r.ok && /ready-check: LIGADO/.test(run(["list-switches"]).out), r.out);
run(["set-switch", "--as", "Claude 2 X", "--name", "ready-check", "--off", "--reason", "fim do teste"], as("c2"));
const q1 = pedidoDe(`Coordinator decision.\\n${marca("set-switch", "record-review")}`);
r = ligar("Claude 5 ibqho", "ibq", q1);
is("the named session turns it on, on the coordinator's request", r.ok && /LIGADO/.test(r.out), r.out);
r = run(["read", "--as", "Claude 2 Z"], as("c2"));
is("the privileged action is announced to all in the same minute, with the request and its identifier", /interruptor record-review LIGADO/.test(r.out) && new RegExp(`issuecomment-${q1.id}`).test(r.out) && /C1-20261121-2100-TEST/.test(r.out), r.out);
r = ligar("Claude 5 ibqho", "ibq", q1);
is("a request is used once only", !r.ok && /já foi usado/.test(r.out), r.out);
// A shallow clone whose history does not reach the named session's last write: no sign is NOT CHECKED (review of Claude 4 3Kc).
run(["send", "--from", "Claude 2 Z", "--to", "Claude 3 Z", "--subject", "s", "--text", "a"], as("c2"));
const W2 = join(T, "w2"); g(["init", "-q", W2]); g(["fetch", "-q", "--depth", "1", `file://${join(T, "mail.git")}`, "+refs/heads/correio:refs/x"], W2);
run(["send", "--from", "Claude 2 Z", "--to", "Claude 3 Z", "--subject", "s", "--text", "b"], as("c2"));
r = run(["set-switch", "--as", "Claude 1 A", "--name", "record-review", "--on", "--reason", "t", ...pedidoDe(marca("set-switch", "record-review")).args], { ...as("c1a"), ...pedidoDe(marca("set-switch", "record-review")).env, FAKE_ID: String(nReq - 1) }, W2);
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
r = run(["set-switch", "--as", "Claude 1 A", "--name", "record-review", "--on", "--reason", "t", ...qw3.args], { ...as("c1a"), ...qw3.env }, W3);
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
const idf = /pegou: (\S+)/.exec(r.out)?.[1];
run(["complete-enqueue", "--as", "Claude 6 X", idf, "--result", "enqueued", "--text", "t"], as("c6"));

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
run(["complete-enqueue", "--as", "Claude 6 X", idb ?? "x", "--result", "enqueued", "--text", "t"], as("c6"));
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
run(["complete-enqueue", "--as", "Claude 6 X", /pegou: (\S+)/.exec(r.out)?.[1] ?? "x", "--result", "enqueued", "--text", "t"], as("c6"));
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
  const valido = ons[ons.length - 1].t;
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
  r = run(["verify-enqueue", "--as", "Claude 6 X", id17], { ...as("c6"), ...m4 });
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
  r = run(["complete-enqueue", "--as", "Claude 6 X", id17b, "--result", "enqueued", "--text", "fila #17 b"], { ...as("c6"), ...m4 });
  is("the completion records the head that was enqueued", r.ok && new RegExp(`^Head enfileirado: ${H17b}$`, "m").test(g(["show", `refs/heads/correio:fila/feitas/${id17b}.md`], join(T, "mail4.git"))), r.out);
  // A git command that hangs is stopped by the time limit.
  const mod = await import(TOOL);
  let erro = "";
  try { mod.git(["-c", "alias.dorme=!sleep 5", "dorme"], undefined, 500); } catch (e) { erro = String(e.message ?? e); }
  is("a git command past its time limit is stopped, with a clear error", /limite de tempo|ETIMEDOUT/.test(erro), erro);
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

console.log(`\n${total} checks, ${falhas ? `${falhas} failing` : "all passing"}.`);
process.exitCode = falhas ? 1 : 0;
