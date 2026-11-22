#!/usr/bin/env node
// Os casos da auditoria independente da ferramenta (C5-20261121-1755 e C5-20261121-1835, versão auditada aff69c9) e os
// testes que cobrem cada um (dono, OWNER-20261121-1904-MAIL-TOOL-FIX-ORDER, passo 7: "um teste que reprova antes para
// cada caso da auditoria"). Roda agent-mail.test.mjs contra a ferramenta dada e mostra, por caso, quantas verificações o
// cobrem e quantas falham. Na versão atual, todo caso precisa de pelo menos uma verificação e de nenhuma falha; contra a
// versão auditada, todo caso precisa de pelo menos uma falha (é o "reprova antes").
//
//   node audit-cases.mjs [caminho/da/agent-mail.mjs] [--expect fail]
//
// Uma verificação é identificada por "<seção> | <nome>", como o teste as imprime. Os limites que só uma identidade
// autenticada resolve (passo 8) aparecem à parte, sem teste fingido.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";


export const CASOS = [
  { id: "A1", grave: "GRAVE", texto: "o código da ferramenta mudava sem revisão e chegava a todos; a instalação não conferia hash",
    cobre: [/^version: /] },
  { id: "A2", grave: "ALTO", texto: "identidade falsificável; qualquer sessão da conta do Claude 5 era coordenador",
    cobre: [/^switches \(R1\) \| (only the named session|an unidentified session)/, /^privileged actions: /, /\| (only the named session confirms|another Claude 5 session cannot confirm|a request that does not name the record|the named session (confirms|does not confirm))/, /^unidentified writes are marked/] },
  { id: "A3", grave: "ALTO", texto: "um ligado com data no futuro não se desligava; a ordem vinha do nome do arquivo",
    cobre: [/\| (an ON whose instant is in the future|the switch follows the commit order|an OFF stamped far in the future)/] },
  { id: "A4", grave: "ALTO", texto: "só acrescentar valia só no cliente; a ordem da fila vinha do relógio de quem escreve; cópias antigas escreviam",
    cobre: [/^append-only check/, /\| (a request is placed by the commit that wrote it|the quota written last holds|the latest take is the one written last|an old copy cannot write)/] },
  { id: "A5", grave: "ALTO", texto: "a fila podia parar para sempre com uma tomada datada no futuro",
    cobre: [/\| (a take dated in the future|a CLAIMED dated in the future|a take renewed for more than 30 minutes|only the named session releases a take|the named session releases a stuck take|the release is announced to all)/] },
  { id: "A6", grave: "MÉDIO", texto: "qualquer um declarava outra família sem cota",
    cobre: [/\| (Claude 6 cannot declare Claude 3 out of quota|so Claude 3 still counts as with quota|the named session declares another family's quota|the same request is not used twice|a raw record of Claude 3's quota)/] },
  { id: "A7", grave: "MÉDIO", texto: "HOLD e liberação não tinham dono",
    cobre: [/\| (Claude 2 \(not the one who held it|a CLAIMED does not replace an active HOLD|the PR's author .* releases the HOLD|with two HOLDs on top of each other|the coordinator's named session releases it|a release request is used once|a raw release written by a session)/] },
  { id: "A8", grave: "MÉDIO", texto: "CLAIMED conferido por família, não por sessão",
    cobre: [/\| (another session of the same family cannot take the CLAIMED over|nor release it|another session of the same family does not hold that take)/] },
  { id: "A9", grave: "MÉDIO", texto: "a tomada seguia sem conferir; variáveis de teste desligavam conferências; git sem limite de tempo",
    cobre: [/^test variables only with the marker/, /^GitHub refs\/pull\/N\/head alone/, /^concurrency and order \| (on GitHub|so nothing holds|with the branch at|the take checks|an old request without)/, /\| a git command past its time limit/] },
  { id: "A10", grave: "MÉDIO", texto: "head por prefixo de 10 caracteres; podia mudar entre a tomada e o enfileiramento; o registro guardava o head do pedido",
    cobre: [/^step 4: a full head/, /^stale refs\/pull\/N\/head/, /^a backup branch at an old head/] },
  { id: "A11", grave: "LEVE", texto: "cada decisão lia o correio várias vezes", cobre: [/\(A11\)$/] },
  { id: "A12", grave: "LEVE", texto: "Preferência: ou Exclui: no texto livre virava campo", cobre: [/\(A12\)$/] },
  { id: "A13", grave: "LEVE", texto: "escritas não identificadas confirmavam mensagens de outros sem aviso", cobre: [/\(A13\)$/] },
  { id: "A14", grave: "LEVE", texto: "objetos do correio privado ficavam no clone do repositório público", cobre: [/\(A14\)$/] },
  { id: "A15", grave: "LEVE", texto: "record-review não conferia o veredito nem o autor do comentário", cobre: [/\(A15\)$/] },
  { id: "PoC1", grave: "prova", texto: "ligar um interruptor com a variável de sessão forjada (outra sessão da conta do Claude 5)",
    cobre: [/\| another Claude 5 session \(not the named one\) cannot turn a switch on/] },
  { id: "PoC3", grave: "prova", texto: "apagar um pedido e pôr um pedido com data antiga na frente da fila",
    cobre: [/\| a commit that deletes a request is reported/, /\| a request is placed by the commit that wrote it/] },
  { id: "API", grave: "prova", texto: "GitHub ou o main fora do ar: nada NÃO CONFERIDO segue",
    cobre: [/\| (a request that cannot be checked now is refused|main unreachable: a write is refused|the commits of the PR cannot be checked|gh down: the record is kept)/] },
];

/** O que só a identidade autenticada (proposta do passo 8) resolve: declarado, sem teste que finja resolver. */
export const LIMITES = [
  { id: "PoC2", texto: "pôr HOLD como outra família com a variável de sessão forjada: a ferramenta grava a sessão declarada, mas não consegue provar que é verdadeira" },
  { id: "A2 (resto)", texto: "a sessão vem de uma variável de ambiente, copiável e herdada por subagente; a linha Sessão: pode ser escrita à mão no git" },
];

/** As verificações do teste, como "<seção> | <nome>" com ok ou FAIL. */
export function verificacoes(saida) {
  const lista = [];
  let secao = "";
  for (const linha of String(saida).split("\n")) {
    const m = /^  (ok  |FAIL)  (.+)$/.exec(linha);
    if (m) lista.push({ ok: m[1] === "ok  ", chave: `${secao} | ${m[2]}` });
    else if (/^\S/.test(linha) && !/^\d+ checks/.test(linha)) secao = linha.trim();
  }
  return lista;
}

export function relatorio(saida) {
  const vs = verificacoes(saida);
  return CASOS.map((c) => {
    const delas = vs.filter((v) => c.cobre.some((re) => re.test(v.chave)));
    return { ...c, total: delas.length, falham: delas.filter((v) => !v.ok).length };
  });
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  // Só pela linha de comando: carregado por outro teste, o módulo só exporta os casos e o relatório.
  const aqui = `${dirname(resolve(process.argv[1]))}/`;
  const args = process.argv.slice(2);
  const ferramenta = resolve(args.find((a) => !a.startsWith("--") && a !== "fail") ?? `${aqui}agent-mail.mjs`);
  const esperaFalha = args.includes("--expect") && args[args.indexOf("--expect") + 1] === "fail";
  const r = spawnSync(process.execPath, [`${aqui}agent-mail.test.mjs`, ferramenta], { encoding: "utf8", timeout: 900_000 });
  const linhas = relatorio(`${r.stdout ?? ""}`);
  let problema = 0;
  console.log(`ferramenta: ${ferramenta}`);
  for (const c of linhas) {
    const ruim = c.total === 0 || (esperaFalha ? c.falham === 0 : c.falham > 0);
    if (ruim) problema++;
    console.log(`${ruim ? "PROBLEMA" : "ok      "}  ${c.id.padEnd(4)} ${c.grave.padEnd(5)}  ${String(c.total).padStart(2)} verificação(ões), ${String(c.falham).padStart(2)} falham  ${c.texto}`);
  }
  for (const l of LIMITES) console.log(`limite    ${l.id}: ${l.texto} (proposta de identidade autenticada, antes do passo 8)`);
  console.log(problema ? `\n${problema} caso(s) com problema` : `\ntodos os ${linhas.length} casos ${esperaFalha ? "reprovam nesta versão (o vermelho de antes)" : "cobertos e passando"}`);
  process.exitCode = problema ? 1 : 0;
}
