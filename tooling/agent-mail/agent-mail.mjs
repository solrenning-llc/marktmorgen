#!/usr/bin/env node
// Correio dos agentes (dono, 21/11/2026): uma caixa postal por agente, num ramo git que não lota e guarda tudo.
//
// Cada mensagem é um arquivo na caixa do destinatário (caixas/<agente>/<id>.md), ou em caixas/todos/ para todos.
// Um arquivo por mensagem: dois agentes enviando ao mesmo tempo nunca entram em conflito, e nada é apagado nem
// reescrito (o envio recusa qualquer mudança que não seja acrescentar arquivos). A leitura se confirma com um arquivo em
// lidas/<agente>/<id>. Enquanto houver mensagem sem confirmar, `vigiar` acorda o agente: a cobrança é automática.
//
// Uso (de qualquer clone git; não muda o ramo de trabalho nem os arquivos do clone):
//   node agent-mail.mjs send --from "Claude 6" --to "Claude 5,Claude 1" --subject "Título" --text "Mensagem"
//   node agent-mail.mjs send --from "Claude 6" --to all --subject "Título" --file mensagem.md
//   node agent-mail.mjs read --as "Claude 6"                 # mostra as não lidas (da própria caixa e de todos)
//   node agent-mail.mjs ack --as "Claude 6" <id>...   # ou --all
//   node agent-mail.mjs watch --as "Claude 6"              # confere a cada 30 s; termina ao haver não lida, ou em 2 min
//   node agent-mail.mjs list-pending --from "Claude 6"           # o que você mandou e ainda não foi lido, com a idade
//   node agent-mail.mjs set-quota --as "Claude 3" --exhausted --until 2026-11-23T02:00-03:00 --by "Claude 6 (informado pelo dono)"   # por outra família
//   node agent-mail.mjs request-review ... --exclude "Claude 2,Claude 4"   # a ferramenta já exclui sozinha quem tem commits no PR; --exclude acrescenta
//   node agent-mail.mjs release-review --as "Claude 2" <id> --reason "tenho commits no PR"   # devolve na hora o que pegou
//   node agent-mail.mjs cancel-enqueue --as "Claude 6" <id> --reason "por quê"   # o autor, ou quem pôs HOLD, tira o pedido da fila
//   node agent-mail.mjs request-review --from "Claude 6" --pr 4941 --sha 2e31152be3 --text "o que mudou"
//   node agent-mail.mjs list-reviews                            # pedidos de revisão abertos, na ordem de chegada
//   node agent-mail.mjs claim-review --as "Claude 5"       # o mais antigo de outra família; ninguém pega o mesmo
//   node agent-mail.mjs complete-review --as "Claude 5" <id> --result READY|CHANGES --text "achados ou link"
//   node agent-mail.mjs request-enqueue --from "Claude 6" --pr 4941 --sha 2e31152be3 --text "9/9, READY de..., SIM do dono..."
//   node agent-mail.mjs list-queue                                # a fila, na ordem
//   node agent-mail.mjs claim-enqueue --as "Claude 3"          # só o mais antigo, um de cada vez, de outra família
//   node agent-mail.mjs complete-enqueue --as "Claude 3" <id> --result enqueued|declined --text "motivo"
//   node agent-mail.mjs renew-enqueue --as "Claude 3" <id>   # a tomada da fila vence em 10 min; renove se precisar de mais
//   node agent-mail.mjs watch --as "Claude 3" --also review,enqueue   # acorda também com pedido para você pegar
//   node agent-mail.mjs set-quota --as "Claude 3" --exhausted --until 2026-11-22T01:00-03:00   # ou --available quando a cota voltar
//   node agent-mail.mjs set-quota --as "Claude 3" --remaining 35 --renews 2026-11-29T10:00-03:00   # quanto resta e quando renova
//   node agent-mail.mjs list-quotas                                # quem está com e sem cota, o percentual e o último sinal
//   node agent-mail.mjs claim-pr --as "Claude 3" --pr 4941   # CLAIMED (2 h), da sessão; recusado com HOLD ou CLAIMED de outra sessão
//   node agent-mail.mjs hold-pr --as "Claude 5" --pr 4941 --reason "texto"   # HOLD, até alguém liberar
//   node agent-mail.mjs release-pr --as "Claude 3" --pr 4941   # UNCLAIMED / fim do HOLD (só quem pôs, o autor ou o coordenador)
//   node agent-mail.mjs pr-status --pr 4941                 # quem tem o PR agora
//   (request-review aceita --to "Claude 5": a preferência; sem cota ou depois de 30 min, qualquer outra família pega)
//
// O repositório e o ramo dos dados podem ser trocados por CORREIO_REPO e CORREIO_RAMO (os testes usam um repositório local).
// O código fica em tooling/agent-mail/ do main do Marktmorgen, revisado por PR; instale com o comando de CO (b) do AGENTS.md.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const REPO = process.env.CORREIO_REPO || "https://github.com/solrenning-llc/repo-id-transfer-test";
export const RAMO = process.env.CORREIO_RAMO || "correio";
/** Depois deste tempo sem leitura, a mensagem aparece como atrasada em `pendentes` e em `ler`. */
export const ATRASO_MIN = 30;

/**
 * Um texto sem credenciais, para imprimir (alerta 257 do CodeQL no #5080): quando o git falha, o Node põe a linha de
 * comando inteira no erro, com o endereço do correio, que pode trazer um token (https://usuário:token@...). Tira a parte
 * de usuário e senha de todo endereço, os tokens do GitHub soltos e o valor de um cabeçalho Authorization.
 */
export function semSegredo(texto) {
  return String(texto ?? "")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, "$1***@")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, "***")
    .replace(/(authorization:\s*(?:(?:basic|bearer|token)\s+)?)[^\s'";]+/gi, "$1***");
}

/** Os subcomandos do git que a ferramenta usa: o nome mostrado num erro sai desta lista, nunca dos argumentos. */
const SUBCOMANDOS_GIT = ["cat-file", "commit-tree", "config", "diff", "fetch", "for-each-ref", "grep", "hash-object", "init", "log", "ls-remote",
  "ls-tree", "merge-base", "merge-tree", "push", "read-tree", "rev-list", "rev-parse", "show", "update-index", "update-ref", "write-tree"];
/** Prazo de cada comando do git (passo 4): um comando que trava não segura a ferramenta; vence e falha com o motivo. */
export const GIT_PRAZO_MS = 120000;
export function git(args, input, prazoMs = GIT_PRAZO_MS, dir = null, envExtra = {}) {
  try {
    const env = dir ? { ...process.env, ...envExtra, GIT_DIR: dir } : { ...process.env, ...envExtra };
    return execFileSync("git", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 << 20, timeout: prazoMs, killSignal: "SIGKILL", env }).trim();
  } catch (erro) {
    if (erro?.code === "ETIMEDOUT" || (erro?.signal === "SIGKILL" && !erro?.status)) {
      const e = new Error(`git ${SUBCOMANDOS_GIT.find((c) => c === args?.[0]) ?? "comando"} passou do limite de tempo (${prazoMs / 1000} s) e foi parado; nada foi feito com o resultado`);
      e.status = null; e.stderr = e.message;
      throw e;
    }
    throw erroDoGit(args, erro);
  }
}

/**
 * O erro de um git que falhou, sem a linha de comando (CodeQL 257 no #5080): o erro do Node traz o comando inteiro,
 * com o endereço do correio, que pode ter um token. O erro novo diz só o subcomando, o código de saída e o fim da saída
 * de erro do git (que já mascara credenciais), também passada por semSegredo; status, signal, code, stderr e stdout
 * continuam, para quem confere o resultado.
 */
export function erroDoGit(args, erro) {
  const nome = SUBCOMANDOS_GIT.find((c) => c === args?.[0]) ?? "comando";
  const stderr = semSegredo(typeof erro?.stderr === "string" ? erro.stderr : "");
  const fim = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
  const e = new Error(`git ${nome} falhou${typeof erro?.status === "number" ? ` (código ${erro.status})` : ""}${fim ? `: ${fim}` : ""}`);
  e.status = erro?.status ?? null; e.signal = erro?.signal ?? null; e.code = erro?.code;
  e.stderr = stderr; e.stdout = semSegredo(typeof erro?.stdout === "string" ? erro.stdout : "");
  return e;
}

// Passo 6 (A14): o correio é privado e o marktmorgen é público. Tudo o que é do correio (as buscas, os objetos, os
// commits gravados e a referência do só-acrescentar) fica num repositório git só da ferramenta, fora do clone onde ela
// roda: um push --mirror desse clone nunca leva o correio. As leituras dos PRs (dados públicos) continuam no clone.
export const DIR_CORREIO = process.env.CORREIO_GIT_DIR || join(homedir(), ".agent-mail", "correio.git");
/** A marca antiga do clone, guardada pelo comando que criou o repositório do correio (MÉDIO do Claude 4 3Kc no #5117). */
const ARQUIVO_ANCORA = () => join(DIR_CORREIO, "agent-mail-ancora-do-clone");
let dirPronto = false;
/** O git no repositório do correio, criado na primeira vez. */
export function gitC(args, input) {
  if (!dirPronto) {
    if (!existsSync(join(DIR_CORREIO, "HEAD"))) {
      execFileSync("git", ["init", "-q", "--bare", DIR_CORREIO], { stdio: ["ignore", "pipe", "pipe"] });
      // MÉDIO do Claude 4 3Kc no #5117: o comando que cria o repositório (qualquer um, inclusive read) guarda a marca
      // antiga do só-acrescentar que estiver no clone, antes que o aviso leve a apagá-la; a vigia a usa depois.
      try {
        const velha = git(["rev-parse", "--verify", "-q", REF_VERIFICADO]);
        if (/^[0-9a-f]{40}$/.test(velha)) writeFileSync(ARQUIVO_ANCORA(), `${velha}\n`);
      } catch { /* o clone não tem marca antiga */ }
    }
    dirPronto = true;
  }
  return git(args, input, GIT_PRAZO_MS, DIR_CORREIO);
}

/** O nome de um agente como pasta: "Claude 5 ibqho" -> "claude-5-ibqho"; "todos" é reservado. */
export function slug(nome) {
  const s = String(nome ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!s) throw new Error(`nome de agente vazio ou inválido: ${JSON.stringify(nome)}`);
  return s;
}

/**
 * Busca o ramo; devolve o commit, ou null se o ramo ainda não existe. Cada busca usa uma referência própria, apagada em
 * seguida: o vigia e um envio rodando ao mesmo tempo no mesmo clone nunca disputam a mesma referência.
 */
// Passo 6 (A11): uma decisão lê um retrato só do correio. A primeira leitura do comando busca e guarda o retrato; as
// seguintes usam o mesmo. Toda escrita busca de novo a ponta, para montar em cima dela, e depois o retrato passa a ser o
// commit que ela gravou. A vigia esquece o retrato a cada volta.
let retrato;
function buscar() {
  if (retrato === undefined) retrato = buscarDeNovo();
  return retrato;
}
/** Esquece o retrato guardado: a próxima leitura busca o correio de novo. */
export function esquecerRetrato() { retrato = undefined; }

function buscarDeNovo() {
  const ref = `refs/correio/${RAMO}-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    gitC(["fetch", "-q", "--no-write-fetch-head", REPO, `+refs/heads/${RAMO}:${ref}`]);
    return gitC(["rev-parse", ref]);
  } catch (erro) {
    if (/couldn't find remote ref|not found/i.test(String(erro.stderr ?? erro))) return null;
    throw erro;
  } finally {
    try { gitC(["update-ref", "-d", ref]); } catch { /* não foi criada */ }
  }
}

const arquivos = (commit, pasta) => (commit ? gitC(["ls-tree", "-r", "--name-only", commit, "--", pasta]).split("\n").filter(Boolean) : []);
const conteudo = (commit, caminho) => gitC(["show", `${commit}:${caminho}`]);
const idDe = (caminho) => caminho.split("/").pop().replace(/\.md$/, "");
/** Quem enviou, lido da id "<data>Z-<remetente>-<4 hex>", exatamente (assim "claude-5" não se confunde com "claude-5-ibqho"). */
export const remetenteDe = (id) => String(id).replace(/^\d{8}T\d{6}Z-/, "").replace(/-[0-9a-f]{4}$/, "");

/** Data de uma id "20261121T034500Z-claude-6-ab12". */
export function dataDe(id) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(id);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Ordem e instantes (dono, OWNER-20261121-1904-MAIL-TOOL-FIX-ORDER, passo 3). O nome de cada arquivo traz um instante
// escrito por quem o gravou, pelo relógio dele; a ordem verdadeira é a dos commits do ramo, que só anda para a frente
// (sem force push nem exclusão, regra 27091177). Por isso a ordem dos pedidos, das tomadas, dos interruptores e das
// cotas é a do commit que criou cada arquivo, e um instante declarado mais de FUTURO_MIN minutos à frente da hora de
// quem lê não vale: não segura pedido, não mantém CLAIMED e não liga interruptor. Num clone raso, os arquivos de antes da
// borda empatam no commit da borda e se desempatam como antes, pelo nome.
// ---------------------------------------------------------------------------------------------------------------------
export const FUTURO_MIN = 5;
/** Prazo máximo de uma tomada, somando as renovações da mesma sessão em seguida (passo 3): fila 30 min, revisão 2 h. */
export const TOMADA_MAX_MIN = { fila: 30, revisao: 120 };
const ordens = new Map();

/** A posição de cada arquivo na sequência dos commits (a do commit que o criou) e a hora desse commit. */
export function ordem(commit) {
  if (!commit) return new Map();
  if (ordens.has(commit)) return ordens.get(commit);
  const mapa = new Map();
  let i = -1, t = 0;
  for (const linha of gitC(["log", "--reverse", "--topo-order", "--format=%x01%ct", "--name-only", "--diff-filter=A", "--no-renames", commit]).split("\n")) {
    if (linha.startsWith("\x01")) { i += 1; t = Number(linha.slice(1)) * 1000; } else if (linha && !mapa.has(linha)) mapa.set(linha, { i, t });
  }
  ordens.set(commit, mapa);
  return mapa;
}

/** Um instante declarado mais de FUTURO_MIN minutos à frente de agora. */
export const noFuturo = (d, agora = new Date()) => Boolean(d && !Number.isNaN(d.getTime()) && d.getTime() - agora.getTime() > FUTURO_MIN * 60000);

// ---------------------------------------------------------------------------------------------------------------------
// Identidade (dono, 21/11/2026: "melhora a segurança, reduz os riscos o máximo que puder reduzir"). Todos gravam no
// correio com a mesma conta do GitHub, então o nome de quem escreve é declarado por ele. Na nuvem do Claude Code, a
// sessão vem do próprio ambiente (CLAUDE_CODE_REMOTE_SESSION_ID), sem nada digitado; o prefixo dela é da conta da família
// (SESSOES). A ferramenta grava a sessão em cada escrita (no commit e no fim de cada mensagem ou registro .md) e recusa
// escrever com o nome de outra família. Fora da nuvem (o Claude 1 no computador do dono, o Codex), a escrita fica marcada
// "não identificada". Isso evita engano e troca de nome; não é assinatura criptográfica: quem altera o ambiente ou a
// ferramenta de propósito ainda pode se passar por outro.
// ---------------------------------------------------------------------------------------------------------------------

/** A sessão da nuvem que roda a ferramenta, ou null fora da nuvem do Claude Code. */
export function sessaoAtual() {
  const m = /^(?:cse_|session_)?([0-9A-Za-z]{20,40})$/.exec(String(process.env.CLAUDE_CODE_REMOTE_SESSION_ID ?? "").trim());
  return m ? { id: `session_${m[1]}`, familia: SESSOES[m[1].slice(0, 7)] ?? null } : null;
}

/** O que se grava como sessão de quem escreve. */
export function linhaSessao(s = sessaoAtual()) {
  if (!s) return "não identificada (fora da nuvem do Claude Code)";
  return s.familia ? `${s.id} (${s.familia})` : `${s.id} (conta sem família conhecida)`;
}

/**
 * O nome de uma família para pôr numa mensagem, tirado da lista fixa de SESSOES, nunca do ambiente (CodeQL 257 no #5080):
 * a sessão vem de CLAUDE_CODE_REMOTE_SESSION_ID, que o CodeQL trata como dado sensível, e uma mensagem de erro chega ao
 * console. Por isso nenhuma mensagem leva o identificador da sessão, e a família sai da lista.
 */
export function familiaDaLista(f) {
  return Object.values(SESSOES).find((x) => x === f) ?? "desconhecida";
}

/** Recusa escrever com o nome de outra família quando a sessão da nuvem é de uma família conhecida. */
export function conferirIdentidade(nome, s = sessaoAtual()) {
  if (!nome || nome === true || !s?.familia) return;
  if (familia(nome) !== s.familia) {
    throw new Error(`identidade: esta sessão é da família ${familiaDaLista(s.familia)} e não escreve como "${nome}" (${familia(nome)}). ` +
      'Use o nome da sua família; a cota de outra família só é declarada por ela mesma ou pelo coordenador (passo 5).');
  }
}

/** A sessão gravada no fim de um texto do correio (a última linha "Sessão:"), com a família dela, ou null. */
export function sessaoDe(texto) {
  const linhas = String(texto).trimEnd().split("\n");
  const ultima = linhas[linhas.length - 1] ?? "";
  const m = /^Sessão: (.*)$/.exec(ultima);
  if (!m) return null;
  const id = /^session_([0-9A-Za-z]{7})/.exec(m[1]);
  return { texto: m[1], familia: id ? SESSOES[id[1]] ?? null : null, identificada: Boolean(id) };
}

/** Quem escreve nesta execução (o nome conferido por conferirIdentidade); vai no trailer Mail-From de cada commit. */
let ESCRITOR = null;
export function definirEscritor(nome) { ESCRITOR = nome && nome !== true ? String(nome) : null; }

/**
 * Disputa pelo ramo (22/11/2026, 01h50 a 01h55 Fortaleza): o correio recebeu 166 commits em 10 minutos, um a cada 3,6 s,
 * e cada escrita (busca, montagem, envio) leva perto disso; com 6 tentativas e esperas de 2 a 7 s, request-review falhou
 * quatro vezes seguidas com "rejected (fetch first)". Quem perde a corrida tenta de novo logo, com espera curta e
 * aleatória (para duas sessões não baterem juntas de novo), até ENVIO_TENTATIVAS vezes dentro de ENVIO_PRAZO_MS; os
 * outros erros (rede, permissão) continuam com ENVIO_FALHAS_OUTRAS tentativas, como antes.
 */
export const ENVIO_TENTATIVAS = 30;
export const ENVIO_FALHAS_OUTRAS = 6;
export const ENVIO_PRAZO_MS = 150000;
/** Um envio recusado porque o ramo andou no meio (outro agente gravou antes), e não por outro motivo. */
export const perdeuCorrida = (erro) => /\(fetch first\)|non-fast-forward|failed to update ref|cannot lock ref|incorrect old value|but expected/i.test(String(erro?.stderr ?? erro?.message ?? erro));
const esperar = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Math.round(ms))); };

/**
 * Acrescenta arquivos ao ramo, sem apagar nem mudar nenhum que já exista, e envia. Se outro agente enviou antes,
 * busca de novo e monta outra vez (veja ENVIO_TENTATIVAS).
 */
function acrescentar(novos, mensagem) {
  // Os blobs não mudam entre as tentativas: são gravados uma vez, e cada tentativa só refaz o índice sobre a base nova.
  const blobs = Object.entries(novos).map(([caminho, texto]) => {
    // A sessão de quem escreve vai no fim de cada mensagem ou registro .md (os outros arquivos têm formato fixo).
    const gravado = caminho.endsWith(".md") ? `${String(texto).replace(/\n*$/, "\n")}Sessão: ${linhaSessao()}\n` : texto;
    return [caminho, gitC(["hash-object", "-w", "--stdin"], gravado)];
  });
  const inicio = Date.now();
  let corridas = 0, outras = 0;
  for (;;) {
    const base = buscarDeNovo();
    const indice = join(tmpdir(), `correio-indice-${process.pid}-${randomBytes(4).toString("hex")}`);
    const env = { ...process.env, GIT_INDEX_FILE: indice, GIT_DIR: DIR_CORREIO };
    const comIndice = (args, input) => {
      try { return execFileSync("git", args, { input, encoding: "utf8", env, stdio: ["pipe", "pipe", "pipe"] }).trim(); } catch (erro) { throw erroDoGit(args, erro); }
    };
    let commit;
    try {
      if (base) comIndice(["read-tree", base]); else comIndice(["read-tree", "--empty"]);
      for (const [caminho, blob] of blobs) {
        if (base && arquivos(base, caminho).includes(caminho)) throw new Error(`já existe no correio: ${caminho}; nada é reescrito`);
        comIndice(["update-index", "--add", "--cacheinfo", `100644,${blob},${caminho}`]);
      }
      const arvore = comIndice(["write-tree"]);
      if (base) {
        const antes = new Set(arquivos(base, "."));
        const depois = new Set(gitC(["ls-tree", "-r", "--name-only", arvore]).split("\n"));
        const sumiram = [...antes].filter((f) => !depois.has(f));
        if (sumiram.length) throw new Error(`envio recusado: sumiriam ${sumiram.join(", ")}`);
      }
      // Mail-From: o nome de quem escreve, para o último sinal de cada família (dono, OWNER-20261122-0121-MAIL-AVAILABILITY).
      const de = ESCRITOR ? `\nMail-From: ${String(ESCRITOR).replace(/\s+/g, " ").trim()}` : "";
      commit = gitC(["commit-tree", arvore, ...(base ? ["-p", base] : []), "-m", `${mensagem}\n\nMail-Session: ${linhaSessao()}${de}`]);
    } finally {
      try { execFileSync("rm", ["-f", indice]); } catch { /* sem índice */ }
    }
    try {
      gitC(["push", "-q", REPO, `${commit}:refs/heads/${RAMO}`]);
      retrato = commit;
      return commit;
    } catch (erro) {
      const corrida = perdeuCorrida(erro);
      if (corrida) corridas += 1; else outras += 1;
      const tentativas = corridas + outras;
      if (corridas >= ENVIO_TENTATIVAS || outras >= ENVIO_FALHAS_OUTRAS || Date.now() - inicio > ENVIO_PRAZO_MS) {
        throw new Error(`envio falhou depois de ${tentativas} tentativas (${corridas} por o correio ter andado no meio, ${outras} por outro erro) em ${Math.round((Date.now() - inicio) / 1000)} s: ${String(erro.stderr ?? erro).slice(0, 300)}`);
      }
      // Perdeu a corrida: tenta logo, com espera aleatória curta. Outro erro: espera crescente, como antes.
      esperar(corrida ? 100 + Math.random() * 900 : 1000 * (1 + outras));
    }
  }
}

function opcoes(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      const chave = args[i].slice(2);
      const valor = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
      o[chave] = valor;
    } else o._.push(args[i]);
  }
  return o;
}

/** Monta os arquivos de uma mensagem (um por destinatário, todos com a mesma id), sem enviar. */
export function montarMensagem({ de, para, assunto, texto, responde = null, agora = new Date() }) {
  const remetente = String(de ?? "").trim();
  if (!remetente) throw new Error("--from é obrigatório");
  // "all" (ou "todos", o nome antigo) manda a todos; a pasta continua caixas/todos.
  const destinos = String(para ?? "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => (p.toLowerCase() === "all" ? "todos" : p));
  if (!destinos.length) throw new Error("--to é obrigatório (um ou mais nomes, separados por vírgula, ou todos)");
  if (!String(assunto ?? "").trim()) throw new Error("--subject é obrigatório");
  if (!String(texto ?? "").trim()) throw new Error("a mensagem está vazia");
  const carimbo = agora.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const id = `${carimbo}-${slug(remetente)}-${randomBytes(2).toString("hex")}`;
  const corpo = [
    `De: ${remetente}`,
    `Para: ${destinos.join(", ")}`,
    `Data (UTC): ${agora.toISOString().slice(0, 16).replace("T", " ")}`,
    `Assunto: ${String(assunto).trim()}`,
    ...(responde ? [`Responde a: ${responde}`] : []),
    `Id: ${id}`,
    "",
    String(texto).trim(),
    "",
  ].join("\n");
  const novos = {};
  for (const d of destinos) novos[`caixas/${slug(d)}/${id}.md`] = corpo;
  return { id, novos, destinos, remetente };
}

/** Envia uma mensagem; devolve a id. Um arquivo por destinatário, todos com a mesma id. */
export function enviar(dados) {
  const { id, novos, destinos, remetente } = montarMensagem(dados);
  acrescentar(novos, `Mensagem de ${remetente} para ${destinos.join(", ")}`);
  return id;
}

/**
 * As mensagens ainda não confirmadas por `eu`: da própria caixa e de todos (menos as que `eu` mesmo mandou a todos).
 * Uma sessão com nome próprio ("Claude 4 5BC", caixa claude-4-5bc) lê também a caixa da família (claude-4); ali, uma
 * mensagem conta como lida quando qualquer sessão da família a confirmou (proposta do Claude 4, 21/11/2026: a família
 * tem várias sessões, e cada uma passa a ter a própria caixa sem perder o que chega para a família).
 * O contrário também (dono, 21/11/2026, "faça o correto", teste do Claude 1): quem lê com o nome da família ("Claude 6")
 * lê também as caixas das sessões dela (claude-6-z5v4), para que nada enviado a uma sessão já encerrada se perca, como o
 * veredito de um pedido feito por ela. Ali, a mensagem conta como lida quando a sessão ou qualquer outra da família a
 * confirmou. Uma sessão não lê a caixa de outra sessão irmã: não é acordada pelo que não é dela.
 */
export function naoLidas(eu, commit = buscar()) {
  const me = slug(eu);
  const fam = familia(eu);
  const todasLidas = arquivos(commit, "lidas");
  const lidas = new Set(todasLidas.filter((l) => l.split("/")[1] === me).map(idDe));
  const daFamilia = new Set(todasLidas.filter((l) => familia(l.split("/")[1]) === fam).map(idDe));
  // Na própria caixa de uma sessão, só a confirmação da própria sessão a esconde (22/11/2026, 88a1): a feita com o nome da
  // família, por outra sessão que lê as caixas das sessões, não apaga da sessão ativa o que é só dela; a mensagem continua
  // aparecendo para ela, marcada como já confirmada com o nome da família, até ela mesma confirmar.
  const pelaFamilia = new Set(todasLidas.filter((l) => l.split("/")[1] === fam).map(idDe));
  const proprias = [...arquivos(commit, `caixas/${me}`), ...arquivos(commit, "caixas/todos")]
    .filter((c) => !lidas.has(idDe(c)) && !(c.startsWith("caixas/todos/") && remetenteDe(idDe(c)) === me));
  const familiares = me === fam
    ? arquivos(commit, "caixas").filter((c) => { const d = c.split("/")[1]; return d !== fam && d !== "todos" && familia(d) === fam && !daFamilia.has(idDe(c)); })
    : arquivos(commit, `caixas/${fam}`).filter((c) => !daFamilia.has(idDe(c)));
  return [...proprias, ...familiares]
    .filter((c) => c.endsWith(".md"))
    .map((c) => ({ id: idDe(c), caminho: c, texto: conteudo(commit, c), pelaFamilia: me !== fam && c.startsWith(`caixas/${me}/`) && pelaFamilia.has(idDe(c)) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Passo 6 (A13): as mensagens da caixa de `eu` (e da família) que só foram confirmadas por escrita não identificada nas
 * últimas 24 horas. Quem lê identificado é avisado delas, sem ser acordado: o Claude 1 no computador do dono e o Codex
 * confirmam assim de propósito, mas outro também poderia, com o nome da família.
 */
export function confirmadasSemIdentidade(eu, agora = new Date(), commit = buscar()) {
  if (!commit) return [];
  const me = slug(eu), fam = familia(eu);
  // Um git log só, sem abrir arquivo nenhum (LEVE do Claude 2 lpgvy no #5113): cada commit que acrescentou confirmações
  // traz a sessão de quem escreveu no trailer Mail-Session. Primeiro, as confirmações não identificadas das últimas 24
  // horas; depois, só para essas mensagens, se alguma sessão identificada da família também as confirmou.
  const lerLog = (args) => {
    const saida = [];
    let sessao = "", quando = 0;
    for (const linha of gitC(["log", "--format=%x01%ct%x02%(trailers:key=Mail-Session,valueonly,separator=%x20)", "--name-only", "--diff-filter=A", "--no-renames", ...args]).split("\n")) {
      if (linha.startsWith("\x01")) { const [t, ses] = linha.slice(1).split("\x02"); quando = Number(t) * 1000; sessao = ses.trim(); continue; }
      // LEVE do Claude 2 lpgvy (2659): um commit sem o trailer é de uma versão anterior ao A13, não uma escrita não
      // identificada; só o "não identificada (...)" que a ferramenta grava conta como tal.
      if (linha.startsWith("lidas/") && familia(linha.split("/")[1]) === fam) saida.push({ id: idDe(linha), quando, identificada: /^session_[0-9A-Za-z]{20,40} \(/.test(sessao), naoIdentificada: /^não identificada/.test(sessao) });
    }
    return saida;
  };
  const semId = new Map();
  for (const a of lerLog(["--since=24.hours", commit, "--", "lidas"])) if (a.naoIdentificada && agora - a.quando < 24 * 3600000) semId.set(a.id, a.quando);
  if (!semId.size) return [];
  const caminhos = arquivos(commit, "lidas").filter((c) => semId.has(idDe(c)) && familia(c.split("/")[1]) === fam);
  const comId = new Set(lerLog([commit, "--", ...caminhos]).filter((a) => a.identificada).map((a) => a.id));
  return [...arquivos(commit, `caixas/${me}`), ...(me !== fam ? arquivos(commit, `caixas/${fam}`) : [])]
    .filter((c) => c.endsWith(".md") && semId.has(idDe(c)) && !comId.has(idDe(c)))
    .map((c) => idDe(c)).sort();
}

export function confirmar({ eu, ids, agora = new Date() }) {
  // Duas sessões da mesma família confirmando a mesma mensagem ao mesmo tempo: relê e tenta de novo, sem as já gravadas.
  for (let tentativa = 0; ; tentativa++) {
    try {
      return confirmarUmaVez({ eu, ids, agora });
    } catch (erro) {
      if (tentativa >= 3 || !/já existe no correio/.test(String(erro.message ?? erro))) throw erro;
      esquecerRetrato();
    }
  }
}

function confirmarUmaVez({ eu, ids, agora }) {
  const me = slug(eu);
  // Uma já confirmada (por esta sessão, em outra rodada) não trava as outras: fica de fora.
  const ja = new Set(arquivos(buscar(), `lidas/${me}`).map(idDe));
  ids = ids.filter((id) => !ja.has(id));
  if (!ids.length) return 0;
  const novos = {};
  // Passo 6 (A13): a confirmação guarda a sessão que a fez; uma não identificada sai com aviso, e a família é avisada ao ler.
  for (const id of ids) novos[`lidas/${me}/${id}`] = `${agora.toISOString()}\nSessão: ${linhaSessao()}\n`;
  if (!sessaoAtual()) console.error(`ATENÇÃO: esta confirmação fica como não identificada (fora da nuvem do Claude Code); a família de ${eu} vai ver, ao ler identificada, que ${ids.length === 1 ? "a mensagem foi confirmada" : "as mensagens foram confirmadas"} assim.`);
  acrescentar(novos, `Lidas por ${eu}: ${ids.length}`);
  return ids.length;
}

/** O que `de` enviou e ainda não foi confirmado por cada destinatário (fora "todos"), com a idade em minutos. */
export function pendentes(de, agora = new Date(), commit = buscar()) {
  const me = slug(de);
  const lista = [];
  for (const c of arquivos(commit, "caixas")) {
    const [, dest] = c.split("/");
    const id = idDe(c);
    if (remetenteDe(id) !== me) continue;
    const quando = dataDe(id);
    const minutos = quando ? Math.floor((agora - quando) / 60000) : null;
    if (dest === "todos") {
      // Um aviso a todos só está lido por uma família quando alguma sessão dela o confirmou.
      const leram = new Set(arquivos(commit, "lidas").filter((l) => idDe(l) === id).map((l) => familia(l.split("/")[1])));
      for (const f of FAMILIAS) if (f !== familia(de) && !leram.has(f)) lista.push({ para: `${f} (todos)`, id, minutos });
      continue;
    }
    // Na caixa da família (claude-4) ou de uma sessão dela (claude-4-5bc), a confirmação de qualquer sessão da mesma família vale.
    if (arquivos(commit, "lidas").some((l) => idDe(l) === id && familia(l.split("/")[1]) === familia(dest))) continue;
    lista.push({ para: dest, id, minutos });
  }
  return lista.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------------------------------------------------
// Pedidos de revisão e de fila (dono, 21/11/2026: "QUERO QUE RESOLVA INCLUSIVE PARA PEDIDO DE REVISAO, ENFILEIRAMENTO
// (OS ENFILEIRAMENTOS DEVEM RESPEITAR A FILA)").
//
// <tipo>/pedidos/<id>.md      o pedido (PR, head, autor, observação); a id começa pela data, então a ordem é a da chegada.
// <tipo>/tomadas/<id>/<n>    a n-ésima tomada (0, 1, 2...): quem pegou e quando; a de maior n vale; uma tomada sem
//                             conclusão expira em 30 minutos e então pode ser retomada com o n seguinte.
// <tipo>/feitas/<id>.md       o resultado (veredito ou enfileirado/recusado), que também vai para a caixa do autor.
//
// Dois agentes nunca pegam o mesmo pedido: a tomada é um arquivo novo, e o envio recusa um que já exista; quem chega
// depois recebe "já tomado" e pega o seguinte. Revisão e fila são sempre de uma família diferente da do autor (FQ (1) e (2)).
// Fila: só se pega o pedido MAIS ANTIGO ainda aberto, e só um de cada vez, então os enfileiramentos respeitam a ordem.
// ---------------------------------------------------------------------------------------------------------------------

export const TOMADA_MIN = 30;
/**
 * Na fila, a tomada vence em 10 minutos (dono, 21/11/2026: reduzir a espera quando quem pegou fica sem cota): dos 83
 * enfileiramentos do dia, a mediana foi 1 minuto e só 1 passou de 10. Quem precisa de mais tempo renova com
 * renew-enqueue; só o próprio agente renova, então, quando a cota dele acaba, a tomada cai em até 10 minutos.
 */
export const TOMADA_FILA_MIN = 10;
const TIPOS = new Set(["revisao", "fila"]);

/** A família de um agente: "Claude 5 ibqho" -> "claude-5"; "Codex X6" -> "codex"; outro nome fica como está. */
export function familia(nome) {
  const s = slug(nome);
  return /^claude-\d+/.exec(s)?.[0] ?? (s.startsWith("codex") ? "codex" : s);
}

/** Um campo do cabeçalho de um registro (as linhas antes da primeira linha vazia), nunca do texto livre. */
function campoCabecalho(texto, nome) {
  const cabecalho = String(texto).split(/\n\s*\n/)[0];
  return new RegExp(`^${nome}: (.*)$`, "m").exec(cabecalho)?.[1]?.trim() ?? "";
}

// Passo 6 (A12): todo campo vem do cabeçalho; uma linha "Exclui:" ou "Preferência:" no texto livre nunca vira campo.
function campo(texto, nome) {
  return campoCabecalho(texto, nome);
}

/** Os pedidos de um tipo, na ordem de chegada, com o estado de cada um. */
export function pedidos(tipo, agora = new Date(), commit = buscar()) {
  if (!TIPOS.has(tipo)) throw new Error(`tipo desconhecido: ${tipo}`);
  const feitas = new Set(arquivos(commit, `${tipo}/feitas`).map(idDe));
  const semCota = new Set(Object.entries(cotas(agora, commit)).filter(([, v]) => v.sem).map(([f]) => f));
  const tomadas = new Map();
  const devolvidas = new Map(); // id -> famílias que devolveram (por exemplo, por terem commits no PR); não pegam de novo
  const ord = ordem(commit);
  const maiorN = new Map();
  // Passo 3: as tomadas de cada pedido valem na ordem dos commits (o número n só dá nome ao arquivo); uma liberação do
  // coordenador só vale como registro privilegiado; e as renovações seguidas da mesma sessão param de valer depois de
  // TOMADA_MAX_MIN contados da primeira delas.
  const lidas = arquivos(commit, `${tipo}/tomadas`).map((c) => ({ c, i: ord.get(c)?.i ?? -1, n: Number(c.split("/")[3]) }))
    .sort((a, b) => a.i - b.i || a.n - b.n);
  for (const { c, n } of lidas) {
    const id = c.split("/")[2];
    maiorN.set(id, Math.max(maiorN.get(id) ?? -1, n));
    const texto = conteudo(commit, c);
    const [marca, por, acao] = texto.split("\n");
    const quem = por || remetenteDe(marca);
    if (acao === "LIBERADO" && !privilegioValido(texto, quem)) continue;
    if (acao === "DEVOLVIDO") devolvidas.set(id, new Set([...(devolvidas.get(id) ?? []), familia(quem)]));
    // A tomada vale da hora declarada ou da do commit, a que vier primeiro; uma declarada no futuro não vale.
    const declarada = dataDe(marca), feita = ord.get(c)?.t;
    const quando = noFuturo(declarada, agora) ? null : declarada && feita ? new Date(Math.min(declarada.getTime(), feita)) : declarada;
    const antes = tomadas.get(id);
    const solta = acao === "DEVOLVIDO" || acao === "LIBERADO";
    // A sequência só continua se a tomada anterior da mesma sessão ainda valia quando esta foi gravada (renovação); depois
    // de vencida, uma tomada nova começa outra sequência (revisão do Claude 4 AC no #5057, MÉDIO).
    const prazo = tipo === "fila" ? TOMADA_FILA_MIN : TOMADA_MIN;
    const renovacao = !solta && antes && !antes.devolvida && slug(antes.por) === slug(quem) && antes.inicio && antes.quando && quando &&
      (quando - antes.quando) / 60000 < prazo;
    const inicio = renovacao ? antes.inicio : quando;
    tomadas.set(id, { n, por: quem, quando, inicio, devolvida: solta });
  }
  const pos = (id) => ord.get(`${tipo}/pedidos/${id}.md`)?.i ?? Infinity;
  return arquivos(commit, `${tipo}/pedidos`).map(idDe).sort((a, b) => pos(a) - pos(b) || a.localeCompare(b)).map((id) => {
    const texto = conteudo(commit, `${tipo}/pedidos/${id}.md`);
    const tomada = tomadas.get(id);
    const viva = tomada && !tomada.devolvida && tomada.quando && (agora - tomada.quando) / 60000 < (tipo === "fila" ? TOMADA_FILA_MIN : TOMADA_MIN) &&
      (!tomada.inicio || (agora - tomada.inicio) / 60000 < TOMADA_MAX_MIN[tipo]) && !semCota.has(familia(tomada.por));
    const estado = feitas.has(id) ? "feito" : viva ? "tomado" : "aberto";
    return { id, tipo, pr: campo(texto, "PR"), sha: campo(texto, "Head"), autor: campo(texto, "Autor"), familia: familia(campo(texto, "Autor")),
      texto, estado, tomadoPor: viva ? tomada.por : null, ultimaTomadaPor: tomada && !tomada.devolvida ? tomada.por : null,
      proximaTomada: maiorN.has(id) ? maiorN.get(id) + 1 : 0, devolveram: devolvidas.get(id) ?? new Set() };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Quem tem commits no PR (dono, 21/11/2026: "para quem pedir revisão só pedir a quem realmente pode fazer"). A revisão é
// de uma família sem commits no PR (FQ (2), RV). A ferramenta lê os commits do PR (o que ele tem além do main) e acha a
// família de cada um: pelo trailer Claude-Session (o prefixo da sessão é da conta da família), pelo nome "Claude N" do
// autor, e, num commit sem trailer de autor que não é "Claude", pelo Codex, que escreve com a conta do GitHub do dono.
// ---------------------------------------------------------------------------------------------------------------------

export const REPO_PRS = process.env.CORREIO_PR_REPO || "https://github.com/solrenning-llc/marktmorgen";

// Variáveis de teste (OWNER-20261121-1904, passo 4): CORREIO_SEM_COMMITS, CORREIO_SEM_GH e CORREIO_SEM_VERSAO só valem
// com a marca AGENT_MAIL_TEST=1 e com os dois repositórios locais (nenhum endereço de rede). Fora disso a variável é
// ignorada, com um aviso, e a ferramenta faz a conferência de verdade.
const avisadas = new Set();
// "Local" é o que é local: um caminho absoluto ou file://; qualquer outra forma (scp, ext::, relativo) não conta.
const repoLocal = (r) => isAbsolute(String(r)) || /^file:\/\/\//i.test(String(r));
/** true só quando a variável de teste `nome` está em "1", com a marca de teste e os repositórios locais. */
export function testeLigado(nome) {
  if (process.env[nome] !== "1") return false;
  if (process.env.AGENT_MAIL_TEST === "1" && repoLocal(REPO) && repoLocal(REPO_PRS)) return true;
  if (!avisadas.has(nome)) {
    avisadas.add(nome);
    console.error(`ATENÇÃO: a variável de teste ${nome}=1 foi ignorada: ela só vale com AGENT_MAIL_TEST=1 e com os repositórios do correio e dos PRs locais; a conferência foi feita de verdade.`);
  }
  return false;
}
/** Prefixo da sessão (7 caracteres depois de "session_") -> família. Conferido nos PRs abertos em 21/11/2026. */
export const SESSOES = { "01DKvYQ": "claude-1", "01FR6Z1": "claude-2", "014YNUx": "claude-3", "01S9eVA": "claude-4",
  "012ST5i": "claude-5", "018ZjhH": "claude-6", "01Hfzoz": "claude-7" };

/** As famílias com commits no PR e as sessões que não se sabe de quem são; null quando o PR não pôde ser lido. */
export function commitsDoPr(pr, ramo = null) {
  if (testeLigado("CORREIO_SEM_COMMITS")) return null;
  const sufixo = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const base = `refs/agent-mail-pr/prs-main-${sufixo}`, cabeca = `refs/agent-mail-pr/prs-${pr}-${sufixo}`;
  try {
    git(["fetch", "-q", "--no-tags", REPO_PRS, `+refs/heads/main:${base}`, `+${fonteDoHead(pr, ramo)}:${cabeca}`]);
    const linhas = git(["log", "--format=%an%x1f%(trailers:key=Claude-Session,valueonly,separator=%x1e)", `${base}..${cabeca}`]).split("\n").filter(Boolean);
    const familias = new Set(), desconhecidas = new Set(), completas = new Set();
    for (const linha of linhas) {
      const [autor, sessoes = ""] = linha.split("\x1f");
      for (const m of sessoes.matchAll(/session_([0-9A-Za-z]{20,40})/g)) completas.add(`session_${m[1]}`);
      const prefixos = [...sessoes.matchAll(/session_([0-9A-Za-z]{7})/g)].map((m) => m[1]);
      for (const pre of prefixos) (SESSOES[pre] ? familias.add(SESSOES[pre]) : desconhecidas.add(`session_${pre}`));
      const nome = /^Claude (\d+)\b/.exec(autor);
      if (nome) familias.add(`claude-${nome[1]}`);
      else if (!prefixos.length && !/^Claude\b/.test(autor)) familias.add("codex");
      else if (!prefixos.length) desconhecidas.add(`autor "${autor}" sem trailer`);
    }
    // O tamanho da revisão (OWNER-20261122-0121-MAIL-AVAILABILITY, item 2): linhas mudadas fora dos testes desde a base
    // comum com o main (AC (f)); null quando não pôde ser lido, e então a revisão conta como longa.
    let tamanho = null;
    try {
      tamanho = 0;
      for (const l of git(["diff", "--numstat", "--no-renames", `${base}...${cabeca}`]).split("\n").filter(Boolean)) {
        const [mais, menos, caminho = ""] = l.split("\t");
        if (/^tests\/|(^|\/)__tests__\/|\.test\.[cm]?[jt]sx?$/.test(caminho) || mais === "-") continue;
        tamanho += Number(mais) + Number(menos);
      }
    } catch { tamanho = null; }
    return { familias, desconhecidas, sessoes: completas, linhas: tamanho };
  } catch {
    return null;
  } finally {
    for (const ref of [base, cabeca]) { try { git(["update-ref", "-d", ref]); } catch {} }
  }
}

/**
 * O ramo do PR, achado pelo head no momento do pedido: o único ramo (fora da fila de integração) cuja ponta é aquele
 * commit. Guardado no pedido ("Ramo:"), ele permite ler o head atual direto do ramo, cuja referência não atrasa, ao
 * contrário de refs/pull/N/head (caso do #5040, 21/11/2026: refs/pull/5040/head ficou minutos em 9fdf22aa60 depois do
 * envio de d75b7405f2). Tudo pelo git, sem a API do GitHub (revisão do Claude 4 3rC no repo-id-transfer-test#2).
 * null quando não há exatamente um ramo.
 */
export function ramoDoHead(sha, pr) {
  if (testeLigado("CORREIO_SEM_COMMITS") || !/^[0-9a-f]{10,40}$/.test(String(sha ?? ""))) return null;
  try {
    const ramos = git(["ls-remote", REPO_PRS, "refs/heads/*"]).split("\n").filter(Boolean).map((l) => l.split("\t"))
      .filter(([h, ref]) => h.startsWith(String(sha)) && !ref.startsWith("refs/heads/gh-readonly-queue/")).map(([, ref]) => ref.slice("refs/heads/".length))
      .filter((ramo) => ramoDoPr(pr, ramo));
    if (ramos.length === 1) return ramos[0];
    // Dois ou mais ramos na mesma ponta (um ramo auxiliar usado para preparar uma junção por avanço simples, caso do
    // #5080): vale o ramo que o próprio GitHub diz ser o do PR (head.ref), se for um deles. Sem o GitHub, não adivinha
    // (LEVE do Claude 6 z5v4, 22/11/2026): um ramo auxiliar parado num commit velho leria o head errado depois.
    if (ramos.length > 1) { const doPr = ramoNoGitHub(pr); return doPr && ramos.includes(doPr) ? doPr : null; }
    return null;
  } catch {
    return null;
  }
}

/** O ramo do PR segundo o GitHub (head.ref), ou null se não deu para ler. */
export function ramoNoGitHub(pr) {
  if (testeLigado("CORREIO_SEM_GH") || !/^\d+$/.test(String(pr ?? ""))) return null;
  try {
    const ref = execFileSync("gh", ["api", `repos/solrenning-llc/marktmorgen/pulls/${pr}`, "--jq", ".head.ref"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }).trim();
    return /^[A-Za-z0-9._\/-]+$/.test(ref) ? ref : null;
  } catch {
    return null;
  }
}

/**
 * Se o ramo é mesmo o do PR: a referência refs/pull/N/head (que pode estar atrasada, nunca adiantada) é igual à ponta do
 * ramo ou anterior a ela. Uma cópia de reserva parada num head velho não passa, porque o PR andou depois dela (revisão do
 * Claude 2 upbeat no repo-id-transfer-test#2). Só pelo git.
 */
export function ramoDoPr(pr, ramo) {
  if (!/^\d+$/.test(String(pr ?? "")) || !ramo) return false;
  const sufixo = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const a = `refs/agent-mail-pr/rp-${pr}-${sufixo}`, b = `refs/agent-mail-pr/rr-${sufixo}`;
  try {
    git(["fetch", "-q", "--no-tags", REPO_PRS, `+refs/pull/${pr}/head:${a}`, `+refs/heads/${ramo}:${b}`]);
    try { git(["merge-base", "--is-ancestor", a, b]); return true; } catch { return false; }
  } catch {
    return false;
  } finally {
    for (const r of [a, b]) { try { git(["update-ref", "-d", r]); } catch { /* não foi criada */ } }
  }
}

/**
 * O head atual do PR e de onde veio: "ramo" (a ponta do ramo do PR, guardado no pedido), "local" (refs/pull/N/head de um
 * repositório que não é o GitHub, como nos testes) ou "ref" (refs/pull/N/head do GitHub, que pode atrasar e por isso não
 * basta para recusar: pedido do coordenador, 20261121T220452Z-claude-5-ibqho-2bf1). { sha: null } quando não deu para ler.
 */
export function headDoPr(pr, ramo = null) {
  if (testeLigado("CORREIO_SEM_COMMITS")) return { sha: null, fonte: null };
  if (ramo && ramoDoPr(pr, ramo)) {
    try {
      const linha = git(["ls-remote", REPO_PRS, `refs/heads/${ramo}`]).split("\n").find(Boolean);
      if (linha) return { sha: linha.split("\t")[0], fonte: "ramo" };
    } catch { /* o ramo sumiu: usa a referência do PR */ }
  }
  try {
    const linha = git(["ls-remote", REPO_PRS, `refs/pull/${pr}/head`]).split("\n").find(Boolean);
    if (linha) return { sha: linha.split("\t")[0], fonte: /github\.com/.test(REPO_PRS) ? "ref" : "local" };
  } catch { /* não deu para ler */ }
  return { sha: null, fonte: null };
}

/** Compatível com as versões anteriores: só o sha do head atual. */
export function headAtual(pr, ramo = null) {
  return headDoPr(pr, ramo).sha;
}

/** O que buscar para ter o head atual do PR: o ramo dele, quando conhecido, senão refs/pull/N/head. */
function fonteDoHead(pr, ramo = null) {
  return ramo ? `refs/heads/${ramo}` : `refs/pull/${pr}/head`;
}

/**
 * Se o PR já está na fila de integração do GitHub ou já entrou no main (o head dele está no main). Assim, quem pega um
 * pedido cuja tomada anterior venceu não enfileira de novo nem recusa por engano um PR que outro já enfileirou. Devolve
 * { naFila, noMain }, ou null quando não foi possível ler.
 */
export function situacaoNoGitHub(pr, ramo = null) {
  if (testeLigado("CORREIO_SEM_COMMITS")) return null;
  const sufixo = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const base = `refs/agent-mail-pr/sg-main-${sufixo}`, cabeca = `refs/agent-mail-pr/sg-${pr}-${sufixo}`;
  try {
    const naFila = git(["ls-remote", REPO_PRS, "refs/heads/gh-readonly-queue/*"]).split("\n").some((l) => new RegExp(`/pr-${pr}-[0-9a-f]+$`).test(l));
    git(["fetch", "-q", "--no-tags", REPO_PRS, `+refs/heads/main:${base}`, `+${fonteDoHead(pr, ramo)}:${cabeca}`]);
    let noMain = false;
    try { git(["merge-base", "--is-ancestor", cabeca, base]); noMain = true; } catch (erro) { if (erro.status !== 1) throw erro; }
    return { naFila, noMain };
  } catch {
    return null;
  } finally {
    for (const ref of [base, cabeca]) { try { git(["update-ref", "-d", ref]); } catch {} }
  }
}

/**
 * Com quem o PR conflita agora: o main e cada grupo que já está na fila de integração do GitHub
 * (refs/heads/gh-readonly-queue/*). Um PR limpo contra o main pode conflitar com um PR que entra antes dele (caso do #5017
 * com o #5016, 21/11/2026, achado pelo Claude 1 B); o GitHub só mostra o conflito quando o grupo falha. Devolve
 * { conflitos: ["main" | "#N"], grupos }, ou null quando não foi possível ler.
 */
export function conflitosDoPr(pr, ramo = null) {
  if (testeLigado("CORREIO_SEM_COMMITS")) return null;
  const sufixo = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const criados = [];
  try {
    const filas = git(["ls-remote", REPO_PRS, "refs/heads/gh-readonly-queue/*"]).split("\n").filter(Boolean).map((l) => l.split("\t")[1]);
    const cabeca = `refs/agent-mail-pr/cf-${pr}-${sufixo}`, base = `refs/agent-mail-pr/cf-main-${sufixo}`;
    const pares = [`+refs/heads/main:${base}`, `+${fonteDoHead(pr, ramo)}:${cabeca}`];
    const grupos = filas.map((ref, i) => ({ ref, local: `refs/agent-mail-pr/cf-q${i}-${sufixo}`, pr: /\/pr-(\d+)-/.exec(ref)?.[1] ?? null }))
      .filter((g) => g.pr !== String(pr));
    for (const g of grupos) pares.push(`+${g.ref}:${g.local}`);
    criados.push(base, cabeca, ...grupos.map((g) => g.local));
    git(["fetch", "-q", "--no-tags", REPO_PRS, ...pares]);
    const conflita = (a) => {
      try { git(["merge-tree", "--write-tree", a, cabeca]); return false; }
      catch (erro) { if (erro.status === 1) return true; throw erro; }
    };
    const conflitos = [];
    if (conflita(base)) conflitos.push("main");
    for (const g of grupos) if (conflita(g.local)) conflitos.push(g.pr ? `#${g.pr}` : g.ref);
    return { conflitos, grupos: grupos.length };
  } catch {
    return null;
  } finally {
    for (const ref of criados) { try { git(["update-ref", "-d", ref]); } catch {} }
  }
}

/** As famílias que concluíram pelo correio uma revisão deste PR neste head: pela FQ (1), elas não o enfileiram. */
export function revisoresDoHead(pr, sha, commit = buscar()) {
  const f = new Set();
  for (const c of arquivos(commit, "revisao/feitas")) {
    const texto = conteudo(commit, c);
    const head = campo(texto, "Head");
    if (campo(texto, "PR") === String(pr) && head && sha && (head.startsWith(String(sha).slice(0, 10)) || String(sha).startsWith(head.slice(0, 10))) && /^(READY|CHANGES)$/.test(campo(texto, "Resultado"))) f.add(familia(campo(texto, "Por")));
  }
  // Item 2: com o interruptor record-review ligado, quem registrou revisão deste head também fica de fora (R3: só registro
  // identificado ou confirmado pelo coordenador). Vale só o head registrado (2.3).
  if (sha && arquivos(commit, "revisao/registros").length) {
    for (const r of registros(pr, commit, null)) {
      if (r.excluiDaFila && (r.sha.startsWith(String(sha).slice(0, 10)) || String(sha).startsWith(r.sha.slice(0, 10)))) f.add(familia(r.por));
    }
  }
  return f;
}

// ---------------------------------------------------------------------------------------------------------------------
// Interruptores (dono, OWNER-20261121-1749-QUEUE-IMPROVEMENTS-AUTH, R1). Cada melhoria autorizada fica atrás de uma chave
// no próprio correio: chaves/<nome>/<carimbo>-<quem>-<hex>, com "ON" ou "OFF" na primeira linha; o último registro vale, e
// sem nenhum a chave está DESLIGADA, com a ferramenta exatamente como antes. Só a sessão nomeada (ou a reserva) liga,
// a pedido do coordenador (ações privilegiadas, abaixo); qualquer sessão desliga, porque desligar só volta ao
// comportamento de antes.
// ---------------------------------------------------------------------------------------------------------------------
export const CHAVES = ["record-review", "ready-check", "on-call"];

// ---------------------------------------------------------------------------------------------------------------------
// Ações privilegiadas (dono, OWNER-20261121-1904-MAIL-TOOL-FIX-ORDER, passo 2; decisão do coordenador
// C1-20261121-2036-C6-1, publicada na #4932, comentário 7070984974): ligar um interruptor e confirmar um registro de
// revisão. Valem estas condições, conferidas pelo identificador COMPLETO da sessão, nunca pela família nem pelo prefixo:
//  1. só a sessão nomeada (Claude 5 ibqho) age; a reserva (Claude 1 A) só em três casos: 60 minutos sem sinal da
//     nomeada no correio, a família Claude 5 declarada sem cota, ou mensagem do dono (--owner-message, gravada);
//  3. nunca num PR que a sessão escreveu (trailer Claude-Session nos commits), revisou ou enfileirou (no correio);
//  4. só com o pedido do coordenador publicado no canal de coordenação em vigor (a issue aberta com o rótulo canal-ativo,
//     AC (y); hoje a #5104, que continua a #4932) ou na parte que ele continua, conferido na hora pelo gh (--request):
//     um comentário com a linha
//     "AGENT-MAIL-REQUEST <identificador C1-...> <comando> <alvo>", de no máximo PEDIDO_MAX_H horas, usado uma vez só
//     (revisão do Claude 4 3Kc no #5052); a ação é avisada a todos no mesmo commit, com o pedido. Desligar continua livre.
// O sinal da sessão nomeada é lido do histórico local do correio; num clone raso que não cobre os 60 minutos, a falta de
// sinal fica NÃO CONFERIDA e a reserva não age (mesma revisão).
// Limite, sem esconder (VR): o identificador vem de uma variável de ambiente, pode ser copiado e é herdado por subagente
// e por roteiro; e todos gravam no correio com a mesma conta do GitHub, então um "ON" escrito pelo git direto, com a
// linha da sessão e a do pedido copiadas, ainda é lido como válido. Isto evita engano e ação fora da regra; não é
// autenticação. A proposta de identidade autenticada (assinatura ou chave por família) vai ao dono antes do passo 8.
// ---------------------------------------------------------------------------------------------------------------------
export const SESSAO_NOMEADA = "session_012ST5ibqhoHCYrphJXU5az3"; // Claude 5 ibqho
export const SESSAO_RESERVA = "session_01DKvYQaxPrZTrVdXNwosXYi"; // Claude 1 A
export const CANAL_PEDIDOS = 4932; // a parte do canal em que a regra nasceu; o canal em vigor é lido em canaisDePedido()
export const SINAL_MIN = 60;
export const PEDIDO_MAX_H = 2;
export const PREFIXO_COORDENADOR = "C1"; // o coordenador é o Claude 1 (C1-20261121-2036-C6-1, condição 5)
const LINK_PEDIDO = /^(?:https:\/\/github\.com\/solrenning-llc\/marktmorgen\/issues\/(\d+)#issuecomment-)?(\d+)$/;
const LINHA_PEDIDO = /^Pedido: https:\/\/github\.com\/solrenning-llc\/marktmorgen\/issues\/\d+#issuecomment-\d+$/m;

/**
 * As issues em que um pedido do coordenador vale agora: a única issue aberta com o rótulo canal-ativo (AC (y)) e a parte
 * que ela continua ("continues #N" no título), lidas na hora no GitHub. O canal troca de parte aos 2.250 comentários
 * (AC (p)): em 22/11/2026 a #5104 assumiu da #4932, e um pedido escrito nela era recusado. null = NÃO CONFERIDO (o gh
 * não respondeu, nenhuma ou mais de uma issue com o rótulo): quem chama não faz nada (passo 4).
 */
export function canaisDePedido() {
  try {
    if (testeLigado("CORREIO_SEM_GH")) throw new Error("sem gh");
    const saida = execFileSync("gh", ["api", "repos/solrenning-llc/marktmorgen/issues?labels=canal-ativo&state=open&per_page=100", "--jq", ".[] | [.number, (.title // \"\")] | @json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
    const abertas = saida.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    if (abertas.length !== 1 || !Number.isInteger(abertas[0][0])) return null;
    const [ativo, titulo] = abertas[0];
    const anterior = Number(/\(continues #(\d+)\)/i.exec(String(titulo))?.[1]);
    return { ativo, anterior: Number.isInteger(anterior) && anterior !== ativo ? anterior : null };
  } catch {
    return null;
  }
}
const sessaoInteira = (s) => String(s?.texto ?? "").split(" ")[0];

/** Um registro privilegiado só vale com a sessão nomeada ou a reserva, o nome da família dela e a linha do pedido. */
export function privilegioValido(texto, por) {
  const id = sessaoInteira(sessaoDe(texto));
  if (id !== SESSAO_NOMEADA && id !== SESSAO_RESERVA) return false;
  return familia(por) === SESSOES[id.slice(8, 15)] && LINHA_PEDIDO.test(texto);
}

/**
 * Quando a sessão gravou no correio pela última vez (a linha Mail-Session de cada commit). { quando, conferido }:
 * sem sinal achado, conferido só se o histórico local é completo ou, num clone raso, cobre os últimos SINAL_MIN minutos.
 */
export function ultimoSinal(sessao, commit = buscar(), agora = new Date()) {
  if (!commit) return { quando: null, conferido: true };
  const t = gitC(["log", "-1", "--format=%ct", "-F", `--grep=Mail-Session: ${sessao}`, commit]);
  if (t) return { quando: new Date(Number(t) * 1000), conferido: true };
  if (gitC(["rev-parse", "--is-shallow-repository"]) !== "true") return { quando: null, conferido: true };
  // Num clone raso, os commits da borda aparecem sem pais. Com mais de uma borda (uma junção), um caminho pode parar na
  // mais recente: o histórico só está completo desde ela (revisão do Claude 4 AC no #5052).
  const bordas = gitC(["log", "--format=%ct", "--max-parents=0", commit]).split("\n").filter(Boolean).map(Number);
  const inicio = bordas.length ? Math.max(...bordas) * 1000 : Infinity;
  return { quando: null, conferido: inicio <= agora.getTime() - SINAL_MIN * 60000 };
}

/**
 * Confere no GitHub, agora, que o pedido é um comentário do canal em vigor ou da parte que ele continua (canaisDePedido),
 * de no máximo PEDIDO_MAX_H horas, com a linha
 * "AGENT-MAIL-REQUEST <identificador do coordenador> <comando> <alvo>", ainda não usado; devolve o endereço e o identificador.
 */
export function conferirPedido(pedido, comando, alvo, commit = buscar(), agora = new Date()) {
  const lido = LINK_PEDIDO.exec(String(pedido === true ? "" : pedido ?? "").trim());
  if (!lido) throw new Error("--request é obrigatório: o comentário do coordenador no canal em vigor (a issue com o rótulo canal-ativo) que pede esta ação (https://github.com/solrenning-llc/marktmorgen/issues/<canal>#issuecomment-N), C1-20261121-2036-C6-1, condição 4");
  const m = [lido[0], lido[2]];
  const canais = canaisDePedido();
  if (!canais) throw new Error(`o canal em vigor (a issue aberta com o rótulo canal-ativo) NÃO FOI CONFERIDO no GitHub agora; o pedido ${m[1]} não foi usado e nada foi feito (passo 4)`);
  const validos = [canais.ativo, canais.anterior].filter(Boolean);
  const nomeCanais = `#${canais.ativo}${canais.anterior ? ` ou da #${canais.anterior}, a parte que ele continua` : ""}`;
  if (lido[1] && !validos.includes(Number(lido[1]))) throw new Error(`o comentário ${m[1]} não é do canal em vigor (${nomeCanais}): #${lido[1]}`);
  let url, corpo, criado;
  try {
    if (testeLigado("CORREIO_SEM_GH")) throw new Error("sem gh");
    const saida = execFileSync("gh", ["api", `repos/solrenning-llc/marktmorgen/issues/comments/${m[1]}`, "--jq", "[.html_url, (.body // \"\"), (.created_at // \"\")] | @json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
    [url, corpo, criado] = JSON.parse(saida.trim()); // o gh imprime o texto do @json sem aspas: uma camada só
  } catch {
    throw new Error(`o pedido ${m[1]} NÃO FOI CONFERIDO no GitHub agora; nada foi feito (passo 4: nada NÃO CONFERIDO segue)`);
  }
  const esperado = validos.map((n) => `https://github.com/solrenning-llc/marktmorgen/issues/${n}#issuecomment-${m[1]}`).find((u) => u === url);
  if (!esperado) throw new Error(`o comentário ${m[1]} não é do canal em vigor (${nomeCanais}): ${url}`);
  const quando = new Date(criado);
  if (Number.isNaN(quando.getTime()) || agora - quando > PEDIDO_MAX_H * 3600000 || quando - agora > 5 * 60000) {
    throw new Error(`o comentário ${m[1]} não é um pedido recente (de no máximo ${PEDIDO_MAX_H} horas): ${criado || "sem data"}`);
  }
  const linha = String(corpo).split(/\r?\n/).map((l) => l.trim())
    .map((l) => new RegExp(`^AGENT-MAIL-REQUEST (${PREFIXO_COORDENADOR}-\\d{8}-\\d{4}-[A-Z0-9-]+) (\\S+) (\\S+)$`).exec(l))
    .find((x) => x && x[2] === comando && x[3] === alvo);
  if (!linha) throw new Error(`o comentário ${m[1]} não traz a linha "AGENT-MAIL-REQUEST <identificador ${PREFIXO_COORDENADOR}-AAAAMMDD-HHMM-ASSUNTO> ${comando} ${alvo}"`);
  let achados = [];
  try {
    achados = gitC(["grep", "-l", "-F", `Pedido: ${esperado}`, commit, "--", "chaves", "revisao/confirmados", "estado", "prs", "fila/tomadas", "revisao/tomadas"]).split("\n").filter(Boolean);
  } catch (erro) {
    // O git grep sai com 1 quando não acha nada; qualquer outra falha deixa o uso NÃO CONFERIDO (revisão do Claude 4 AC).
    if (erro?.status !== 1) throw new Error(`o uso único do pedido ${m[1]} NÃO FOI CONFERIDO (git grep falhou); nada foi feito`);
  }
  const usado = achados.map((l) => l.slice(String(commit).length + 1)).find((c) => conteudo(commit, c).split("\n").includes(`Pedido: ${esperado}`));
  if (usado) throw new Error(`o pedido ${m[1]} já foi usado (${usado}); cada ação precisa de um pedido próprio`);
  return { url: esperado, id: linha[1] };
}

/**
 * Confere as condições 1 e 4 para a sessão atual; devolve a sessão, o pedido conferido e, para a reserva, o caso dela.
 * `acao` descreve a ação na mensagem de erro; `alvo` é o que o pedido precisa citar.
 */
export function conferirPrivilegio({ eu, acao, comando, alvo, pedido, dono = "", agora = new Date(), commit = buscar() }) {
  const s = sessaoAtual();
  if (!s || (s.id !== SESSAO_NOMEADA && s.id !== SESSAO_RESERVA)) {
    throw new Error(`só a sessão nomeada (Claude 5 ibqho, ${SESSAO_NOMEADA}) ${acao}, ou a reserva (Claude 1 A, ${SESSAO_RESERVA}) nos três casos dela; esta sessão ${s ? "não é nenhuma das duas" : "não é identificada"} (C1-20261121-2036-C6-1, condição 1)`);
  }
  if (familia(eu) !== s.familia) throw new Error(`identidade: esta sessão é da família ${familiaDaLista(s.familia)} e não age como "${eu}"`);
  let reserva = "";
  if (s.id === SESSAO_RESERVA) {
    const ownerMsg = String(dono === true ? "" : dono ?? "").trim();
    if (ownerMsg) reserva = `mensagem do dono: ${ownerMsg}`;
    else if (cotas(agora, commit)["claude-5"]?.sem) reserva = "a família Claude 5 está sem cota";
    else {
      const { quando, conferido } = ultimoSinal(SESSAO_NOMEADA, commit, agora);
      if (!conferido) throw new Error(`o sinal da sessão nomeada NÃO FOI CONFERIDO: o histórico local do correio é raso e não cobre ${SINAL_MIN} minutos; a reserva não age (aprofunde o clone com git fetch --unshallow, ou use os outros dois casos)`);
      if (quando && agora - quando < SINAL_MIN * 60000) throw new Error(`a reserva só age em três casos: ${SINAL_MIN} minutos sem sinal da sessão nomeada (último: ${quando.toISOString()}), a família Claude 5 sem cota, ou mensagem do dono (--owner-message <identificador>); condição 2`);
      reserva = `${SINAL_MIN} minutos sem sinal da sessão nomeada (último: ${quando ? quando.toISOString() : "nenhum no histórico"})`;
    }
  }
  const p = conferirPedido(pedido, comando, alvo, commit, agora);
  return { s, reserva, pedido: p.url, idPedido: p.id };
}

/** Condição 3: o que a sessão fez no PR (escreveu, revisou, enfileirou); lança erro se fez algo ou se não deu para ler. */
export function conferirDistancia(pr, sessao, commit = buscar()) {
  const deste = (pasta) => arquivos(commit, pasta).filter((c) => c.endsWith(".md")).map((c) => conteudo(commit, c))
    .filter((t) => campo(t, "PR") === String(pr) && sessaoInteira(sessaoDe(t)) === sessao);
  if (deste("revisao/feitas").length || deste("revisao/registros").length) throw new Error(`esta sessão revisou o #${pr}; a ação privilegiada sobre ele é de outra (condição 3)`);
  if (deste("fila/feitas").some((t) => campo(t, "Resultado") === "enfileirado")) throw new Error(`esta sessão enfileirou o #${pr}; a ação privilegiada sobre ele é de outra (condição 3)`);
  const c = commitsDoPr(pr);
  if (!c) throw new Error(`os commits do #${pr} NÃO FORAM CONFERIDOS agora; nada foi feito (condição 3)`);
  if (c.sessoes.has(sessao)) throw new Error(`esta sessão escreveu commits no #${pr}; a ação privilegiada sobre ele é de outra (condição 3)`);
}

/** As linhas que todo registro privilegiado leva, e o aviso a todos no mesmo commit. */
function linhasPrivilegio(p) {
  return [`Pedido: ${p.pedido}`, `Identificador do pedido: ${p.idPedido}`, ...(p.reserva ? [`Reserva: ${p.reserva}`] : [])];
}
function avisoPrivilegio({ eu, assunto, p, agora }) {
  return montarMensagem({ de: eu, para: "todos", assunto, agora,
    texto: [`${assunto}.`, ...linhasPrivilegio(p), `Sessão que agiu: ${p.s.id}`, "Desligar continua livre para todos (set-switch --off)."].join("\n") }).novos;
}

/** Um "OFF" vale sempre; um "ON" só vale como registro privilegiado (privilegioValido). */
export function ligacaoValida(estado, por, texto) {
  if (estado !== "ON") return true;
  return privilegioValido(texto, por);
}

export function chave(nome, commit = buscar(), agora = new Date()) {
  // Passo 3: vale o registro do commit mais recente; e desligado prevalece: um ON não liga enquanto houver um OFF com
  // instante declarado igual ou posterior ao dele, nem com o próprio instante no futuro.
  const ord = ordem(commit);
  const lista = arquivos(commit, `chaves/${nome}`).map((c) => ({ c, t: Number(c.split("/").pop().split("-")[0]), i: ord.get(c)?.i ?? -1 }))
    .filter((x) => Number.isFinite(x.t)).sort((a, b) => a.i - b.i || a.t - b.t || a.c.localeCompare(b.c));
  if (!lista.length) return { ligada: false, por: null, quando: null, motivo: "" };
  const { c: ultimo, t } = lista[lista.length - 1];
  const texto = conteudo(commit, ultimo);
  const [estado, por, ...resto] = texto.split("\n");
  const motivo = resto.filter((l) => !/^(Sessão|Pedido|Identificador do pedido|Reserva): /.test(l)).join(" ").trim();
  if (!ligacaoValida(estado, por, texto)) return { ligada: false, por, quando: new Date(t), motivo: `ON IGNORADO: sem a sessão nomeada e o pedido do coordenador (${motivo})` };
  if (estado === "ON" && noFuturo(new Date(t), agora)) return { ligada: false, por, quando: new Date(t), motivo: `ON IGNORADO: instante no futuro (${motivo})` };
  // Um OFF adiantado mais de FUTURO_MIN em relação ao commit que o gravou vale só da hora desse commit: um relógio errado
  // não segura o interruptor desligado por dias (notas do Claude 5 ibqho e do Claude 4 Z no #5055). Dentro da folga, o
  // instante declarado vale, e desligado prevalece.
  const instanteOff = (x) => { const feito = ord.get(x.c)?.t; return feito !== undefined && x.t - feito > FUTURO_MIN * 60000 ? feito : x.t; };
  if (estado === "ON" && lista.some((x) => x.c !== ultimo && instanteOff(x) >= t && conteudo(commit, x.c).split("\n")[0] === "OFF")) {
    return { ligada: false, por, quando: new Date(t), motivo: `ON IGNORADO: há um OFF com instante igual ou posterior; desligado prevalece (${motivo})` };
  }
  return { ligada: estado === "ON", por, quando: new Date(t), motivo };
}

export function mudarChave({ nome, eu, ligar, motivo = "", pedido = "", dono = "", agora = new Date() }) {
  if (!CHAVES.includes(nome)) throw new Error(`interruptor desconhecido: ${nome} (existem: ${CHAVES.join(", ")})`);
  if (!String(motivo).trim()) throw new Error("--reason é obrigatório: diga por que liga ou desliga");
  const caminho = `chaves/${nome}/${agora.getTime()}-${slug(eu)}-${randomBytes(2).toString("hex")}`;
  if (!ligar) {
    acrescentar({ [caminho]: `OFF\n${eu}\n${String(motivo).trim()}\nSessão: ${linhaSessao()}\n` }, `${eu}: interruptor ${nome} desligado`);
    return;
  }
  const p = conferirPrivilegio({ eu, acao: "liga um interruptor", comando: "set-switch", alvo: nome, pedido, dono, agora });
  acrescentar({
    [caminho]: [`ON`, eu, String(motivo).trim(), ...linhasPrivilegio(p), `Sessão: ${linhaSessao()}`, ""].join("\n"),
    ...avisoPrivilegio({ eu, assunto: `interruptor ${nome} LIGADO por ${eu}`, p, agora }),
  }, `${eu}: interruptor ${nome} ligado`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Registro de revisão feita fora de um pedido do correio (item 2, OWNER-20261121-1749). O comentário no PR continua sendo
// a única prova da revisão para FQ (1), RQ e CV (CO (c)); o registro serve só para tirar a família da fila daquele head e
// para avisos. Vale só para o head registrado. Fica NÃO CONFERIDO: sem o link conferido no GitHub, com head diferente do
// atual, ou gravado por sessão não identificada, de família desconhecida ou de outra família que a do nome; nesses
// últimos casos ele não tira ninguém da fila sozinho, até o coordenador confirmar (R3).
// ---------------------------------------------------------------------------------------------------------------------
const LINK_REVISAO = (pr) => new RegExp(`^https://github\\.com/solrenning-llc/marktmorgen/pull/${pr}#(issuecomment|pullrequestreview)-(\\d+)$`);

/** Confere no GitHub (API REST, pelo gh) que o link é um comentário ou revisão deste PR que cita o head. null = não conferido. */
// Passo 6 (A15): o comentário precisa trazer o veredito dado e vir de quem trabalha no repositório.
const QUEM_TRABALHA = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
export function conferirLink(link, pr, sha, resultado = null) {
  if (testeLigado("CORREIO_SEM_GH")) return null;
  const m = LINK_REVISAO(pr).exec(link);
  if (!m) return { ok: false, motivo: "link fora do formato" };
  try {
    const rota = m[1] === "issuecomment" ? `repos/solrenning-llc/marktmorgen/issues/comments/${m[2]}` : `repos/solrenning-llc/marktmorgen/pulls/${pr}/reviews/${m[2]}`;
    const saida = execFileSync("gh", ["api", rota, "--jq", "[.html_url, (.body // \"\"), (.commit_id // \"\"), (.author_association // \"\")] | @json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
    const [url, corpo, commitId, associacao] = JSON.parse(saida.trim()); // o gh imprime o texto do @json sem aspas: uma camada só
    if (!String(url).includes(`/pull/${pr}`)) return { ok: false, motivo: "o link não é deste PR" };
    const curto = String(sha).slice(0, 10);
    if (!String(corpo).includes(curto) && !String(commitId).startsWith(curto)) return { ok: false, motivo: `o comentário não cita o head ${curto}` };
    // O veredito vem da primeira linha do comentário, onde as revisões daqui o escrevem, e sem o veredito oposto nela:
    // uma revisão CHANGES que diz mais abaixo "faltam 2 READY" não confere um registro READY (LEVE do Claude 2 lpgvy no #5113).
    const primeira = String(corpo).split(/\r?\n/).find((l) => l.trim()) ?? "";
    const oposto = resultado === "READY" ? "CHANGES" : "READY";
    if (resultado && (!new RegExp(`\\b${resultado}\\b`).test(primeira) || new RegExp(`\\b${oposto}\\b`).test(primeira))) return { ok: false, motivo: `o comentário não traz o veredito ${resultado} na primeira linha` };
    if (!QUEM_TRABALHA.has(String(associacao))) return { ok: false, motivo: `o comentário não é de quem trabalha no repositório (${associacao || "autor desconhecido"})` };
    return { ok: true, motivo: "" };
  } catch {
    return null;
  }
}

/**
 * A família revisora de um comentário com veredito neste head, ou null. O head (os 10 primeiros caracteres) e o veredito
 * (READY ou CHANGES) ficam nas duas primeiras linhas com texto; a revisora é a primeira família citada na primeira linha,
 * ou, se ela não cita nenhuma, na segunda, antes ou depois da palavra "review" ("Focal review #N @head — READY — Claude 5
 * ibuF", "Codex N1 CHANGES (transcrito por Claude 5)"; revisão do Claude 5 ibuF no #5141). As famílias citadas depois dela
 * (quem transcreveu, quem tem commits, a quem se responde) não contam, e um pedido ou uma marca ("re-review needed",
 * "review needed", CLAIMED, UNCLAIMED, HOLD, "fila #N") não é revisão: o "This answers Claude 1 DKvY's CHANGES" do #5135
 * não tira o Claude 1 da fila que a nova revisão pede (revisão do Claude 1 E no #5141).
 * O veredito fica na primeira linha, ou na segunda quando a primeira é o cabeçalho de uma revisão; a nota do autor
 * ("Fixed/Fixes/Corrigido/Resolved/This answers/Note on ...") também não é revisão (revisão do Claude 5 ibqho no #5141,
 * comentário 7085420176).
 */
export function revisoraDoComentario(corpo, curto) {
  const linhas = String(corpo ?? "").split(/\r?\n/).filter((l) => l.trim()).slice(0, 2);
  // Uma contagem de vereditos ("1 of 2 READY", "2 de 2 READY") não é veredito: sai do texto antes da leitura, e o
  // comentário vale pelo que sobra (revisões do Claude 5 ibqho e do Claude 4 AC no #5145).
  const semContagem = (t) => t.replace(/\b\d+\s+(?:of|de)\s+\d+\s+(?:READY|CHANGES)\b/gi, "");
  const [l1 = "", l2 = ""] = linhas.map(semContagem), veredito = /\b(READY|CHANGES)\b/;
  if (!curto || !linhas.join("\n").includes(curto)) return null;
  // O veredito na primeira linha, ou na segunda quando a primeira é o cabeçalho de uma revisão ("Independent review
  // (Codex G) of head X" e "Verdict: CHANGES"); a nota do autor que cita "READY or CHANGES" mais abaixo não é revisão.
  const inicio = l1.replace(/^[\s*>_#`-]+/, "");
  // A segunda linha também vale quando a primeira começa pelo nome da família ("Claude 4 2Wb — #5143 @head" e "READY:
  // tests pass"; LEVE do Claude 5 ibqho no #5141).
  // Com o cabeçalho de uma revisão (a palavra "review"), o veredito pode estar em qualquer parte da segunda linha; com
  // só o nome da família no começo da primeira, a segunda precisa começar pelo veredito sozinho, seguido de pontuação ou
  // do fim da linha ("READY: tests pass", "READY (0 findings)", "Verdict: CHANGES"), para que uma linha de situação
  // seguida de um "CHANGES requested by ..." não conte (LEVE do Claude 5 ibqho no #5145).
  const linha2Veredito = /^[\s*>_`-]*(?:verdict\s*:?\s*\**\s*)?(READY|CHANGES)\b\**\s*(?:$|[:(—–,.;-])/i.test(l2);
  const cabecalho = (/\breview\b/i.test(l1) && veredito.test(l2)) || (/^(Claude \d+|Codex)\b/i.test(inicio) && linha2Veredito);
  if (!veredito.test(l1) && !cabecalho) return null;
  if (/^(re-?review needed|review needed|claimed\b|unclaimed\b|hold\b|fila #|fix(?:ed|es)?\b|corrigid|resolved\b|this answers|answer\b|note on\b)/i.test(inicio)) return null;
  // Uma linha de situação que só conta vereditos ("Claude 1 coord: #N @head, 1 of 2 READY") fica sem veredito depois de
  // semContagem e não é revisão (LEVE do Claude 4 Z no #5141).
  for (const l of linhas) {
    const m = /\b(Claude \d+|Codex)\b/i.exec(l);
    if (m) return familia(m[1]);
  }
  return null;
}

/**
 * As famílias que deram veredito (READY ou CHANGES) neste head só nos comentários e revisões do PR, fora do correio
 * (coordenador, ce2d: no #5118, claim-enqueue entregou duas vezes o pedido a quem tinha revisado o head no PR). Vale o
 * comentário de quem trabalha no repositório, com a revisora lida por revisoraDoComentario. null = NÃO CONFERIDO (o GitHub não respondeu); quem chama não entrega nada nesse caso (passo 4).
 */
const vereditosNoPr = new Map();
export function revisoresNoPr(pr, sha) {
  if (testeLigado("CORREIO_SEM_GH")) return new Set();
  if (!/^\d+$/.test(String(pr ?? "")) || !sha) return null;
  const curto = String(sha).slice(0, 10), chaveCache = `${pr}@${curto}`;
  if (vereditosNoPr.has(chaveCache)) return vereditosNoPr.get(chaveCache);
  const f = new Set();
  try {
    for (const rota of [`repos/solrenning-llc/marktmorgen/issues/${pr}/comments`, `repos/solrenning-llc/marktmorgen/pulls/${pr}/reviews`]) {
      const saida = execFileSync("gh", ["api", "--paginate", rota, "--jq", '.[] | [(.body // ""), (.author_association // "")] | @json'],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
      for (const linha of saida.split("\n").filter((l) => l.trim())) {
        const [corpo, associacao] = JSON.parse(linha);
        if (!QUEM_TRABALHA.has(String(associacao))) continue;
        const quem = revisoraDoComentario(corpo, curto);
        if (quem) f.add(quem);
      }
    }
  } catch {
    return null;
  }
  vereditosNoPr.set(chaveCache, f);
  return f;
}

export function registrarRevisao({ eu, pr, sha, resultado, link, agora = new Date() }) {
  if (!chave("record-review").ligada) throw new Error("o registro de revisão está DESLIGADO (interruptor record-review); só o coordenador o liga");
  if (!/^\d+$/.test(String(pr ?? ""))) throw new Error("--pr é obrigatório (o número do PR)");
  if (!/^[0-9a-f]{10,40}$/.test(String(sha ?? ""))) throw new Error("--sha é obrigatório (o head revisado, 10 a 40 caracteres)");
  if (!/^(READY|CHANGES)$/.test(String(resultado ?? ""))) throw new Error("--result deve ser READY ou CHANGES");
  if (!LINK_REVISAO(pr).test(String(link ?? ""))) throw new Error(`--link é obrigatório: o endereço do comentário da revisão no PR #${pr} (https://github.com/solrenning-llc/marktmorgen/pull/${pr}#issuecomment-N)`);
  const atual = headAtual(pr);
  const lk = conferirLink(link, pr, sha, resultado);
  const carimbo = agora.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const id = `${carimbo}-${slug(eu)}-${randomBytes(2).toString("hex")}`;
  const corpo = [`Tipo: registro de revisão`, `PR: ${pr}`, `Head: ${sha}`, `Resultado: ${resultado}`, `Por: ${eu}`, `Link: ${link}`,
    `Head atual na hora: ${atual ? atual.slice(0, 10) : "NÃO CONFERIDO"}`,
    `Link conferido: ${lk ? (lk.ok ? "sim" : `NÃO (${lk.motivo})`) : "NÃO CONFERIDO"}`,
    `Data (UTC): ${agora.toISOString().slice(0, 16).replace("T", " ")}`, `Id: ${id}`, ""].join("\n");
  acrescentar({ [`revisao/registros/${id}.md`]: corpo }, `Registro de revisão #${pr} @${String(sha).slice(0, 10)}: ${resultado} (${eu})`);
  return id;
}

export function confirmarRegistro({ eu, id, motivo = "", pedido = "", dono = "", agora = new Date() }) {
  const commit = buscar();
  const p = conferirPrivilegio({ eu, acao: "confirma um registro de revisão", comando: "confirm-review-record", alvo: String(id), pedido, dono, agora, commit });
  if (!/^[0-9A-Za-z-]+$/.test(String(id ?? "")) || !arquivos(commit, `revisao/registros/${id}.md`).length) throw new Error(`registro não encontrado: ${id}`);
  const pr = campo(conteudo(commit, `revisao/registros/${id}.md`), "PR");
  conferirDistancia(pr, p.s.id, commit);
  acrescentar({
    [`revisao/confirmados/${id}`]: [eu, agora.toISOString(), String(motivo).trim(), ...linhasPrivilegio(p), `Sessão: ${linhaSessao()}`, ""].join("\n"),
    ...avisoPrivilegio({ eu, assunto: `registro de revisão ${id} (#${pr}) confirmado por ${eu}`, p, agora }),
  }, `${eu} confirmou o registro ${id}`);
}

/** Os registros de revisão de um PR, com o que não foi conferido e se tiram a família da fila daquele head. */
export function registros(pr, commit = buscar(), atual = undefined) {
  const ligada = chave("record-review", commit).ligada;
  // Uma confirmação só vale como registro privilegiado: a sessão nomeada (ou a reserva) e o pedido do coordenador.
  const confirmados = new Set(arquivos(commit, "revisao/confirmados").filter((c) => {
    const texto = conteudo(commit, c);
    return privilegioValido(texto, texto.split("\n")[0]);
  }).map((c) => c.split("/").pop()));
  const head = atual === undefined ? headAtual(pr) : atual;
  return arquivos(commit, "revisao/registros").filter((c) => c.endsWith(".md")).map((c) => {
    const texto = conteudo(commit, c), id = idDe(c);
    if (campo(texto, "PR") !== String(pr)) return null;
    const sha = campo(texto, "Head"), por = campo(texto, "Por"), sess = sessaoDe(texto);
    const faltas = [];
    if (!sess?.identificada) faltas.push("sessão não identificada");
    else if (!sess.familia) faltas.push("família desconhecida");
    else if (sess.familia !== familia(por)) faltas.push(`gravado por sessão da família ${sess.familia}, não de ${familia(por)}`);
    const identidadeOk = !faltas.length;
    if (campo(texto, "Link conferido") !== "sim") faltas.push(`link ${campo(texto, "Link conferido") || "NÃO CONFERIDO"}`);
    if (!head) faltas.push("head atual NÃO CONFERIDO");
    else if (!(head.startsWith(sha.slice(0, 10)) || sha.startsWith(head.slice(0, 10)))) faltas.push(`head ${sha.slice(0, 10)} diferente do atual ${head.slice(0, 10)}`);
    const confirmado = confirmados.has(id);
    return { id, pr: String(pr), sha, resultado: campo(texto, "Resultado"), por, link: campo(texto, "Link"), faltas, confirmado,
      excluiDaFila: ligada && (identidadeOk || confirmado) };
  }).filter(Boolean);
}

/** Registra um pedido de revisão ou de fila. */
export function pedir({ tipo, de, pr, sha, texto = "", para = "", exclui = "", commits = undefined, agora = new Date() }) {
  if (!TIPOS.has(tipo)) throw new Error(`tipo desconhecido: ${tipo}`);
  if (!/^\d+$/.test(String(pr ?? ""))) throw new Error("--pr é obrigatório (o número do PR)");
  if (!/^[0-9a-f]{10,40}$/.test(String(sha ?? ""))) throw new Error("--sha é obrigatório (o head exato, 10 a 40 caracteres)");
  // O mesmo PR no mesmo head ainda aberto não entra duas vezes (achado do Claude 1: #3346, #3447 e #3474 repetidos).
  const repetido = pedidos(tipo, agora).find((x) => x.estado !== "feito" && x.pr === String(pr) && sha && x.sha.startsWith(String(sha).slice(0, 10)) && String(sha).startsWith(x.sha.slice(0, 10)));
  if (repetido) throw new Error(`já existe pedido de ${tipo} aberto para #${pr} @${repetido.sha}: ${repetido.id}`);
  const carimbo = agora.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const id = `${carimbo}-${slug(de)}-${randomBytes(2).toString("hex")}`;
  let ramo = ramoDoHead(sha, pr);
  // Passo 4: o pedido grava o head inteiro (40 caracteres), lido agora de fonte que vale: o ramo do PR, ou um repositório
  // local. Um head velho não é ponta de ramo nenhum, então o ramo é achado pela referência atual do PR; e, no GitHub, sem
  // ramo achado, nada é pedido, porque um pedido assim nunca seria entregue e seguraria o primeiro lugar da fila (MÉDIO
  // do Claude 5 ibuF no #5069).
  let shaFinal = String(sha);
  if (!testeLigado("CORREIO_SEM_COMMITS")) {
    if (!ramo) { const ref = headDoPr(pr, null).sha; if (ref) ramo = ramoDoHead(ref, pr); }
    const h = headDoPr(pr, ramo);
    if (!h.sha) throw new Error(`o head atual de #${pr} NÃO FOI CONFERIDO agora; nada foi pedido (passo 4: nada NÃO CONFERIDO segue); tente de novo`);
    if (h.fonte === "ref") throw new Error(`o ramo de #${pr} não foi achado (só a referência refs/pull/${pr}/head, que pode atrasar, foi lida, e nenhum ramo tem a ponta nela); nada foi pedido; tente de novo em alguns minutos e confira se o ramo do PR existe e é um só`);
    if (!(h.sha.startsWith(shaFinal) || shaFinal.startsWith(h.sha))) throw new Error(`${shaFinal.slice(0, 10)} não é o head atual de #${pr} (${h.sha.slice(0, 10)}); peça com o head que foi revisado e está no PR`);
    shaFinal = h.sha;
  }
  sha = shaFinal;
  const corpo = [`Tipo: ${tipo === "fila" ? "fila" : "revisão"}`, `PR: ${pr}`, `Head: ${sha}`, `Autor: ${de}`, ...(ramo ? [`Ramo: ${ramo}`] : []), ...(para ? [`Preferência: ${para}`] : []),
    ...(() => {
      // Revisão: as famílias com commits no PR ficam de fora sozinhas, além das que o autor excluiu.
      const lidas = commits ?? null;
      // Fila: quem revisou este head pelo correio fica de fora sozinho (FQ (1)); revisões feitas fora do correio, o autor põe com --exclude.
      const revisores = tipo === "fila" ? revisoresDoHead(pr, sha) : new Set();
      // Commits no PR excluem só da revisão (CO (e)); na fila, a FQ (1) exclui só o autor e quem revisou o head
      // (coordenador, 21/11/2026, 19h41 UTC).
      const todas = new Set([...String(exclui).split(",").map((n) => n.trim()).filter(Boolean).map(familia), ...(tipo === "revisao" ? lidas?.familias ?? [] : []), ...revisores]);
      todas.delete(familia(de));
      return [...(todas.size ? [`Exclui: ${[...todas].sort().join(", ")}`] : []),
        lidas ? `Commits de: ${[...lidas.familias].sort().join(", ") || "nenhuma família conhecida"}` : "Commits de: não conferido (o PR não pôde ser lido)",
        ...(tipo === "revisao" ? [`Linhas fora dos testes: ${Number.isInteger(lidas?.linhas) ? lidas.linhas : "não conferido"}`] : []),
        ...(lidas?.desconhecidas.size ? [`Sem família conhecida: ${[...lidas.desconhecidas].join(", ")}`] : [])];
    })(),
    `Data (UTC): ${agora.toISOString().slice(0, 16).replace("T", " ")}`,
    `Id: ${id}`, "", String(texto).trim(), ""].join("\n");
  acrescentar({ [`${tipo}/pedidos/${id}.md`]: corpo }, `Pedido de ${tipo} #${pr} @${sha} por ${de}`);
  return id;
}

/**
 * Se `eu` pode pegar este pedido de revisão aberto agora: outra família, que não o devolveu nem foi excluída, e fora da
 * preferência do autor (vale só enquanto o preferido tem cota e por até 30 minutos). A vigia usa a mesma regra, para não
 * acordar ninguém por um pedido que ele não pode pegar.
 */
function revisaoParaMim(p, eu, agora, c) {
  if (p.estado !== "aberto" || p.familia === familia(eu) || p.devolveram.has(familia(eu))) return false;
  if (campo(p.texto, "Exclui").split(", ").includes(familia(eu))) return false;
  // Cota baixa (OWNER-20261122-0121-MAIL-AVAILABILITY, item 2): revisão longa não vai a quem tem COTA_BAIXA% ou menos.
  if (c[familia(eu)]?.baixa && revisaoLonga(p)) return false;
  const pref = campo(p.texto, "Preferência");
  // A preferência cai na hora quando o preferido está sem cota (declarada ou sem sinal, item 1) ou, numa revisão longa,
  // com cota baixa; senão vale TOMADA_MIN minutos, para qualquer família, inclusive o Codex (item 3).
  if (!pref || familia(pref) === familia(eu) || c[familia(pref)]?.sem || (c[familia(pref)]?.baixa && revisaoLonga(p))) return true;
  const quando = dataDe(p.id);
  return quando ? (agora - quando) / 60000 >= TOMADA_MIN : true;
}

/**
 * Pega o próximo pedido que `eu` pode atender. Revisão: o mais antigo aberto de outra família. Fila: só o mais antigo
 * ainda aberto, de qualquer família, e nenhum enquanto outro estiver tomado; se ele for da família de `eu`, ninguém
 * dessa família o pega e espera outra família, sem que nenhum mais novo passe na frente.
 */
export function pegar({ tipo, eu, agora = new Date() }) {
  const lista = pedidos(tipo, agora);
  let alvo;
  if (tipo === "fila") {
    if (lista.some((p) => p.estado === "tomado")) {
      const t = lista.find((p) => p.estado === "tomado");
      return { espera: `#${t.pr} já está sendo enfileirado por ${t.tomadoPor}; a fila anda um de cada vez` };
    }
    alvo = lista.find((p) => p.estado === "aberto");
    if (alvo && alvo.familia === familia(eu)) return { espera: `o primeiro da fila, #${alvo.pr}, é da sua família; outra família o enfileira` };
    // Quem devolveu o primeiro da fila, ou foi excluído no pedido, não o pega de volta; ele continua primeiro (achado do Claude 4 3rC).
    if (alvo && (alvo.devolveram.has(familia(eu)) || campo(alvo.texto, "Exclui").split(", ").includes(familia(eu)) || revisoresDoHead(alvo.pr, alvo.sha).has(familia(eu)))) return { espera: `o primeiro da fila, #${alvo.pr}, foi devolvido ou excluído para a sua família; outra família o enfileira` };
    // Commits no PR não impedem enfileirar: a FQ (1) exclui só a família do autor e quem revisou o head; a regra de não ter
    // commits é da revisão (CO (e)). Correção do coordenador, 21/11/2026, 19h41 UTC (antes, achado do Claude 4 3rC).
    // HOLD de qualquer um, ou CLAIMED de outra família, segura o primeiro da fila; os mais novos esperam atrás dele.
    // ce2d: quem deu veredito neste head só no PR também não o enfileira; sem ler o PR, ele não é entregue.
    if (alvo) {
      const noPr = revisoresNoPr(alvo.pr, alvo.sha);
      if (noPr === null) return { espera: `as revisões escritas no #${alvo.pr} não puderam ser conferidas agora (NÃO CONFERIDO); a fila espera; tente de novo` };
      if (noPr.has(familia(eu))) return { espera: `o primeiro da fila, #${alvo.pr}, tem veredito da sua família neste head no PR; outra família o enfileira (FQ (1), ce2d)` };
    }
    const marca = alvo ? estadoPr(alvo.pr, agora) : null;
    if (marca?.ativo && (marca.acao === "HOLD" || familia(marca.por) !== familia(eu))) {
      return { espera: `o primeiro da fila, #${alvo.pr}, está com ${marca.acao} de ${marca.por}${marca.motivo ? ` (${marca.motivo})` : ""}; a fila espera até alguém liberar, ou até o autor (ou quem pôs o HOLD) retirar o pedido com cancel-enqueue ${alvo.id}` };
    }
  } else {
    const c = cotas(agora);
    // Na hora de pegar, confere de novo os commits do PR (o head pode ter mudado): se a família de `eu` tem commit nele,
    // devolve sozinha com o motivo, para ela não receber esse pedido de novo, e segue para o próximo.
    for (const p of lista.filter((x) => revisaoParaMim(x, eu, agora, c))) {
      // ce2d: quem deu veredito neste head só no PR também devolve, com o motivo; sem ler o PR, nada é entregue.
      const noPr = revisoresNoPr(p.pr, p.sha);
      if (noPr === null) return { espera: `as revisões escritas no #${p.pr} não puderam ser conferidas agora (NÃO CONFERIDO); nada foi pegado; tente de novo` };
      if (noPr.has(familia(eu))) {
        const carimboV = agora.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
        try {
          acrescentar({ [`${tipo}/tomadas/${p.id}/${p.proximaTomada}`]: `${carimboV}-${slug(eu)}-${randomBytes(2).toString("hex")}\n${eu}\nDEVOLVIDO\na família ${familia(eu)} deu veredito neste head no PR (conferido pela ferramenta, ce2d)\n` }, `${eu} devolveu revisao #${p.pr}: veredito no PR`);
        } catch {}
        continue;
      }
      const lidas = commitsDoPr(p.pr);
      if (lidas?.familias.has(familia(eu))) {
        const carimboD = agora.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
        try {
          acrescentar({ [`${tipo}/tomadas/${p.id}/${p.proximaTomada}`]: `${carimboD}-${slug(eu)}-${randomBytes(2).toString("hex")}\n${eu}\nDEVOLVIDO\na família ${familia(eu)} tem commits no PR (conferido pela ferramenta)\n` }, `${eu}: #${p.pr} tem commits da família, devolvido`);
        } catch {}
        continue;
      }
      alvo = p;
      break;
    }
  }
  if (!alvo) return { espera: "nenhum pedido aberto para você" };
  // Fila: o head é lido antes da tomada. Com só a referência refs/pull/N/head do GitHub, que pode atrasar, e um head
  // diferente do pedido, o pedido não é entregue nem recusado: continua primeiro da fila, sem tomada, até o head poder
  // ser conferido (revisão do Claude 4 3Kc no repo-id-transfer-test#2; dono, OWNER-20261121-1904, passo 4: nada NÃO
  // CONFERIDO segue).
  const ramoPedido = tipo === "fila" ? campoCabecalho(alvo.texto, "Ramo") || null : null;
  const { sha: atual, fonte } = tipo === "fila" ? headDoPr(alvo.pr, ramoPedido) : { sha: null, fonte: null };
  const pedidoSha = String(alvo.sha);
  const diferente = Boolean(atual) && !(atual.startsWith(pedidoSha) || pedidoSha.startsWith(atual));
  if (tipo === "fila" && diferente && fonte === "ref") {
    return { espera: `head de #${alvo.pr} não conferível agora: o pedido não traz o ramo, e a referência refs/pull/${alvo.pr}/head, que pode atrasar, mostra ${atual.slice(0, 10)} em vez de ${pedidoSha.slice(0, 10)}; o pedido continua primeiro da fila, sem tomada; tente de novo em alguns minutos` };
  }
  // Passo 4: o que a ferramenta não consegue conferir agora não segue. Sem o head lido de fonte que vale, sem saber se o
  // PR já está na fila de integração ou no main, ou sem o conflito conferido, o pedido não é entregue: continua primeiro
  // da fila, sem tomada.
  const sgFila = tipo === "fila" ? situacaoNoGitHub(alvo.pr, ramoPedido) : null;
  const cfFila = tipo === "fila" && !(sgFila?.naFila || sgFila?.noMain) ? conflitosDoPr(alvo.pr, ramoPedido) : null;
  if (tipo === "fila") {
    const faltas = [];
    if (!atual) faltas.push("o head atual do PR");
    else if (fonte === "ref") faltas.push(`o head pelo ramo do PR (o pedido não traz o ramo; só a referência refs/pull/${alvo.pr}/head, que pode atrasar, foi lida; o autor retira este pedido com cancel-enqueue e pede de novo, para gravar o ramo; sem retirar, o pedido novo é recusado como repetido)`);
    if (!sgFila) faltas.push("se o PR já está na fila de integração ou no main");
    else if (!(sgFila.naFila || sgFila.noMain) && !cfFila) faltas.push("o conflito com o main e com a fila de integração");
    if (faltas.length) return { espera: `NÃO CONFERIDO agora: ${faltas.join("; ")}. O pedido continua primeiro da fila, sem tomada (passo 4: nada NÃO CONFERIDO segue); tente de novo em alguns minutos` };
  }
  const carimbo = agora.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const marca = `${carimbo}-${slug(eu)}-${randomBytes(2).toString("hex")}`;
  // O mesmo caminho para quem chega junto: só o primeiro grava; o envio recusa o segundo, que recebe "já tomado".
  try {
    acrescentar({ [`${tipo}/tomadas/${alvo.id}/${alvo.proximaTomada}`]: `${marca}\n${eu}\n` }, `${eu} pegou ${tipo} #${alvo.pr}`);
  } catch (erro) {
    if (/já existe no correio/.test(String(erro.message ?? erro))) return { espera: `#${alvo.pr} acabou de ser tomado por outro agente; rode de novo` };
    throw erro;
  }
  if (tipo === "fila") {
    // O head do pedido tem de ser o head atual do PR (achado A do Claude 5, C5-20261121-1734): as conferências abaixo leem
    // o head atual, que pode ter mudado depois do pedido e não ter sido revisado.
    // Só recusa com o head lido de fonte confiável (a API, ou um repositório local); com só a referência do GitHub, que
    // pode atrasar, o head fica NÃO CONFERIDO e quem enfileira confere à mão.
    if (diferente && fonte !== "ref") {
      concluir({ tipo, eu, id: alvo.id, resultado: "recusado", agora,
        texto: `Recusado pela ferramenta ao pegar: o head de #${alvo.pr} mudou de ${pedidoSha.slice(0, 10)} (o do pedido) para ${atual.slice(0, 10)}. As revisões e as verificações valem para um head só: confira o head novo e peça de novo com ele.` });
      return { espera: `o head de #${alvo.pr} mudou de ${pedidoSha.slice(0, 10)} para ${atual.slice(0, 10)}; recusado e o autor (${alvo.autor}) foi avisado; rode de novo para o próximo` };
    }
    const naoConferido = [];
    if (!atual) naoConferido.push("o head atual do PR");
    else if (fonte === "ref") naoConferido.push(`o head atual do PR pelo ramo (o pedido não traz o ramo; só a referência refs/pull/${alvo.pr}/head, que pode atrasar, foi lida)`);
    const sg = sgFila;
    if (sg?.naFila || sg?.noMain) {
      const onde = sg.noMain ? "já entrou no main" : "já está na fila de integração do GitHub";
      concluir({ tipo, eu, id: alvo.id, resultado: "enfileirado", agora, conferir: false,
        texto: `Concluído pela ferramenta ao pegar: #${alvo.pr} ${onde}${alvo.ultimaTomadaPor ? ` (a tomada anterior era de ${alvo.ultimaTomadaPor})` : ""}. Nada foi enfileirado de novo.` });
      return { espera: `#${alvo.pr} ${onde}; concluído como enfileirado, sem enfileirar de novo; rode de novo para o próximo` };
    }
    const cf = cfFila;
    if (cf?.conflitos.length) {
      const motivo = `Recusado pela ferramenta ao pegar: #${alvo.pr} @${alvo.sha} conflita com ${cf.conflitos.join(", ")} ` +
        `(git merge-tree contra o main e os ${cf.grupos} grupo(s) da fila de integração). Junte o main depois que ` +
        `${cf.conflitos.filter((c) => c !== "main").join(", ") || "o conflito for resolvido"} entrar, mantendo os dois lados (AC (b)), e peça de novo.`;
      concluir({ tipo, eu, id: alvo.id, resultado: "recusado", texto: motivo, agora });
      return { espera: `#${alvo.pr} conflita com ${cf.conflitos.join(", ")}; recusado e o autor (${alvo.autor}) foi avisado; rode de novo para o próximo` };
    }
    if (!cf) naoConferido.push("o conflito com o main e com a fila de integração");
    const feito = [atual && !diferente && fonte !== "ref" ? `head ${atual.slice(0, 10)} igual ao do pedido (${fonte === "ramo" ? `pelo ramo ${ramoPedido}` : "pela referência"})` : null, cf ? `sem conflito com o main e com os ${cf.grupos} grupo(s) da fila de integração` : null].filter(Boolean);
    return { pedido: alvo, aviso: `${feito.join("; ") || "nada conferido"}${naoConferido.length ? `. NÃO CONFERIDO (confira à mão): ${naoConferido.join("; ")}` : ""}. A ferramenta não confere as 9 verificações, as revisões, os achados, o SIM de workflow nem a vez de custo: isso é de quem enfileira (FQ (1))` };
  }
  return { pedido: alvo };
}

/**
 * Devolve na hora um pedido que `eu` tomou e não pode atender (por exemplo, tem commits no PR: FQ (2) e RV). O pedido
 * volta a ser o primeiro aberto, e a família de `eu` não o pega de novo. O autor recebe o aviso.
 */
export function devolver({ tipo, eu, id, motivo = "", agora = new Date() }) {
  const p = pedidos(tipo, agora).find((x) => x.id === id);
  if (!p) throw new Error(`pedido não encontrado: ${id}`);
  if (p.estado !== "tomado" || familia(p.tomadoPor) !== familia(eu)) throw new Error(`o pedido ${id} não está tomado pela sua família`);
  // Só a sessão que pegou devolve: outra sessão da mesma família desfaria a tomada de uma irmã (caso real: #3929, 21/11/2026).
  if (slug(p.tomadoPor) !== slug(eu)) throw new Error(`o pedido ${id} foi pegado por ${p.tomadoPor}; só essa sessão o devolve`);
  const carimbo = agora.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const marca = `${carimbo}-${slug(eu)}-${randomBytes(2).toString("hex")}`;
  acrescentar({ [`${tipo}/tomadas/${id}/${p.proximaTomada}`]: `${marca}\n${eu}\nDEVOLVIDO\n${String(motivo).trim()}\n` }, `${eu} devolveu ${tipo} #${p.pr}`);
  enviar({ de: eu, para: p.autor, assunto: `${tipo === "fila" ? "Fila" : "Revisão"} #${p.pr} @${p.sha}: devolvido`, texto: `Devolvido por ${eu}. ${motivo}`.trim(), responde: id, agora });
  return p;
}

/**
 * Renova a tomada viva de quem pegou (sinal de vida): mais um prazo inteiro a partir de agora. Só a própria sessão
 * renova, e só enquanto a tomada vale; vencida, o pedido volta a ser de quem pegar primeiro, na ordem.
 */
export function renovar({ tipo, eu, id, agora = new Date() }) {
  const p = pedidos(tipo, agora).find((x) => x.id === id);
  if (!p) throw new Error(`pedido não encontrado: ${id}`);
  if (p.estado !== "tomado" || slug(p.tomadoPor) !== slug(eu)) {
    throw new Error(`só renova a sessão que tem a tomada viva do pedido ${id}${p.tomadoPor ? ` (hoje: ${p.tomadoPor})` : " (ninguém a tem agora; pegue de novo)"}`);
  }
  const carimbo = agora.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  acrescentar({ [`${tipo}/tomadas/${id}/${p.proximaTomada}`]: `${carimbo}-${slug(eu)}-${randomBytes(2).toString("hex")}\n${eu}\n` }, `${eu} renovou ${tipo} #${p.pr}`);
  return p;
}

/**
 * Liberação de uma tomada travada pelo coordenador (passo 3): ação privilegiada, como ligar um interruptor. A sessão
 * nomeada (ou a reserva, nos três casos) a faz, com o pedido do coordenador da #4932 que cita a id do pedido, nunca num
 * PR que ela escreveu, revisou ou enfileirou; a liberação é avisada a todos no mesmo commit, e a família que tinha a
 * tomada não fica impedida de pegar de novo.
 */
export function liberarTomada({ tipo, eu, id, motivo = "", pedido = "", dono = "", agora = new Date() }) {
  if (!String(motivo).trim()) throw new Error("--reason é obrigatório: diga por que a tomada está travada");
  const commit = buscar();
  const p = pedidos(tipo, agora, commit).find((x) => x.id === id);
  if (!p) throw new Error(`pedido não encontrado: ${id}`);
  const priv = conferirPrivilegio({ eu, acao: "libera uma tomada", comando: "release-take", alvo: String(id), pedido, dono, agora, commit });
  if (p.estado !== "tomado") throw new Error(`o pedido ${id} não está tomado agora (${p.estado}); não há o que liberar`);
  conferirDistancia(p.pr, priv.s.id, commit);
  const carimbo = agora.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const marca = `${carimbo}-${slug(eu)}-${randomBytes(2).toString("hex")}`;
  acrescentar({
    [`${tipo}/tomadas/${id}/${p.proximaTomada}`]: [marca, eu, "LIBERADO", String(motivo).trim(), `Tomada de: ${p.tomadoPor}`, ...linhasPrivilegio(priv), `Sessão: ${linhaSessao()}`, ""].join("\n"),
    ...avisoPrivilegio({ eu, assunto: `tomada do ${tipo === "fila" ? "pedido de fila" : "pedido de revisão"} #${p.pr} (${id}) liberada por ${eu}; estava com ${p.tomadoPor}`, p: priv, agora }),
  }, `${eu} liberou a tomada de ${tipo} #${p.pr}`);
  return p;
}

/**
 * O código da ferramenta fica em tooling/agent-mail/ do main do Marktmorgen, revisado por PR, e o SHA-256 revisado fica
 * em tooling/agent-mail/agent-mail.sha256 (dono, OWNER-20261121-1904-MAIL-TOOL-FIX-ORDER, passo 1); o ramo correio
 * guarda só dados. A cada comando, a ferramenta compara o próprio SHA-256 com o do main, só pelo git, e avisa quando não
 * é a versão revisada, ou quando não conseguiu conferir.
 */
export const ARQUIVO_HASH = "tooling/agent-mail/agent-mail.sha256";
export function hashProprio() {
  return createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
}
export function hashPublicado() {
  const ref = `refs/agent-mail-pr/main-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    // Busca normal, nunca --depth: uma busca rasa tornaria raso o repositório de quem roda a ferramenta (revisão do
    // Claude 1 A no #5044). No clone do Marktmorgen, ela só traz o que falta.
    git(["fetch", "-q", "--no-tags", REPO_PRS, `+refs/heads/main:${ref}`]);
    return /^[0-9a-f]{64}/.exec(git(["show", `${ref}:${ARQUIVO_HASH}`]))?.[0] ?? null; // no clone: o main é público
  } catch {
    return null;
  } finally {
    try { git(["update-ref", "-d", ref]); } catch { /* não foi criada */ }
  }
}
/** Avisa quando a cópia não é a revisada ou não foi conferida; devolve true só quando ela é a revisada, conferida agora. */
function avisarVersao() {
  if (testeLigado("CORREIO_SEM_VERSAO")) return true;
  const publicado = hashPublicado();
  if (!publicado) {
    // A busca do main roda no clone onde a ferramenta está (README, "Instalar e vigiar"): fora de um clone git, diz isso.
    let noClone = true;
    try { git(["rev-parse", "--git-dir"]); } catch { noClone = false; }
    console.error(noClone
      ? "ATENÇÃO: não consegui ler o SHA-256 da versão revisada (main do Marktmorgen); a versão desta cópia NÃO FOI CONFERIDA."
      : "ATENÇÃO: esta pasta não é um clone git, e a conferência da versão roda dentro de um; rode a ferramenta de dentro de qualquer clone git (o do Marktmorgen serve). A versão desta cópia NÃO FOI CONFERIDA.");
    return false;
  }
  if (publicado !== hashProprio()) {
    console.error("ATENÇÃO: esta cópia da ferramenta não é a versão revisada do main do Marktmorgen (SHA-256 diferente); reinstale com o comando de CO (b) do AGENTS.md antes de continuar.");
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Só acrescentar (dono, OWNER-20261121-1904, passo 3). O ramo correio só ganha arquivos: um commit que altera ou apaga um
// arquivo de dados (ou um ramo reescrito, que o conjunto de regras 27091177 já recusa) é um alarme. Os quatro arquivos da
// raiz de antes do passo 1 (o LEIA-ME e as cópias antigas da ferramenta) mudavam com cada versão e ficam fora. A vigia
// confere o que chegou desde a última conferência local, a cada ciclo, e avisa uma vez por alteração; check-append-only
// confere o histórico inteiro.
// ---------------------------------------------------------------------------------------------------------------------
export const RAIZ_HISTORICA = new Set(["LEIA-ME.md", "agent-mail.mjs", "agent-mail.test.mjs", "correio.mjs"]);
export const REF_VERIFICADO = "refs/agent-mail/append-only-checked";

/** { reescrito, problemas }: o que, desde `desde` (ou desde o começo), alterou ou apagou um arquivo de dados. */
export function conferirSoAcrescentar(commit, desde = null) {
  if (!commit) return { reescrito: false, problemas: [] };
  let reescrito = false;
  if (desde) { try { gitC(["merge-base", "--is-ancestor", desde, commit]); } catch { reescrito = true; } }
  const faixa = desde && !reescrito ? `${desde}..${commit}` : commit;
  const problemas = [];
  let atual = "";
  for (const linha of gitC(["log", "--format=%x01%H", "--name-status", "--diff-filter=MDT", "--no-renames", "--diff-merges=first-parent", faixa]).split("\n")) {
    if (linha.startsWith("\x01")) { atual = linha.slice(1); continue; }
    const m = /^([MDT])\t(.+)$/.exec(linha);
    if (m && !RAIZ_HISTORICA.has(m[2])) problemas.push(`${atual.slice(0, 10)} ${m[1] === "D" ? "APAGOU" : "ALTEROU"} ${m[2]}`);
  }
  return { reescrito, problemas };
}

/**
 * Passo 4: a tomada conferida logo antes de enfileirar, presa ao head. Só a sessão que pegou o pedido, com a tomada
 * ainda valendo, e com o head atual do PR lido agora de fonte que vale e igual ao do pedido. Devolve o head inteiro a
 * enfileirar; lança erro em qualquer outro caso.
 */
export function conferirTomada({ eu, id, agora = new Date() }) {
  const p = pedidos("fila", agora).find((x) => x.id === id);
  if (!p) throw new Error(`pedido não encontrado: ${id}`);
  if (p.estado !== "tomado" || slug(p.tomadoPor) !== slug(eu)) throw new Error(`a tomada de ${id} não é desta sessão agora (${p.estado === "tomado" ? `está com ${p.tomadoPor}` : "ninguém a tem"}); não enfileire; pegue de novo com claim-enqueue`);
  const { sha, fonte } = headDoPr(p.pr, campoCabecalho(p.texto, "Ramo") || null);
  if (!sha || fonte === "ref") throw new Error(`o head atual de #${p.pr} NÃO FOI CONFERIDO agora; não enfileire (passo 4: nada NÃO CONFERIDO segue)`);
  if (!(sha.startsWith(p.sha) || p.sha.startsWith(sha))) throw new Error(`o head de #${p.pr} mudou de ${p.sha.slice(0, 10)} (o do pedido) para ${sha.slice(0, 10)}; não enfileire; conclua como recusado (--result declined) para o autor pedir de novo`);
  return { p, head: sha };
}

/** Conclui um pedido tomado: grava o resultado e manda ao autor. */
export function concluir({ tipo, eu, id, resultado, texto = "", agora = new Date(), conferir = true }) {
  const p = pedidos(tipo, agora).find((x) => x.id === id);
  if (!p) throw new Error(`pedido não encontrado: ${id}`);
  if (p.estado === "feito") throw new Error(`pedido já concluído: ${id}`);
  if (familia(eu) === p.familia) throw new Error("revisão e fila são de outra família, nunca da família do autor");
  // Só conclui a família que fez a última tomada (achado do Claude 1, 21/11/2026): ninguém conclui o pedido que outro pegou.
  if (!p.ultimaTomadaPor) throw new Error(`o pedido ${id} não foi pegado; use pegar-${tipo === "fila" ? "fila" : "revisao"} antes de concluir`);
  if (familia(p.ultimaTomadaPor) !== familia(eu)) throw new Error(`o pedido ${id} foi pegado por ${p.ultimaTomadaPor}; só quem pegou conclui`);
  const permitidos = tipo === "fila" ? ["enfileirado", "recusado"] : ["READY", "CHANGES"];
  if (!permitidos.includes(resultado)) throw new Error(`--result deve ser ${permitidos.join(" ou ")}`);
  // Passo 4: "enfileirado" só com a tomada desta sessão e o head conferido agora; o registro grava o head enfileirado.
  const enfileirado = tipo === "fila" && resultado === "enfileirado" && conferir ? conferirTomada({ eu, id, agora }).head : null;
  const corpo = [`Resultado: ${resultado}`, `PR: ${p.pr}`, `Head: ${p.sha}`, ...(enfileirado ? [`Head enfileirado: ${enfileirado}`] : []), `Por: ${eu}`, `Data (UTC): ${agora.toISOString().slice(0, 16).replace("T", " ")}`, "",
    String(texto).trim(), ""].join("\n");
  acrescentar({ [`${tipo}/feitas/${id}.md`]: corpo }, `${tipo} #${p.pr}: ${resultado} (${eu})`);
  enviar({ de: eu, para: p.autor, assunto: `${tipo === "fila" ? "Fila" : "Revisão"} #${p.pr} @${p.sha}: ${resultado}`, texto: corpo, responde: id, agora });
  return p;
}

/**
 * Tira um pedido da fila ou da lista de revisões sem passar ninguém na frente: o pedido sai, não é pulado. Pode retirar
 * a família do autor, ou a família que pôs HOLD ativo no PR (revisão do Claude 5 no #5012: um HOLD longo, à espera de
 * decisão de custo, não pode parar a fila inteira). O autor pede de novo quando o PR estiver pronto.
 */
export function retirar({ tipo, eu, id, motivo = "", agora = new Date() }) {
  const p = pedidos(tipo, agora).find((x) => x.id === id);
  if (!p) throw new Error(`pedido não encontrado: ${id}`);
  if (p.estado === "feito") throw new Error(`pedido já concluído: ${id}`);
  const marca = estadoPr(p.pr, agora);
  const segurou = marca.ativo && marca.acao === "HOLD" && marca.segurando.has(familia(eu));
  if (familia(eu) !== p.familia && !segurou) throw new Error("só a família do autor, ou quem pôs HOLD no PR, retira o pedido");
  // Com a tomada de outra família ainda valendo, ninguém retira: quem pegou pode estar enfileirando agora (caso do #2498).
  if (p.estado === "tomado" && familia(p.tomadoPor) !== familia(eu)) throw new Error(`o pedido ${id} está com ${p.tomadoPor}, que pode estar enfileirando agora; peça a ele pelo correio que devolva, ou espere a tomada vencer`);
  const corpo = [`Resultado: retirado`, `PR: ${p.pr}`, `Head: ${p.sha}`, `Por: ${eu}`, `Data (UTC): ${agora.toISOString().slice(0, 16).replace("T", " ")}`, "",
    String(motivo).trim(), ""].join("\n");
  acrescentar({ [`${tipo}/feitas/${id}.md`]: corpo }, `${tipo} #${p.pr}: retirado (${eu})`);
  if (familia(eu) !== p.familia) enviar({ de: eu, para: p.autor, assunto: `${tipo === "fila" ? "Fila" : "Revisão"} #${p.pr} @${p.sha}: retirado`, texto: corpo, responde: id, agora });
  return p;
}

// ---------------------------------------------------------------------------------------------------------------------
// Cota (dono, 21/11/2026: "QUERO TAMBEM QUE UM AGENTE SAIBA QUANDO O OUTRO NAO TEM COTA. QUE QUANDO UM ESTIVER SEM COTA,
// QUE O REMETENTE SAIBA E POSSA ENVIAR O PEDIDO DE REVISAO PARA OUTRO TECNICAMENTE POSSIVEL").
//
// estado/<família>/<marca>  a declaração mais nova vale: "sem" (com a data em que a cota volta) ou "com". Passada essa
// data, a família conta como com cota. Uma tomada de quem ficou sem cota deixa de valer na hora: outro pode pegar.
// ---------------------------------------------------------------------------------------------------------------------

// Disponibilidade (dono, OWNER-20261122-0121-MAIL-AVAILABILITY, 22/11/2026, 01h21 Fortaleza):
//  1. Último sinal: a última vez que cada família escreveu no correio, lida nos commits (o trailer Mail-From, com a
//     família da sessão quando ela é identificada; nos commits de antes dele, só a sessão identificada). Quem fica sem
//     cota no meio da vez não consegue declarar; por isso uma família sem sinal há mais de SEM_SINAL_MIN minutos é tratada
//     como sem cota: a preferência por ela cai, as tomadas dela caem e os pedidos passam a outra família. Ausência só
//     conta quando o histórico lido cobre esses minutos (num clone raso, desde a borda mais recente); sem isso, ninguém
//     fica "sem sinal" por falta de histórico. A vigia e o read gravam um sinal (sinal/<família>/<marca>) quando o último
//     da família tem mais de BATIDA_MIN minutos, então um agente ativo nunca parece ausente.
//  2. Percentual: set-quota --remaining N --renews <data>. Com COTA_BAIXA% ou menos, até a renovação, as outras famílias
//     são avisadas e a família não recebe revisão longa (mais de LONGA_LINHAS linhas fora dos testes, ou tamanho não
//     conferido). 0% é sem cota até a renovação.
// Limite, sem esconder: o nome em Mail-From fora da nuvem é declarado (como o resto do correio, CO (k)); um sinal forjado
// só faz uma família parecer disponível, que é o comportamento de antes desta mudança.
export const SEM_SINAL_MIN = 120;
export const BATIDA_MIN = 15;
export const COTA_BAIXA = 10;
export const LONGA_LINHAS = 400;
const sinaisCache = new Map();

/** O último sinal de cada família: Map família -> milissegundos do commit mais recente que ela gravou. */
export function sinais(commit = buscar(), agora = new Date()) {
  if (!commit) return new Map();
  const chave = commit;
  if (!sinaisCache.has(chave)) {
    const lista = [];
    const saida = gitC(["log", "--format=%ct%x1f%(trailers:key=Mail-From,valueonly,separator=%x1e)%x1f%(trailers:key=Mail-Session,valueonly,separator=%x1e)", commit]);
    for (const linha of saida.split("\n")) {
      if (!linha.trim()) continue;
      const [t, de = "", ses = ""] = linha.split("\x1f");
      const pre = /session_([0-9A-Za-z]{7})/.exec(ses)?.[1] ?? null;
      let fam = pre ? SESSOES[pre] ?? null : null; // sessão identificada: a família dela, nunca o nome declarado
      const nome = de.split("\x1e")[0].trim();
      if (!fam && nome) { try { fam = familia(nome); } catch { fam = null; } }
      if (fam) lista.push([fam, Number(t) * 1000]);
    }
    sinaisCache.set(chave, lista);
  }
  const mapa = new Map();
  for (const [fam, t] of sinaisCache.get(chave)) {
    if (t - agora.getTime() > FUTURO_MIN * 60000) continue; // um commit datado no futuro não vale
    if (!mapa.has(fam) || mapa.get(fam) < t) mapa.set(fam, t);
  }
  return mapa;
}

/** Desde quando o histórico lido do correio é completo: a raiz, ou, num clone raso, a borda mais recente. */
const inicios = new Map();
function inicioObservado(commit) {
  if (!commit) return Infinity;
  if (!inicios.has(commit)) {
    const raso = gitC(["rev-parse", "--is-shallow-repository"]) === "true";
    const raizes = gitC(["log", "--format=%ct", "--max-parents=0", commit]).split("\n").filter(Boolean).map(Number);
    inicios.set(commit, raizes.length ? (raso ? Math.max(...raizes) : Math.min(...raizes)) * 1000 : Infinity);
  }
  return inicios.get(commit);
}

/** Grava um sinal da família de `eu` quando o último dela tem mais de BATIDA_MIN minutos; devolve se gravou. */
export function baterSinal(eu, agora = new Date(), commit = buscar()) {
  const fam = familia(eu);
  const ultimo = sinais(commit, agora).get(fam);
  if (ultimo && agora.getTime() - ultimo < BATIDA_MIN * 60000) return false;
  const carimbo = agora.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  acrescentar({ [`sinal/${fam}/${carimbo}-${slug(eu)}-${randomBytes(2).toString("hex")}`]: `${eu}\n${agora.toISOString()}\n` }, `${eu}: sinal`);
  return true;
}

/** Uma revisão longa: mais de LONGA_LINHAS linhas fora dos testes, ou tamanho não conferido no pedido. */
export function revisaoLonga(p) {
  const valor = campo(p.texto, "Linhas fora dos testes");
  return !/^\d+$/.test(valor) || Number(valor) > LONGA_LINHAS;
}

/**
 * A situação de cada família: { familia: { sem, ate, por, marca, resta, renova, baixa, ultimo, semSinal } }. Uma família
 * sem sinal há mais de SEM_SINAL_MIN minutos conta como sem cota, mesmo tendo declarado que tem.
 */
export function cotas(agora = new Date(), commit = buscar()) {
  // Passo 3: a declaração mais nova é a do commit mais recente, não a de maior marca.
  const ultima = new Map();
  const ord = ordem(commit);
  for (const c of arquivos(commit, "estado")) {
    const [, fam, marca] = c.split("/");
    if (!cotaValida(conteudo(commit, c), fam)) continue; // passo 5 (A6): a cota de outra família sem o coordenador não vale
    const i = ord.get(c)?.i ?? -1, atual = ultima.get(fam);
    if (!atual || i > atual.i || (i === atual.i && marca > atual.marca)) ultima.set(fam, { marca, caminho: c, i });
  }
  const saida = {};
  for (const [fam, { marca, caminho }] of ultima) {
    const texto = conteudo(commit, caminho);
    const ate = campo(texto, "Volta") ? new Date(campo(texto, "Volta")) : null;
    const semDeclarado = campo(texto, "Cota") === "sem";
    const sem = semDeclarado && !(ate && !Number.isNaN(ate.getTime()) && ate <= agora);
    const restaTexto = campo(texto, "Resta").replace(/%$/, "");
    const resta = /^\d+$/.test(restaTexto) ? Number(restaTexto) : null;
    const renovaData = campo(texto, "Renova") ? new Date(campo(texto, "Renova")) : null;
    const renova = renovaData && !Number.isNaN(renovaData.getTime()) ? renovaData : null;
    const baixa = !sem && resta !== null && resta <= COTA_BAIXA && !(renova && renova <= agora);
    saida[fam] = { sem, ate: ate && !Number.isNaN(ate.getTime()) ? ate : null, por: campo(texto, "Por"), marca,
      resta: renova && renova <= agora ? null : resta, renova, baixa };
  }
  // Último sinal (item 1): sem sinal há mais de SEM_SINAL_MIN minutos conta como sem cota.
  const sin = commit ? sinais(commit, agora) : new Map();
  const limite = agora.getTime() - SEM_SINAL_MIN * 60000;
  const coberto = commit ? inicioObservado(commit) <= limite : false;
  for (const fam of new Set([...FAMILIAS, ...Object.keys(saida), ...sin.keys()])) {
    const ultimo = sin.get(fam) ?? null;
    const semSinal = ultimo !== null ? ultimo < limite : coberto;
    const s = saida[fam] ?? (saida[fam] = { sem: false, ate: null, por: "", marca: null, resta: null, renova: null, baixa: false });
    s.ultimo = ultimo !== null ? new Date(ultimo) : null;
    s.semSinal = semSinal;
    if (semSinal) { s.sem = true; s.baixa = false; }
  }
  return saida;
}

/**
 * Fila parada, sem quebrar a ordem (dono: "OS ENFILEIRAMENTOS DEVEM RESPEITAR A FILA"; proposta do Claude 6 z5v4, apoiada
 * pelo Claude 4 3rC, 21/11/2026): quando o primeiro pedido aberto passa 30 minutos sem ninguém pegá-lo, a vigia de quem não
 * pode pegá-lo manda, uma vez a cada 30 minutos, um recado às famílias que podem; sem nenhuma, ao autor. O caminho
 * fila/avisos/<id>/<bloco de 30 min> garante um recado só por bloco, mesmo com muitas vigias ao mesmo tempo.
 */
export function avisarFilaParada(eu, agora = new Date()) {
  const ps = pedidos("fila", agora);
  if (ps.some((p) => p.estado === "tomado")) return null;
  const alvo = ps.find((p) => p.estado === "aberto");
  const quando = alvo ? dataDe(alvo.id) : null;
  if (!alvo || !quando) return null;
  const minutos = Math.floor((agora - quando) / 60000);
  if (minutos < 30) return null;
  const marca = estadoPr(alvo.pr, agora);
  if (marca.ativo && marca.acao === "HOLD") return null;
  const c = cotas(agora);
  const fora = new Set([alvo.familia, ...campo(alvo.texto, "Exclui").split(", ").filter(Boolean), ...alvo.devolveram, ...revisoresDoHead(alvo.pr, alvo.sha)]);
  const podem = FAMILIAS.filter((f) => !fora.has(f) && !c[f]?.sem);
  if (podem.includes(familia(eu))) return null; // quem pode pegar recebe o aviso da própria vigia
  try {
    acrescentar({ [`fila/avisos/${alvo.id}/${Math.floor(minutos / 30)}`]: `${eu}\n${agora.toISOString()}\n` }, `Fila parada em #${alvo.pr}: aviso de ${eu}`);
  } catch (erro) {
    if (/já existe no correio/.test(String(erro.message ?? erro))) return null;
    throw erro;
  }
  const nome = (f) => (f === "codex" ? "Codex" : f.replace(/^claude-(\d+)$/, "Claude $1"));
  const para = podem.length ? podem.map(nome) : [alvo.autor];
  const texto = podem.length
    ? `A fila do correio está parada há ${minutos} minutos no primeiro pedido, fila #${alvo.pr} @${alvo.sha} (autor ${alvo.autor}, pedido ${alvo.id}). Só a sua família, entre as com cota, pode enfileirá-lo (as outras são o autor, revisaram o head, foram excluídas ou o devolveram). Rode claim-enqueue e confira a FQ (1); se não puder, release-enqueue com o motivo. Nenhum pedido passa na frente dele.`
    : `A fila do correio está parada há ${minutos} minutos no seu pedido fila #${alvo.pr} @${alvo.sha} (${alvo.id}): nenhuma família com cota pode enfileirá-lo agora (autor, revisores do head, exclusões, devoluções ou sem cota). Se ele vai esperar, retire com cancel-enqueue e peça de novo quando alguém puder; a fila inteira espera atrás dele.`;
  enviar({ de: eu, para, assunto: `Fila parada em #${alvo.pr}: ${podem.length ? "você pode enfileirá-lo" : "ninguém disponível pode enfileirá-lo"}`, texto, agora });
  return { pr: alvo.pr, para };
}

/** As famílias que existem hoje (dono: Claude 1 a 7 e o Codex); um aviso a todos espera a confirmação de cada uma. */
export const FAMILIAS = ["claude-1", "claude-2", "claude-3", "claude-4", "claude-5", "claude-6", "claude-7", "codex"];

/** As famílias conhecidas: as de FAMILIAS e as que têm caixa, declararam cota ou pediram algo. */
export function familias(commit = buscar()) {
  const f = new Set(FAMILIAS);
  for (const c of arquivos(commit, "caixas")) { const d = c.split("/")[1]; if (d !== "todos") f.add(familia(d)); }
  for (const c of arquivos(commit, "estado")) f.add(c.split("/")[1]);
  return [...f].sort();
}

/**
 * Declara a cota de `eu`: sem cota até `ate` (data ISO), ou com cota. A cota de outra família (`por` de outra família)
 * só é declarada pelo coordenador: a sessão nomeada, com o pedido na #4932 (OWNER-20261121-1904, passo 5; achado A6).
 */
export function declararCota({ eu, sem, ate = null, por = null, resta = null, renova = null, pedido = "", dono = "", agora = new Date() }) {
  if (resta !== null && !(/^\d{1,3}%?$/.test(String(resta)) && Number(String(resta).replace(/%$/, "")) <= 100)) {
    throw new Error(`--remaining deve ser um número de 0 a 100 (o percentual que resta), não ${resta}`);
  }
  const pct = resta === null ? null : Number(String(resta).replace(/%$/, ""));
  if (renova !== null && Number.isNaN(new Date(renova).getTime())) throw new Error(`--renews não é uma data: ${renova} (use, por exemplo, 2026-11-29T10:00-03:00)`);
  if (pct !== null && renova === null) throw new Error("--remaining precisa de --renews <data da renovação da conta>");
  // 0% é sem cota até a renovação.
  if (pct === 0) { sem = true; ate = ate ?? renova; }
  if (sem && ate && Number.isNaN(new Date(ate).getTime())) throw new Error(`--until não é uma data: ${ate} (use, por exemplo, 2026-11-22T01:00-03:00)`);
  const escritor = por || eu;
  let p = null;
  if (familia(escritor) !== familia(eu)) {
    try {
      p = conferirPrivilegio({ eu: escritor, acao: "declara a cota de outra família", comando: "set-quota", alvo: familia(eu), pedido, dono, agora });
    } catch (erro) {
      throw new Error(`a cota de ${familia(eu)} só é declarada pela própria família ou pelo coordenador (OWNER-20261121-1904, passo 5): ${erro.message ?? erro}`);
    }
  }
  const carimbo = agora.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const marca = `${carimbo}-${slug(eu)}-${randomBytes(2).toString("hex")}`;
  const corpo = [`Cota: ${sem ? "sem" : "com"}`, ...(sem && ate ? [`Volta: ${new Date(ate).toISOString()}`] : []),
    ...(pct !== null ? [`Resta: ${pct}%`] : []), ...(renova !== null ? [`Renova: ${new Date(renova).toISOString()}`] : []), `Por: ${escritor}`,
    `Data (UTC): ${agora.toISOString().slice(0, 16).replace("T", " ")}`, ...(p ? linhasPrivilegio(p) : []), `Sessão: ${linhaSessao()}`, ""].join("\n");
  acrescentar({ [`estado/${familia(eu)}/${marca}`]: corpo,
    ...(p ? avisoPrivilegio({ eu: escritor, assunto: `cota de ${familia(eu)} declarada ${sem ? "sem" : "com"} por ${escritor}`, p, agora }) : {}) },
  `${eu}: ${sem ? "sem cota" : pct !== null ? `com cota, ${pct}%` : "com cota"}`);
}

/**
 * Uma declaração de cota vale se a escreveu a própria família, ou o coordenador com o pedido (passo 5, A6). As antigas,
 * sem a linha "Sessão:" (antes desta versão), valem como antes: no correio real, a do Claude 3 sem cota até 23/11/2026,
 * gravada pelo Claude 6 com a informação do dono, continua valendo.
 */
export function cotaValida(texto, fam) {
  if (!sessaoDe(texto)) return true;
  const por = campo(texto, "Por"), quem = sessaoDe(texto)?.familia ?? familia(por);
  return (quem === fam && familia(por) === fam) || privilegioValido(texto, por);
}

/** O nome de uma família para quem lê: claude-3 -> "Claude 3", codex -> "Codex". */
const nomeFamilia = (f) => (f === "codex" ? "Codex" : f.replace(/^claude-(\d+)$/, "Claude $1"));

/** Cota baixa (item 2): avisa as outras famílias uma vez, quando a família passa a ter COTA_BAIXA% ou menos. */
export function avisarCotaBaixa({ eu, por = null, antes, agora = new Date() }) {
  const c = cotas(agora)[familia(eu)];
  if (!c?.baixa || antes?.baixa) return null;
  const para = FAMILIAS.filter((f) => f !== familia(eu)).map(nomeFamilia);
  const quando = c.renova ? c.renova.toISOString() : "data não declarada";
  enviar({ de: por || eu, para, assunto: `Cota baixa: ${nomeFamilia(familia(eu))} com ${c.resta}% até ${quando}`, agora,
    texto: `${por && por !== eu ? `${por} declarou por ${eu}` : `${eu} declarou`} ${c.resta}% de cota até a renovação (${quando}). Até lá, o correio não entrega à família ${familia(eu)} revisões longas (mais de ${LONGA_LINHAS} linhas fora dos testes, ou de tamanho não conferido), e a preferência por ela nessas revisões não vale. Mande os pedidos longos a outra família com cota (list-quotas).` });
  return para;
}

/** Para quem vai uma mensagem: os destinatários sem cota e as famílias com cota que podem receber no lugar. */
export function avisoCota(destinos, eu, agora = new Date(), commit = buscar()) {
  const c = cotas(agora, commit);
  const sem = destinos.filter((d) => d !== "todos" && c[familia(d)]?.sem).map((d) => ({ nome: d, ate: c[familia(d)].ate }));
  const com = familias(commit).filter((f) => !c[f]?.sem && f !== familia(eu) && !destinos.some((d) => familia(d) === f));
  return { sem, com };
}

// ---------------------------------------------------------------------------------------------------------------------
// Quem mexe em cada PR (AC (m) e (p)): CLAIMED, HOLD e liberação, sem depender de achar a linha no meio do canal.
//
// prs/<N>/<k>  a k-ésima marca do PR N (0, 1, 2...): "CLAIMED", "HOLD" (com o motivo) ou "LIBERADO". A de maior k vale.
// Reivindicar usa o próximo k: dois agentes que chegam juntos gravam o mesmo caminho, e só o primeiro fica. Um CLAIMED
// vale por 2 horas (AC (m)); um HOLD vale até alguém liberar. Ninguém reivindica um PR com CLAIMED ou HOLD de outro.
// ---------------------------------------------------------------------------------------------------------------------

export const CLAIM_MIN = 120;

// Passo 5 (OWNER-20261121-1904; achados A7 e A8): de quem é cada marca. Um HOLD só é liberado por uma família que pôs
// todos os HOLDs ativos, pelo autor (uma família com commits no PR, conferida na hora e gravada na linha "Autor:") ou
// pelo coordenador (a sessão nomeada, com o pedido na #4932); um CLAIMED não passa por cima de um HOLD ativo. Um
// CLAIMED é da sessão que o gravou: outra sessão, mesmo da mesma família, não o toma nem o libera enquanto ele vale.
// A leitura aplica as mesmas regras às marcas gravadas com a linha "Sessão:" (todas as desta versão): uma marca sem
// direito, escrita à mão ou por cópia antiga, é ignorada. As marcas antigas, sem essa linha, valem como antes.
const ativoEm = (e, quando) => Boolean(e) && (e.acao === "HOLD" || (e.acao === "CLAIMED" && !noFuturo(e.quando, quando) && (quando - e.quando) / 60000 < CLAIM_MIN));
const sessaoDaMarca = (texto) => { const s = sessaoDe(texto); return s?.identificada ? sessaoInteira(s) : null; };

/** O estado atual do PR N: { acao, por, sessao, motivo, quando, ativo, proximo, segurando, ignoradas }. */
export function estadoPr(pr, agora = new Date(), commit = buscar()) {
  const marcas = arquivos(commit, `prs/${pr}`).map((c) => ({ c, k: Number(c.split("/")[2]) })).filter((m) => Number.isInteger(m.k)).sort((a, b) => a.k - b.k);
  if (!marcas.length) return { acao: null, ativo: false, proximo: 0, segurando: new Set(), ignoradas: [] };
  let e = null;
  const ignoradas = [];
  for (const { c, k } of marcas) {
    const texto = conteudo(commit, c);
    const acao = campo(texto, "Ação"), por = campo(texto, "Por"), quando = new Date(campo(texto, "Data"));
    const s = sessaoDe(texto), sessao = sessaoDaMarca(texto), fam = s?.familia ?? familia(por);
    const momento = Number.isNaN(quando.getTime()) ? agora : quando;
    // HOLD do dono (coordenador, 3c47): nada o tira, nem escrita não identificada, salvo a liberação da sessão nomeada
    // com o pedido do coordenador na #4932 e a referência da decisão do dono que manda liberar. Um HOLD por cima o mantém.
    if (e && e.acao === "HOLD" && e.dono && ativoEm(e, momento) && acao !== "HOLD") {
      if (!(acao === "LIBERADO" && s?.identificada && privilegioValido(texto, por) && ID_DONO.test(campo(texto, "Liberação do dono")))) {
        ignoradas.push({ caminho: c, por, motivo: `${acao} sobre um HOLD do dono, sem a sessão nomeada, o pedido na #4932 e a decisão do dono` });
        continue;
      }
    }
    if (s && e && ativoEm(e, momento)) {
      const priv = privilegioValido(texto, por);
      let motivo = "";
      if (e.acao === "HOLD" && acao === "CLAIMED") motivo = "CLAIMED por cima de um HOLD ativo";
      if (e.acao === "HOLD" && acao === "LIBERADO" && !priv && ![...e.segurando].every((f) => f === fam) && !campo(texto, "Autor").split(", ").includes(fam)) {
        motivo = "liberação de um HOLD por quem não o pôs, não é o autor nem o coordenador";
      }
      if (e.acao === "CLAIMED" && acao !== "HOLD" && !priv && (e.sessao && sessao ? e.sessao !== sessao : familia(e.por) !== familia(por))) {
        motivo = `${acao} sobre o CLAIMED de outra sessão`;
      }
      if (motivo) { ignoradas.push({ caminho: c, por, motivo }); continue; }
    }
    const segurando = acao === "HOLD" ? new Set([...(e && ativoEm(e, momento) && e.acao === "HOLD" ? e.segurando : []), fam]) : new Set();
    // A linha "HOLD do dono" só vale numa marca gravada por sessão identificada da família que assina: uma escrita direta
    // pelo git, sem sessão ou com a sessão de outra família, vale como HOLD comum, que a família, o autor ou o coordenador
    // liberam (revisão do Claude 4 2Wb no #5145).
    const donoProprio = campo(texto, "HOLD do dono");
    const donoValido = donoProprio && s?.identificada && s.familia && s.familia === familia(por) && ID_DONO.test(donoProprio) ? donoProprio : "";
    if (donoProprio && !donoValido) ignoradas.push({ caminho: c, por, motivo: "linha \"HOLD do dono\" sem sessão identificada da família que assina: vale como HOLD comum" });
    const dono = acao === "HOLD" ? (donoValido || (e && ativoEm(e, momento) && e.acao === "HOLD" ? e.dono : "")) : "";
    e = { acao, por, sessao, motivo: campo(texto, "Motivo"), quando, segurando, k, dono };
  }
  const proximo = marcas[marcas.length - 1].k + 1;
  if (!e) return { acao: null, ativo: false, proximo, segurando: new Set(), ignoradas };
  // Passo 3: um CLAIMED com data no futuro não fica ativo (um HOLD fica: segurar é o lado seguro).
  return { ...e, ativo: ativoEm(e, agora), proximo, ignoradas };
}

/** O identificador de uma decisão do dono (CP: PREFIXO-AAAAMMDD-HHMM-ASSUNTO; a hora pode vir sem preencher, "HHMM"). */
export const ID_DONO = /^OWNER-\d{8}-(?:\d{4}|HHMM)-[A-Z0-9][A-Z0-9-]*$/;

/** Marca o PR: CLAIMED, HOLD ou LIBERADO, com as regras de quem pode (passo 5). */
export function marcarPr({ pr, eu, acao, motivo = "", pedido = "", dono = "", holdDono = "", liberacaoDono = "", agora = new Date() }) {
  if (!/^\d+$/.test(String(pr ?? ""))) throw new Error("--pr é obrigatório (o número do PR)");
  if (!["CLAIMED", "HOLD", "LIBERADO"].includes(acao)) throw new Error(`ação desconhecida: ${acao}`);
  if (holdDono && (acao !== "HOLD" || !ID_DONO.test(String(holdDono)))) throw new Error("--owner-hold vai só com hold-pr e precisa do identificador da decisão do dono, no formato OWNER-AAAAMMDD-HHMM-ASSUNTO");
  const commit = buscar();
  const atual = estadoPr(pr, agora, commit);
  const minha = sessaoAtual()?.id ?? null;
  const outraSessao = atual.ativo && atual.acao === "CLAIMED" && (atual.sessao && minha ? atual.sessao !== minha : familia(atual.por) !== familia(eu));
  const quemPode = "quem o pôs, o autor (família com commits no PR) ou o coordenador (a sessão nomeada, com --request do pedido na #4932)";
  const extras = [];
  let priv = null;
  if (acao === "CLAIMED" && atual.ativo && atual.acao === "HOLD") {
    return { recusado: `#${pr} está com HOLD de ${atual.por}${atual.motivo ? ` (${atual.motivo})` : ""}; um CLAIMED não passa por cima dele: o HOLD sai primeiro, liberado por ${quemPode}` };
  }
  if (acao === "CLAIMED" && outraSessao) {
    return { recusado: `#${pr} está com CLAIMED de ${atual.por} (outra sessão) desde ${atual.quando.toISOString()}; um CLAIMED é da sessão que o gravou` };
  }
  if (acao === "LIBERADO" && atual.ativo && atual.acao === "HOLD" && atual.dono) {
    if (!pedido || pedido === true || !ID_DONO.test(String(liberacaoDono))) {
      return { recusado: `#${pr} está com HOLD do dono (${atual.dono}); só a sessão nomeada o libera, com o pedido do coordenador na #4932 (--request) e a decisão do dono que manda liberar (--owner-decision OWNER-...); nem quem o pôs nem o autor` };
    }
    priv = conferirPrivilegio({ eu, acao: "libera um HOLD do dono", comando: "release-pr", alvo: String(pr), pedido, dono, agora, commit });
    conferirDistancia(pr, priv.s.id, commit);
    extras.push(...linhasPrivilegio(priv), `Liberação do dono: ${liberacaoDono}`);
  } else if (acao === "LIBERADO" && atual.ativo && (atual.acao === "HOLD" || outraSessao)) {
    const segurou = atual.acao === "HOLD" && [...atual.segurando].every((f) => f === familia(eu));
    if (!segurou) {
      if (pedido && pedido !== true) {
        priv = conferirPrivilegio({ eu, acao: "libera a marca de outro num PR", comando: "release-pr", alvo: String(pr), pedido, dono, agora, commit });
        conferirDistancia(pr, priv.s.id, commit);
        extras.push(...linhasPrivilegio(priv));
      } else if (atual.acao === "CLAIMED") {
        return { recusado: `#${pr} está com CLAIMED de ${atual.por} (outra sessão) desde ${atual.quando.toISOString()}; só a sessão que o gravou o libera (ou o coordenador, com --request), ou ele vence em ${CLAIM_MIN} minutos` };
      } else {
        const c = commitsDoPr(pr);
        if (!c) return { recusado: `#${pr} está com HOLD de ${[...atual.segurando].join(", ")}; os commits do PR NÃO FORAM CONFERIDOS agora, então não sei se você é o autor; o HOLD fica` };
        if (!c.familias.has(familia(eu))) return { recusado: `#${pr} está com HOLD de ${atual.por} (famílias que o puseram: ${[...atual.segurando].join(", ")}); só o libera ${quemPode}` };
        extras.push(`Autor: ${[...c.familias].sort().join(", ")}`);
      }
    }
  }
  if (holdDono) extras.push(`HOLD do dono: ${holdDono}`);
  const corpo = [`Ação: ${acao}`, `PR: ${pr}`, `Por: ${eu}`, `Data: ${agora.toISOString()}`, ...(motivo ? [`Motivo: ${motivo}`] : []), ...extras, `Sessão: ${linhaSessao()}`, ""].join("\n");
  try {
    acrescentar({ [`prs/${pr}/${atual.proximo}`]: corpo, ...(priv ? avisoPrivilegio({ eu, assunto: `#${pr}: ${atual.acao} de ${atual.por} liberado por ${eu}`, p: priv, agora }) : {}) }, `#${pr}: ${acao} (${eu})`);
  } catch (erro) {
    if (/já existe no correio/.test(String(erro.message ?? erro))) return { recusado: `#${pr} acabou de ser marcado por outro agente; confira com pr-status e tente de novo` };
    throw erro;
  }
  return { ok: true };
}

function mostrar(lista, agora = new Date()) {
  for (const m of lista) {
    const quando = dataDe(m.id);
    const idade = quando ? Math.floor((agora - quando) / 60000) : null;
    console.log(`===== ${m.id}${idade !== null && idade >= ATRASO_MIN ? `  (ATRASADA: ${idade} min sem confirmar)` : ""}`);
    if (m.pelaFamilia) console.log("(já confirmada com o nome da família por outra sessão; é para você: leia e confirme com o seu nome)");
    const s = sessaoDe(m.texto), de = campo(m.texto, "De");
    if (!s?.identificada) console.log("ATENÇÃO: escrita não identificada (fora da nuvem do Claude Code, ou gravada sem a ferramenta): confira com o remetente antes de uma ação que dependa de quem a escreveu.");
    else if (s?.familia && de && familia(de) !== s.familia) console.log(`ATENÇÃO, IDENTIDADE: a mensagem diz ser de "${de}" (${familia(de)}), mas foi gravada por uma sessão da família ${s.familia}. Confira com o remetente antes de agir.`);
    console.log(m.texto);
  }
}

// Os comandos e as opções têm nomes técnicos em inglês americano (dono, 21/11/2026). Os nomes antigos, em português,
// continuam aceitos por enquanto, com um aviso, para não quebrar a vigia nem os roteiros que já estão rodando.
export const COMANDOS = {
  send: "enviar", read: "ler", ack: "confirmar", watch: "vigiar", "list-pending": "pendentes",
  "set-quota": "cota", "list-quotas": "quem",
  "request-review": "pedir-revisao", "list-reviews": "revisoes", "claim-review": "pegar-revisao", "complete-review": "concluir-revisao",
  "release-review": "devolver-revisao", "cancel-review": "retirar-revisao", "renew-review": "renovar-revisao",
  "request-enqueue": "pedir-fila", "list-queue": "fila", "claim-enqueue": "pegar-fila", "complete-enqueue": "concluir-fila",
  "release-enqueue": "devolver-fila", "cancel-enqueue": "retirar-fila", "renew-enqueue": "renovar-fila",
  "claim-pr": "reivindicar", "hold-pr": "segurar", "release-pr": "liberar", "pr-status": "estado-pr", help: "ajuda",
  "set-switch": "set-switch", "list-switches": "list-switches", "record-review": "record-review",
  "list-review-records": "list-review-records", "confirm-review-record": "confirm-review-record", "release-take": "release-take",
  "check-append-only": "check-append-only", "verify-enqueue": "verify-enqueue",
};
/** Nomes publicados antes (em português, e a primeira versão em inglês, de 21/11/2026): aceitos com um aviso do nome atual. */
export const NOMES_ANTIGOS = {
  pending: "list-pending", quota: "set-quota", quotas: "list-quotas", reviews: "list-reviews", queue: "list-queue",
  "take-review": "claim-review", "return-review": "release-review", "withdraw-review": "cancel-review",
  "take-enqueue": "claim-enqueue", "return-enqueue": "release-enqueue", "withdraw-enqueue": "cancel-enqueue",
  claim: "claim-pr", hold: "hold-pr", release: "release-pr",
  ...Object.fromEntries(Object.entries(COMANDOS).map(([en, pt]) => [pt, en])),
};
export const OPCOES = {
  as: "eu", from: "de", to: "para", subject: "assunto", text: "texto", file: "arquivo", "reply-to": "responde", all: ["tudo", "todas"],
  exhausted: "sem", out: "sem", available: "com", until: "ate", by: "por", remaining: "resta", renews: "renova", also: "tambem", seconds: "segundos", exclude: "exclui",
  result: "resultado", reason: "motivo", name: "nome", on: "ligar", off: "desligar", link: "link", request: "pedido", "owner-message": "dono",
  "owner-hold": "holdDono", "owner-decision": "liberacaoDono",
};
const RESULTADOS = { enqueued: "enfileirado", declined: "recusado", READY: "READY", CHANGES: "CHANGES" };
const TIPOS_EN = { review: "revisao", enqueue: "fila" };

/** Traduz um comando em inglês (ou o nome antigo, com aviso) para o nome interno, e as opções também. */
export function traduzir(comandoDado, o) {
  let comando = comandoDado;
  if (COMANDOS[comandoDado]) comando = COMANDOS[comandoDado];
  else if (NOMES_ANTIGOS[comandoDado]) {
    console.error(`aviso: "${comandoDado}" é um nome antigo; use "${NOMES_ANTIGOS[comandoDado]}"`);
    comando = COMANDOS[NOMES_ANTIGOS[comandoDado]];
  }
  const traduzidas = { _: o._ };
  for (const [chave, valor] of Object.entries(o)) {
    if (chave === "_") continue;
    const alvo = OPCOES[chave];
    if (alvo) for (const k of [alvo].flat()) traduzidas[k] = valor;
    else traduzidas[chave] = valor;
  }
  if (typeof traduzidas.resultado === "string") {
    const r = traduzidas.resultado;
    if (RESULTADOS[r]) traduzidas.resultado = RESULTADOS[r];
    else if (!Object.values(RESULTADOS).includes(r)) throw new Error(`--result deve ser um destes: ${Object.keys(RESULTADOS).join(", ")}`);
  }
  if (typeof traduzidas.tambem === "string") traduzidas.tambem = traduzidas.tambem.split(",").map((t) => TIPOS_EN[t.trim()] ?? t.trim()).join(",");
  return { comando, o: traduzidas };
}

/**
 * Passo 6 (A14): referências do correio deixadas no clone por versões anteriores (refs/correio/*, refs/agent-mail/*)
 * apontam para o histórico privado; um push --mirror as publicaria. A ferramenta não apaga nada no clone de ninguém:
 * avisa, com o comando. Avisa também quando ela roda de uma pasta temporária que todos podem escrever.
 */
export function avisarClone() {
  let refs = [];
  try { refs = git(["for-each-ref", "--format=%(refname)", "refs/correio", "refs/agent-mail"]).split("\n").filter(Boolean); } catch { /* não é um repositório git */ }
  if (refs.length) {
    console.error(`ATENÇÃO: este clone guarda ${refs.length} referência(s) do correio privado, de uma versão anterior da ferramenta (${refs.slice(0, 3).join(", ")}${refs.length > 3 ? ", ..." : ""}); um push --mirror as publicaria. O correio agora fica em ${DIR_CORREIO}. Apague-as com: git for-each-ref --format='%(refname)' refs/correio refs/agent-mail | xargs -r -n1 git update-ref -d`);
  }
  const aqui = new URL(import.meta.url).pathname;
  // NIT 2 do Claude 1 no #5113: pelas permissões da pasta, não pelo caminho; uma pasta só da sessão (700) não é aviso.
  let todosEscrevem = false;
  try { todosEscrevem = (statSync(dirname(aqui)).mode & 0o002) !== 0; } catch { /* sem como ler: sem aviso */ }
  if (todosEscrevem && !process.env.AGENT_MAIL_TEST) console.error(`ATENÇÃO: a ferramenta roda de ${aqui}, numa pasta que todos podem escrever; instale com o comando de CO (b) do AGENTS.md, em ~/.agent-mail.`);
}

async function main(argv) {
  avisarClone();
  const [comandoDado, ...resto] = argv;
  const { comando, o } = traduzir(comandoDado, opcoes(resto));
  const ESCREVEM = new Set(["enviar", "confirmar", "vigiar", "cota", "reivindicar", "segurar", "liberar", "pedir-revisao", "pedir-fila",
    "pegar-revisao", "pegar-fila", "concluir-revisao", "concluir-fila", "devolver-revisao", "devolver-fila", "retirar-revisao", "retirar-fila",
    "renovar-revisao", "renovar-fila", "set-switch", "record-review", "confirm-review-record", "release-take"]);
  const escritor = comando === "cota" && o.por && o.por !== true ? o.por : o.de ?? o.eu;
  if (ESCREVEM.has(comando)) conferirIdentidade(escritor);
  definirEscritor(escritor);
  const versaoOk = comando && comando !== "ajuda" ? avisarVersao() : true;
  // Passo 3: uma cópia que não é a revisada, ou cuja versão não foi conferida agora, não escreve no correio; ler continua.
  if (ESCREVEM.has(comando) && !versaoOk) {
    throw new Error("escrita recusada: esta cópia não é a versão revisada do main do Marktmorgen, conferida agora; reinstale com o comando de CO (b) do AGENTS.md e repita");
  }
  if (comando === "enviar") {
    const texto = o.arquivo ? readFileSync(o.arquivo === "-" ? 0 : o.arquivo, "utf8") : o.texto;
    const id = enviar({ de: o.de, para: o.para, assunto: o.assunto, texto, responde: o.responde || null });
    console.log(`enviada: ${id}`);
    const { sem, com } = avisoCota(String(o.para).split(",").map((d) => d.trim()).filter(Boolean), o.de);
    for (const s of sem) console.log(`ATENÇÃO: ${s.nome} está sem cota${s.ate ? ` até ${s.ate.toISOString()}` : ""}: pode não ler tão cedo. Com cota: ${com.join(", ") || "nenhuma outra declarada"}.`);
  } else if (comando === "ler") {
    if (!o.eu) throw new Error("--as é obrigatório");
    const commit = buscar();
    const lista = naoLidas(o.eu, commit);
    if (sessaoAtual()) {
      // Uma linha só, com a contagem e até 5 identificadores: para o Claude 1 (que também lê no computador do dono) e o
      // Codex, isso é o normal, e um aviso por mensagem viraria ruído (LEVE do Claude 2 lpgvy no #5113).
      const semId = confirmadasSemIdentidade(o.eu, new Date(), commit);
      if (semId.length) console.log(`ATENÇÃO: ${semId.length} mensagem(ns) da sua caixa foram confirmadas só por escrita não identificada nas últimas 24 horas (${semId.slice(-5).join(", ")}${semId.length > 5 ? ", ..." : ""}); se não foi uma sessão da sua família fora da nuvem, leia-as no correio.`);
    }
    if (!lista.length) console.log("nenhuma mensagem nova");
    else { mostrar(lista); console.log(`\n${lista.length} não lida(s). Confirme com: node agent-mail.mjs ack --as "${o.eu}" ${lista.map((m) => m.id).join(" ")}`); }
    // Quem lê está ativo: o read grava o sinal da família (item 1), só com a cópia revisada e o próprio nome; ler nunca falha por isso.
    try { conferirIdentidade(o.eu); if (versaoOk) baterSinal(o.eu); } catch { /* o sinal fica para a próxima */ }
  } else if (comando === "confirmar") {
    if (!o.eu) throw new Error("--as é obrigatório");
    const ids = o.tudo ? naoLidas(o.eu).map((m) => m.id) : o._;
    console.log(`confirmadas: ${confirmar({ eu: o.eu, ids })}`);
  } else if (comando === "vigiar") {
    if (!o.eu) throw new Error("--as é obrigatório");
    const fim = Date.now() + 1000 * Number(o.segundos || 120);
    // A vigia ligada é sinal de agente ativo (item 1).
    // Mensagem fixa, sem o texto do erro (CodeQL 257); o erro, já sem credenciais, aparece rodando read.
    try { baterSinal(o.eu); } catch { console.log("vigia: o sinal não foi gravado; tento na próxima (rode read para ver o erro)"); }
    for (;;) {
      let lista = [];
      let abertos = [];
      esquecerRetrato(); // passo 6 (A11): cada volta lê um retrato novo, e só um
      try {
        lista = naoLidas(o.eu);
        // --also review,enqueue: acorda também quando há pedido que este agente pode pegar (de outra família).
        for (const tipo of String(o.tambem === true ? "" : o.tambem ?? "").split(",").map((t) => t.trim()).filter((t) => TIPOS.has(t))) {
          const ps = pedidos(tipo);
          const agora = new Date(), c = cotas(agora);
          const vez = tipo === "fila"
            ? (ps.some((p) => p.estado === "tomado") ? [] : ps.filter((p) => p.estado === "aberto").slice(0, 1).filter((p) => p.familia !== familia(o.eu) && !p.devolveram.has(familia(o.eu)) && !campo(p.texto, "Exclui").split(", ").includes(familia(o.eu)) && !revisoresDoHead(p.pr, p.sha).has(familia(o.eu)) && !(() => { const m = estadoPr(p.pr); return m.ativo && (m.acao === "HOLD" || familia(m.por) !== familia(o.eu)); })()))
            : ps.filter((p) => revisaoParaMim(p, o.eu, agora, c));
          abertos.push(...vez.map((p) => `${tipo} #${p.pr}`));
        }
      } catch { console.log("vigia: falha ao ler o correio; tento de novo (rode read para ver o erro)"); }
      try { avisarFilaParada(o.eu); } catch {}
      // Passo 3: o que chegou ao correio desde a última conferência só acrescentou arquivos? Avisa uma vez por alteração.
      let alarme = "";
      try {
        const c = buscar();
        let antes = null;
        try { antes = gitC(["rev-parse", "--verify", "-q", REF_VERIFICADO]); } catch { /* primeira conferência */ }
        // NIT 1 do Claude 1 no #5113: na primeira vez do repositório próprio, vale a marca antiga do clone, se houver;
        // assim uma reescrita feita antes da troca de versão ainda é denunciada.
        if (!antes) { try { antes = /^[0-9a-f]{40}/.exec(readFileSync(ARQUIVO_ANCORA(), "utf8"))?.[0] ?? null; } catch { /* nenhuma guardada */ } }
        if (!antes) { try { antes = git(["rev-parse", "--verify", "-q", REF_VERIFICADO]); } catch { /* o clone não tem marca antiga */ } }
        const r = conferirSoAcrescentar(c, antes || null);
        if (c) gitC(["update-ref", REF_VERIFICADO, c]);
        if (r.reescrito || r.problemas.length) alarme = [r.reescrito ? "o ramo foi reescrito (a última conferência não está mais no histórico)" : "", ...r.problemas].filter(Boolean).join("; ");
      } catch {}
      if (alarme) { console.log(`ALERTA: o ramo correio não só acrescentou: ${alarme}. Avise o coordenador e o dono pelo correio agora; não apague nem reescreva nada.`); return; }
      if (lista.length) { console.log(`Correio: ${lista.length} mensagem(ns) não lida(s) para ${o.eu}. Leia com: node agent-mail.mjs read --as "${o.eu}"`); return; }
      if (abertos.length) { console.log(`Correio: pedido(s) para você pegar: ${abertos.join(", ")}. Use claim-review ou claim-enqueue.`); return; }
      if (Date.now() + 30000 > fim) { console.log("Correio: nada novo neste ciclo; ligue a vigia de novo."); return; }
      await new Promise((ok) => setTimeout(ok, 30000));
    }
  } else if (comando === "verify-enqueue") {
    if (!o.eu) throw new Error("--as é obrigatório");
    const { p, head } = conferirTomada({ eu: o.eu, id: o._[0] });
    console.log(`conferido agora: a tomada de ${o._[0]} é sua e o head de #${p.pr} não mudou; enfileire ${head} e conclua com complete-enqueue`);
  } else if (comando === "check-append-only") {
    const r = conferirSoAcrescentar(buscar());
    if (!r.problemas.length) console.log("o ramo correio só acrescentou arquivos de dados em todo o histórico");
    else { for (const p of r.problemas) console.log(p); process.exitCode = 1; }
  } else if (comando === "cota") {
    const resta = o.resta === undefined || o.resta === true ? null : String(o.resta);
    if (!o.eu || (!o.sem && !o.com && resta === null)) throw new Error('use: set-quota --as "Claude N" --exhausted --until 2026-11-22T01:00-03:00   ou   set-quota --as "Claude N" --available   ou   set-quota --as "Claude N" --remaining 35 --renews 2026-11-29T10:00-03:00');
    const antes = cotas()[familia(o.eu)];
    declararCota({ eu: o.eu, sem: Boolean(o.sem), ate: o.ate === true ? null : o.ate ?? null, por: o.por === true ? null : o.por ?? null,
      resta, renova: o.renova === undefined || o.renova === true ? null : String(o.renova), pedido: o.pedido ?? "", dono: o.dono ?? "" });
    console.log(`registrado: ${o.eu} ${o.sem || (resta !== null && Number(resta.replace(/%$/, "")) === 0) ? `sem cota${o.ate && o.ate !== true ? ` até ${o.ate}` : ""}` : "com cota"}${resta !== null ? `, resta ${resta.replace(/%$/, "")}%` : ""}`);
    const avisadas = avisarCotaBaixa({ eu: o.eu, por: o.por === true ? null : o.por ?? null, antes });
    if (avisadas) console.log(`cota baixa: avisei ${avisadas.join(", ")}; revisões longas não vão para a sua família até a renovação`);
  } else if (comando === "reivindicar" || comando === "segurar" || comando === "liberar") {
    if (!o.eu) throw new Error("--as é obrigatório");
    const acao = { reivindicar: "CLAIMED", segurar: "HOLD", liberar: "LIBERADO" }[comando];
    const r = marcarPr({ pr: o.pr, eu: o.eu, acao, motivo: o.motivo === true ? "" : o.motivo ?? "", pedido: o.pedido ?? "", dono: o.dono ?? "",
      holdDono: o.holdDono === true ? "x" : o.holdDono ?? "", liberacaoDono: o.liberacaoDono === true ? "" : o.liberacaoDono ?? "" });
    console.log(r.recusado ? `RECUSADO: ${r.recusado}` : `#${o.pr}: ${acao} registrado por ${o.eu}`);
    if (r.recusado) process.exitCode = 3;
  } else if (comando === "estado-pr") {
    const e = estadoPr(o.pr);
    console.log(e.acao ? `#${o.pr}: ${e.acao === "HOLD" && e.dono && e.ativo ? `HOLD do dono (${e.dono})` : e.acao} por ${e.por} em ${e.quando.toISOString()}${e.motivo ? ` (${e.motivo})` : ""}${e.ativo ? " (ativo)" : " (expirado ou liberado)"}` : `#${o.pr}: livre`);
  } else if (comando === "quem") {
    const agora = new Date(), c = cotas(agora);
    const ha = (d) => { const m = Math.max(0, Math.floor((agora - d) / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
    for (const f of familias()) {
      const x = c[f] ?? {};
      const estado = x.semSinal ? `SEM COTA (sem sinal há mais de ${SEM_SINAL_MIN / 60} h)` : x.sem ? `SEM COTA${x.ate ? ` até ${x.ate.toISOString()}` : ""}` : x.baixa ? "COTA BAIXA" : "com cota";
      const pct = x.resta !== null && x.resta !== undefined ? `; resta ${x.resta}%${x.renova ? ` até ${x.renova.toISOString()}` : ""}` : "";
      const sinal = x.ultimo ? `; último sinal há ${ha(x.ultimo)} (${x.ultimo.toISOString()})` : "; nenhum sinal no histórico lido";
      console.log(`${f}: ${estado}${pct}${sinal}`);
    }
  } else if (comando === "pedir-revisao" || comando === "pedir-fila") {
    const tipo = comando === "pedir-fila" ? "fila" : "revisao";
    const texto = o.arquivo ? readFileSync(o.arquivo === "-" ? 0 : o.arquivo, "utf8") : (o.texto === true ? "" : o.texto ?? "");
    const para = o.para === true ? "" : o.para ?? "";
    const commits = commitsDoPr(o.pr);
    if (tipo === "fila") {
      const cf = commits ? conflitosDoPr(o.pr) : null;
      if (cf?.conflitos.length) console.log(`ATENÇÃO: #${o.pr} conflita agora com ${cf.conflitos.join(", ")} (main e fila de integração); quem pegar este pedido vai recusá-lo. Junte o main depois que ele entrar e peça de novo.`);
      const marca = estadoPr(o.pr);
      if (marca.ativo) console.log(`ATENÇÃO: #${o.pr} está com ${marca.acao} de ${marca.por}; enquanto ele valer, claim-enqueue não entrega o pedido. Se o trabalho acabou, rode release-pr --as "${marca.por}" --pr ${o.pr}.`);
    }
    console.log(`pedido registrado: ${pedir({ tipo, de: o.de, pr: o.pr, sha: o.sha, texto, para, exclui: o.exclui === true ? "" : o.exclui ?? "", commits })}`);
    {
      if (!commits) console.log("ATENÇÃO: não consegui ler os commits do PR; diga com --exclude as famílias que têm commits nele.");
      else {
        // Na fila, quem revisou este head pelo correio também fica de fora (o pedido já o grava em Exclui).
        const fora = new Set([...(tipo === "revisao" ? commits.familias : [...revisoresDoHead(o.pr, o.sha)]), familia(o.de),
          ...String(o.exclui === true ? "" : o.exclui ?? "").split(",").map((n) => n.trim()).filter(Boolean).map(familia)]);
        console.log(tipo === "revisao" ? `famílias com commits no PR (ficam de fora): ${[...commits.familias].sort().join(", ") || "nenhuma além do autor"}`
          : `famílias com commits no PR (podem enfileirar, FQ (1)): ${[...commits.familias].sort().join(", ") || "nenhuma além do autor"}`);
        const podem = [...FAMILIAS].filter((f) => !fora.has(f));
        console.log(`${tipo === "fila" ? "podem enfileirar (sem o autor, quem revisou este head pelo correio e os excluídos; confira revisões feitas fora do correio)" : "podem revisar"}: ${podem.join(", ") || "NENHUMA família; peça ao coordenador"}`);
        if (commits.desconhecidas.size) console.log(`sem família conhecida (confira à mão e use --exclude): ${[...commits.desconhecidas].join(", ")}`);
      }
    }
    if (para) {
      const { sem, com } = avisoCota([para], o.de);
      if (sem.length) console.log(`ATENÇÃO: ${para} está sem cota${sem[0].ate ? ` até ${sem[0].ate.toISOString()}` : ""}; o pedido fica aberto para qualquer outra família com cota: ${com.join(", ") || "nenhuma declarada ainda"}`);
    }
  } else if (comando === "revisoes" || comando === "fila") {
    const tipo = comando === "fila" ? "fila" : "revisao";
    const lista = pedidos(tipo).filter((p) => o.todas || p.estado !== "feito");
    if (!lista.length) console.log("nenhum pedido aberto");
    for (const p of lista) console.log(`${p.id}  #${p.pr} @${p.sha}  autor ${p.autor}  ${p.estado}${p.tomadoPor ? ` por ${p.tomadoPor}` : ""}`);
  } else if (comando === "pegar-revisao" || comando === "pegar-fila") {
    if (!o.eu) throw new Error("--as é obrigatório");
    const r = pegar({ tipo: comando === "pegar-fila" ? "fila" : "revisao", eu: o.eu });
    if (r.espera) console.log(`nada para pegar: ${r.espera}`);
    else {
      console.log(`pegou: ${r.pedido.id}`);
      if (r.aviso) console.log(`conferência: ${r.aviso}`);
      if (comando === "pegar-fila") console.log(`a tomada vence em ${TOMADA_FILA_MIN} minutos; se precisar de mais, renove: node agent-mail.mjs renew-enqueue --as "${o.eu}" ${r.pedido.id}`);
      console.log(r.pedido.texto);
    }
  } else if (comando === "set-switch") {
    if (!o.eu || !o.nome || Boolean(o.ligar) === Boolean(o.desligar)) throw new Error('use: set-switch --as "Claude 5 ibqho" --name record-review|ready-check|on-call --on --reason "por quê" --request <comentário na #4932> (ou --off, por qualquer sessão)');
    mudarChave({ nome: o.nome, eu: o.eu, ligar: Boolean(o.ligar), motivo: o.motivo === true ? "" : o.motivo ?? "", pedido: o.pedido, dono: o.dono });
    console.log(`interruptor ${o.nome}: ${o.ligar ? "LIGADO" : "DESLIGADO"} por ${o.eu}`);
  } else if (comando === "list-switches") {
    const commit = buscar();
    for (const n of CHAVES) { const c = chave(n, commit); console.log(`${n}: ${c.ligada ? "LIGADO" : "DESLIGADO"}${c.por ? ` (por ${c.por} em ${c.quando?.toISOString()}${c.motivo ? `: ${c.motivo}` : ""})` : " (nunca ligado)"}`); }
  } else if (comando === "record-review") {
    if (!o.eu) throw new Error("--as é obrigatório");
    const id = registrarRevisao({ eu: o.eu, pr: o.pr, sha: o.sha, resultado: o.resultado, link: o.link === true ? "" : o.link });
    console.log(`registrado: ${id}`);
    const r = registros(o.pr).find((x) => x.id === id);
    if (r?.faltas.length) console.log(`NÃO CONFERIDO: ${r.faltas.join("; ")}${r.excluiDaFila ? "" : ". Este registro NÃO tira a sua família da fila até o coordenador confirmar (confirm-review-record)."}`);
    console.log("Lembrete: a prova da revisão continua sendo o comentário no PR (CO (c)); o registro só tira a família da fila deste head.");
  } else if (comando === "list-review-records") {
    const lista = registros(o.pr);
    if (!lista.length) console.log(`#${o.pr}: nenhum registro de revisão`);
    for (const r of lista) console.log(`${r.id}  #${r.pr} @${r.sha.slice(0, 10)}  ${r.resultado}  por ${r.por}  ${r.faltas.length ? `NÃO CONFERIDO: ${r.faltas.join("; ")}` : "conferido"}${r.confirmado ? "  (confirmado pelo coordenador)" : ""}  ${r.excluiDaFila ? "tira a família da fila deste head" : "não tira ninguém da fila"}`);
  } else if (comando === "confirm-review-record") {
    if (!o.eu) throw new Error("--as é obrigatório");
    confirmarRegistro({ eu: o.eu, id: o._[0], motivo: o.motivo === true ? "" : o.motivo ?? "", pedido: o.pedido, dono: o.dono });
    console.log(`confirmado: ${o._[0]}`);
  } else if (comando === "release-take") {
    if (!o.eu) throw new Error("--as é obrigatório");
    const tipo = String(o._[0] ?? "").includes("-") && pedidos("revisao").some((x) => x.id === o._[0]) ? "revisao" : "fila";
    const p = liberarTomada({ tipo, eu: o.eu, id: o._[0], motivo: o.motivo === true ? "" : o.motivo ?? "", pedido: o.pedido, dono: o.dono });
    console.log(`liberada: a tomada de ${o._[0]} (#${p.pr}), que estava com ${p.tomadoPor}; o pedido volta à ordem`);
  } else if (comando === "renovar-revisao" || comando === "renovar-fila") {
    if (!o.eu) throw new Error("--as é obrigatório");
    const tipo = comando === "renovar-fila" ? "fila" : "revisao";
    const p = renovar({ tipo, eu: o.eu, id: o._[0] });
    console.log(`renovado: ${o._[0]} (#${p.pr}) por mais ${tipo === "fila" ? TOMADA_FILA_MIN : TOMADA_MIN} minutos`);
  } else if (comando === "concluir-revisao" || comando === "concluir-fila") {
    if (!o.eu) throw new Error("--as é obrigatório");
    const texto = o.arquivo ? readFileSync(o.arquivo === "-" ? 0 : o.arquivo, "utf8") : (o.texto === true ? "" : o.texto ?? "");
    const p = concluir({ tipo: comando === "concluir-fila" ? "fila" : "revisao", eu: o.eu, id: o._[0], resultado: o.resultado, texto });
    console.log(`concluído: #${p.pr} ${o.resultado}; o autor (${p.autor}) recebeu no correio`);
  } else if (comando === "devolver-revisao" || comando === "devolver-fila") {
    if (!o.eu) throw new Error("--as é obrigatório");
    const p = devolver({ tipo: comando === "devolver-fila" ? "fila" : "revisao", eu: o.eu, id: o._[0], motivo: o.motivo === true ? "" : o.motivo ?? "" });
    console.log(`devolvido: #${p.pr} @${p.sha}; outra família pode pegar agora`);
  } else if (comando === "retirar-fila" || comando === "retirar-revisao") {
    if (!o.eu) throw new Error("--as é obrigatório");
    const p = retirar({ tipo: comando === "retirar-fila" ? "fila" : "revisao", eu: o.eu, id: o._[0], motivo: o.motivo === true ? "" : o.motivo ?? "" });
    console.log(`retirado: #${p.pr} @${p.sha}; nenhum pedido passou na frente`);
  } else if (comando === "pendentes") {
    if (!o.de) throw new Error("--from é obrigatório");
    const lista = pendentes(o.de);
    if (!lista.length) console.log("tudo o que você mandou já foi lido");
    for (const p of lista) console.log(`${p.para}: ${p.id} (${p.minutos} min)${p.minutos >= ATRASO_MIN ? "  ATRASADA" : ""}`);
  } else {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n"));
    if (comando && comando !== "ajuda") process.exitCode = 2;
  }
}

if (process.argv[1] && /(?:^|[/\\])(?:agent-mail|correio)\.mjs$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((erro) => { console.error(semSegredo(erro?.message ?? erro)); process.exitCode = 1; });
}
