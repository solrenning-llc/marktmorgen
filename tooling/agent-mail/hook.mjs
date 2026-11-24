#!/usr/bin/env node
// Claude Code hook that puts the agents' mail in front of every Claude session of this repository (owner, 24/11/2026:
// "PRATICAMENTE NAO FUNCIONA ESSE CORREIO!!!!!!!!!!!! NINGUEM ESCUTA NINGUEM!!!!!!!!!!."; "FAÇA").
//
// Reading the mail depended on each session remembering to keep `watch` running and to start it again every two
// minutes. A message sent to everyone on 24/11/2026 at 04:27 UTC was, twenty minutes later, unread by every session of
// Claude 2, Claude 4 and Claude 7, though they were writing to the mail. This hook needs no memory: Claude Code runs it
// itself (.claude/settings.json).
//
//   node tooling/agent-mail/hook.mjs start   # SessionStart: the messages of the last hours for this session
//   node tooling/agent-mail/hook.mjs check   # PostToolUse: at most once a minute, the messages that arrived since
//
// It only reads. It never writes to the mail, never confirms (ack) a message, never claims, enqueues or changes code:
// the agent still reads in full with `read` and confirms with `ack` (AGENTS.md, CO (b)). It keeps its own copy of the
// private mail in ~/.agent-mail/hook.git, outside any clone, as the tool does (A14), and never blocks a session: every
// failure ends with exit code 0, said once at the start of a session and silent during work.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const REPO = process.env.CORREIO_REPO || "https://github.com/solrenning-llc/repo-id-transfer-test";
export const RAMO = process.env.CORREIO_RAMO || "correio";
/** Where the hook keeps its copy of the mail and its state: the tool's own folder by default. */
export const PASTA = process.env.AGENT_MAIL_HOOK_DIR || join(homedir(), ".agent-mail");
/** At most one look at the mail a minute while the agent works. */
export const INTERVALO_MS = 60_000;
/** At the start of a session, the messages of the last hours. */
export const JANELA_INICIO_H = 6;
/** During work, a message is new for this many hours after it was sent. */
export const JANELA_NOVAS_H = 24;
/** At most this many messages shown at a time, each at most this many characters. */
export const MAX_MENSAGENS = 8;
export const MAX_CARACTERES = 700;
/** Each git command is stopped after this long: a slow network never holds a session. */
export const PRAZO_GIT_MS = 20_000;

/** Test clock: only with AGENT_MAIL_TEST=1 and a local mail repository, never against the real mail. */
export function agora(env = process.env) {
  const local = !/^[a-z]+:\/\//i.test(String(env.CORREIO_REPO ?? "https://"));
  const n = Number(env.AGENT_MAIL_HOOK_NOW);
  return env.AGENT_MAIL_TEST === "1" && local && Number.isFinite(n) && n > 0 ? n : Date.now();
}

/** A text with no credential in it (the tool's semSegredo, kept the same here so an error never prints a token). */
export function semSegredo(texto) {
  return String(texto ?? "")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, "$1***@")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, "***")
    .replace(/(authorization:\s*(?:(?:basic|bearer|token)\s+)?)[^\s'";]+/gi, "$1***");
}

/**
 * Who this session is: its family from the session id's account prefix (the tool's SESSOES), and the id itself, where
 * every session name of the mail comes from. A name starts at the 7th or 8th character of the id: "Claude 5 iZUmuf" is
 * session 012ST5iZUmuf..., "Claude 6 jAAv7" is 018ZjhHjAAv7.... Outside the cloud (Claude 1 on the owner's computer)
 * AGENT_MAIL_AS names the family; without either, only "todos" is read.
 */
export function quemSou(sessoes, env = process.env) {
  const m = /^(?:cse_|session_)?([0-9A-Za-z]{20,40})$/.exec(String(env.CLAUDE_CODE_REMOTE_SESSION_ID ?? "").trim());
  if (m) return { chave: m[1], familia: sessoes[m[1].slice(0, 7)] ?? null, id: m[1].toLowerCase() };
  const as = /^(claude-[0-9]+|codex)\b/.exec(String(env.AGENT_MAIL_AS ?? "").trim().toLowerCase().replace(/\s+/g, "-"));
  return { chave: "local", familia: as ? as[1] : null, id: "" };
}

/** Whether a session name ("izumuf") is this session's: 3 characters or more, at the 7th or 8th character of its id. */
export function nomeDaSessao(nome, id) {
  const n = String(nome).toLowerCase().replace(/-/g, "");
  return n.length >= 3 && Boolean(id) && (id.startsWith(n, 6) || id.startsWith(n, 7));
}

/**
 * The boxes this session reads: everyone's, its family's, and its own session boxes ("<family>-<name>", with the name
 * as nomeDaSessao reads it). A sister session's box is not read (the tool's rule, naoLidas).
 */
export function caixasDe(eu, caixas) {
  const minhas = new Set(["todos"]);
  if (!eu.familia) return minhas;
  minhas.add(eu.familia);
  for (const c of caixas) {
    if (c.startsWith(`${eu.familia}-`) && nomeDaSessao(c.slice(eu.familia.length + 1), eu.id)) minhas.add(c);
  }
  return minhas;
}

/** Whether a message id ("<date>Z-<sender>-<4 hex>") was sent by this very session. */
export function minha(id, eu) {
  const remetente = String(id).replace(/^\d{8}T\d{6}Z-/, "").replace(/-[0-9a-f]{4}$/, "");
  return Boolean(eu.familia) && remetente.startsWith(`${eu.familia}-`) && nomeDaSessao(remetente.slice(eu.familia.length + 1), eu.id);
}

/** A message dated more than this far ahead is not shown: its date was written by its sender (the tool's rule, CO (e)). */
export const FUTURO_MS = 5 * 60_000;

export function dataDe(id) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(id);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

function git(args) {
  return execFileSync("git", ["--git-dir", join(PASTA, "hook.git"), ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: PRAZO_GIT_MS, killSignal: "SIGKILL", maxBuffer: 64 << 20,
  }).trim();
}

/** Fetches the mail into the hook's own repository (created the first time) and returns the commit, or null. */
export function buscar() {
  const dir = join(PASTA, "hook.git");
  if (!existsSync(join(dir, "HEAD"))) {
    mkdirSync(PASTA, { recursive: true, mode: 0o700 });
    execFileSync("git", ["init", "-q", "--bare", dir], { stdio: ["ignore", "pipe", "pipe"], timeout: PRAZO_GIT_MS });
    for (const chave of ["gc.autoDetach", "maintenance.autoDetach"]) git(["config", chave, "false"]);
  }
  // A ref of its own for each run, deleted after: two hooks at once never fight over one ref.
  const ref = `refs/hook/${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    git(["fetch", "-q", "--no-tags", "--no-write-fetch-head", REPO, `+refs/heads/${RAMO}:${ref}`]);
    return git(["rev-parse", ref]);
  } finally {
    try { git(["update-ref", "-d", ref]); } catch { /* not created */ }
  }
}

/** The messages of the boxes this session reads, newest last: id, box, path. */
export function mensagens(commit, eu) {
  const todasCaixas = git(["ls-tree", "--name-only", commit, "caixas/"]).split("\n").filter(Boolean).map((c) => c.replace(/^caixas\//, ""));
  const minhas = caixasDe(eu, todasCaixas);
  const caminhos = git(["ls-tree", "-r", "--name-only", commit, "--", ...[...minhas].map((c) => `caixas/${c}`)]).split("\n").filter((c) => c.endsWith(".md"));
  // The same message sent to several of these boxes is one message (one id).
  const porId = new Map();
  for (const caminho of caminhos) {
    const id = caminho.split("/").pop().replace(/\.md$/, "");
    if (!porId.has(id) && !minha(id, eu)) porId.set(id, caminho);
  }
  return [...porId].map(([id, caminho]) => ({ id, caminho, quando: dataDe(id) })).filter((m) => m.quando !== null).sort((a, b) => a.id.localeCompare(b.id));
}

/** One message in a few lines: sender, subject and the start of its text. */
export function resumo(commit, m) {
  const texto = git(["show", `${commit}:${m.caminho}`]);
  const cabecalho = texto.split(/\n\s*\n/, 1)[0];
  const campo = (nome) => (new RegExp(`^${nome}:\\s*(.*)$`, "m").exec(cabecalho)?.[1] ?? "").trim();
  const corpo = texto.slice(cabecalho.length).replace(/\n?Sessão:.*$/m, "").trim().replace(/\s+/g, " ");
  const linha = `- ${m.id} (caixa ${m.caminho.split("/")[1]}) De: ${campo("De")} | Assunto: ${campo("Assunto")}\n  ${corpo}`;
  return linha.length > MAX_CARACTERES ? `${linha.slice(0, MAX_CARACTERES - 1)}…` : linha;
}

const arquivoEstado = (eu) => join(PASTA, `hook-state-${eu.chave.replace(/[^0-9A-Za-z]/g, "")}.json`);
function lerEstado(eu) {
  try { const e = JSON.parse(readFileSync(arquivoEstado(eu), "utf8")); return { ultima: Number(e.ultima) || 0, vistos: Array.isArray(e.vistos) ? e.vistos : [] }; }
  catch { return { ultima: 0, vistos: [] }; }
}
function gravarEstado(eu, estado) {
  mkdirSync(PASTA, { recursive: true, mode: 0o700 });
  const tmp = `${arquivoEstado(eu)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(estado));
  renameSync(tmp, arquivoEstado(eu));
}

const comoLer = (eu) => {
  const nome = eu.familia ? eu.familia.replace(/^claude-/, "Claude ").replace(/^codex$/, "Codex") : "Claude N";
  return `Leia por inteiro e aplique com: node ~/.agent-mail/agent-mail.mjs read --as "${nome} <sua sessão>"; confirme com ack. ` +
    "Sem a ferramenta instalada, instale antes com o comando de CO (b) do AGENTS.md. Este aviso vem do gancho do correio (tooling/agent-mail/hook.mjs), que só lê.";
};

/** The text to put in front of the agent, or "" when there is nothing to say. */
export async function rodar(modo, env = process.env) {
  const { SESSOES } = await import("./agent-mail.mjs");
  const eu = quemSou(SESSOES, env);
  const agoraMs = agora(env);
  const estado = lerEstado(eu);
  if (modo === "check" && agoraMs - estado.ultima < INTERVALO_MS) return "";
  // The time is written before the network: hooks that run together in one session do not all fetch.
  gravarEstado(eu, { ...estado, ultima: agoraMs });
  let commit;
  try {
    commit = buscar();
  } catch (erro) {
    return modo === "start" ? `CORREIO DOS AGENTES: não consegui ler o correio agora (${semSegredo(erro?.message ?? erro).split("\n")[0].slice(0, 200)}). ${comoLer(eu)}` : "";
  }
  if (!commit) return "";
  const todas = mensagens(commit, eu);
  const desde = agoraMs - (modo === "start" ? JANELA_INICIO_H : JANELA_NOVAS_H) * 3_600_000;
  const vistos = new Set(estado.vistos);
  const recentes = todas.filter((m) => m.quando >= desde && m.quando <= agoraMs + FUTURO_MS);
  const novas = modo === "start" ? recentes : recentes.filter((m) => !vistos.has(m.id));
  // Everything of the last day shown or present at the start counts as seen, so a minute later only what is new appears.
  const janela = agoraMs - JANELA_NOVAS_H * 3_600_000;
  const vistosDepois = [...new Set([...estado.vistos.filter((id) => (dataDe(id) ?? 0) >= janela), ...todas.filter((m) => m.quando >= janela).map((m) => m.id)])];
  gravarEstado(eu, { ultima: agoraMs, vistos: vistosDepois });
  if (!novas.length) return modo === "start" ? `CORREIO DOS AGENTES: nenhuma mensagem nas últimas ${JANELA_INICIO_H} horas nas caixas desta sessão (${[...caixasDe(eu, [])].join(", ")} e as da sessão). ${comoLer(eu)}` : "";
  const mostradas = novas.slice(-MAX_MENSAGENS);
  const cabeca = modo === "start"
    ? `CORREIO DOS AGENTES: ${novas.length} mensagem(ns) nas últimas ${JANELA_INICIO_H} horas para esta sessão (todos, a família e a própria caixa)${novas.length > mostradas.length ? `; as ${mostradas.length} mais novas` : ""}:`
    : `CORREIO DOS AGENTES: ${novas.length} mensagem(ns) nova(s) para esta sessão${novas.length > mostradas.length ? `; as ${mostradas.length} mais novas` : ""}:`;
  return [cabeca, ...mostradas.map((m) => resumo(commit, m)), comoLer(eu)].join("\n");
}

export async function principal(argv = process.argv.slice(2), env = process.env) {
  const modo = argv[0] === "start" ? "start" : "check";
  let texto = "";
  try { texto = await rodar(modo, env); } catch (erro) {
    texto = modo === "start" ? `CORREIO DOS AGENTES: o gancho falhou (${semSegredo(erro?.message ?? erro).split("\n")[0].slice(0, 200)}). Rode read à mão.` : "";
  }
  if (texto) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: modo === "start" ? "SessionStart" : "PostToolUse", additionalContext: texto } })}\n`);
  }
  process.exitCode = 0;
}

if (process.argv[1] && /(?:^|[/\\])hook\.mjs$/.test(process.argv[1])) void principal();
