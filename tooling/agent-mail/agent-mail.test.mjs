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
const SES = { c4: "cse_01S9eVA3KcXUkc6qPJmpNg4a", c5: "cse_012ST5iZUmuf9ob1UKKczQnH", c6: "cse_018ZjhHhUoHAGLUkhRVBUuAW", c2: "cse_01FR6Z1Q87JZvTFBRpZ8SNo8" };

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
  nohead) echo '["https://github.com/solrenning-llc/marktmorgen/pull/'"$FAKE_PR"'#issuecomment-1","READY, no head here",""]' ;;
  *) echo '["https://github.com/solrenning-llc/marktmorgen/pull/'"$FAKE_PR"'#issuecomment-1","Review @'"$FAKE_SHA"' READY",""]' ;;
esac
`); chmodSync(join(BIN, "gh"), 0o755);

const base = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", CORREIO_REPO: join(T, "mail.git"), CORREIO_PR_REPO: join(T, "prs.git"), CORREIO_SEM_VERSAO: "1", PATH: `${BIN}:${process.env.PATH}` };
delete base.CLAUDE_CODE_REMOTE_SESSION_ID;
// Both outputs are read: warnings go to stderr even when the command succeeds.
const run = (args, env = {}) => {
  const r = spawnSync("node", [TOOL, ...args], { cwd: join(T, "w"), env: { ...base, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
is("only the coordinator turns a switch on: Claude 6 is refused", !r.ok && /só o coordenador/.test(r.out), r.out);
r = run(["set-switch", "--as", "Claude 5 X", "--name", "record-review", "--on", "--reason", "t"]);
is("an unidentified session cannot turn it on, even named Claude 5", !r.ok && /só o coordenador/.test(r.out), r.out);
r = run(["set-switch", "--as", "Claude 5 X", "--name", "record-review", "--on", "--reason", "t"], as("c6"));
is("a Claude 6 session cannot turn it on under Claude 5's name", !r.ok && /identidade|só o coordenador/.test(r.out), r.out);
raw(`chaves/record-review/${Date.now()}-claude-5-x-ab12`, "ON\nClaude 5 X\nraw\n");
r = rec0();
is("an ON written without the coordinator's session (raw git, old copy) does not turn anything on", !r.ok && /DESLIGADO/.test(r.out), r.out);
is("list-switches says the raw ON was ignored", /record-review: DESLIGADO .*ON IGNORADO/.test(run(["list-switches"]).out), run(["list-switches"]).out);
r = run(["set-switch", "--as", "Claude 5 X", "--name", "record-review", "--on", "--reason", "teste"], as("c5"));
is("the coordinator turns it on", r.ok && /LIGADO/.test(r.out), r.out);
r = run(["set-switch", "--as", "Claude 5 X", "--name", "record-review", "--on"], as("c5"));
is("a reason is required", !r.ok && /--reason/.test(r.out), r.out);
is("list-switches shows it on and who", /record-review: LIGADO \(por Claude 5 X/.test(run(["list-switches"]).out));

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
is("only the coordinator confirms a record", !r.ok && /só o coordenador/.test(r.out), r.out);
r = run(["confirm-review-record", "--as", "Claude 5 X", id7, "--reason", "conferido no PR"], as("c5"));
is("the coordinator confirms it", r.ok, r.out);
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
run(["request-enqueue", "--from", "Claude 2", "--pr", "4", "--sha", H4c.slice(0, 10), "--text", "fila #4 c"], { ...as("c2"), CORREIO_SEM_COMMITS: "" });
g(["push", "-q", "../prs.git", "HEAD:refs/heads/feature-4"], P);
// the request recorded no branch (H4c was not pushed yet), so only the local refs/pull/4/head (still H4a) is read: declined, authoritative locally
r = run(["claim-enqueue", "--as", "Claude 6 X"], as("c6"));
is("without a recorded branch, a local repository's refs/pull is authoritative and a different head is declined", /mudou de/.test(r.out), r.out);
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
const id7a = /registrado: (\S+)/.exec(r.out)?.[1];
is("no branch is recorded for an old head held only by a backup branch", r.ok && !/^Ramo:/m.test(g(["show", `refs/heads/correio:fila/pedidos/${id7a}.md`], join(T, "mail.git")).split(/\n\s*\n/)[0]), r.out);
r = run(["claim-enqueue", "--as", "Claude 6 X"], as("c6"));
is("a 'Ramo:' line in the free text is ignored, and the old head is declined", /mudou de/.test(r.out) && new RegExp(H7b.slice(0, 10)).test(r.out), r.out);

console.log("switch off returns to the old behaviour (R1)");
r = run(["set-switch", "--as", "Claude 2 X", "--name", "record-review", "--off", "--reason", "parar"], as("c2"));
is("any session can turn a switch off", r.ok && /DESLIGADO/.test(r.out), r.out);
r = rec("Claude 4 X", 2, H2, { ...as("c4"), FAKE_GH: "ok", FAKE_PR: "2", FAKE_SHA: H2.slice(0, 10) });
is("with the switch off, record-review is refused", !r.ok && /DESLIGADO/.test(r.out), r.out);
is("with the switch off, no record takes anyone out of the queue", !/tira a família/.test(run(["list-review-records", "--pr", "2"]).out));

console.log("concurrency and order");
run(["set-switch", "--as", "Claude 5 X", "--name", "record-review", "--on", "--reason", "de novo"], as("c5"));
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

run(["request-enqueue", "--from", "Claude 2", "--pr", "6", "--sha", H6b.slice(0, 10), "--text", "fila #6"], ghEnv("c2"));
r = run(["claim-enqueue", "--as", "Claude 6 X"], ghEnv("c6"));
is("not delivered and not declined: 'não conferível agora'", /não conferível agora/.test(r.out) && !/pegou|recusado/.test(r.out), r.out);
is("the request stays first and open, with no take", /#6 @\S+ +autor Claude 2 +aberto/.test(run(["list-queue"]).out), run(["list-queue"]).out);
g(["push", "-q", GH, `${H6b}:refs/pull/6/head`], P);
r = run(["claim-enqueue", "--as", "Claude 6 X"], ghEnv("c6"));
is("once refs/pull/N/head catches up, it is delivered, the head still NOT CHECKED by branch", /pegou/.test(r.out) && /NÃO CONFERIDO/.test(r.out), r.out);

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
r = run(["list-switches"], { CORREIO_SEM_VERSAO: "", CORREIO_PR_REPO: join(T, "nao-existe.git") });
is("main unreachable: the version is reported as NOT CHECKED", /NÃO FOI CONFERIDA/.test(r.out), r.out);
// file:// behaves like a real remote (a plain path would ignore --depth), as the reviewer reproduced on GitHub.
// The version check must never fetch with --depth: a shallow fetch makes the user's repository shallow (review of
// Claude 1 A on #5044, reproduced on GitHub). GIT_TRACE records every git command the tool runs.
comHash(meu);
const trace = join(T, "git-trace.txt");
spawnSync("node", [TOOL, "list-switches"], { cwd: join(T, "w"), env: { ...base, CORREIO_SEM_VERSAO: "", GIT_TRACE: trace }, encoding: "utf8" });
const linhas = readFileSync(trace, "utf8").split("\n").filter((l) => /git(\.c:\d+)?\s.*trace: (built-in|exec): git fetch/.test(l) || /trace: built-in: git fetch/.test(l));
is("the version check runs a fetch (so the next check means something)", linhas.length > 0, readFileSync(trace, "utf8").slice(0, 600));
is("no git fetch of the tool uses --depth (review of Claude 1 A)", !linhas.some((l) => /--depth/.test(l)), linhas.filter((l) => /--depth/.test(l)).join("\n").slice(0, 600));

console.log(`\n${total} checks, ${falhas ? `${falhas} failing` : "all passing"}.`);
process.exitCode = falhas ? 1 : 0;
