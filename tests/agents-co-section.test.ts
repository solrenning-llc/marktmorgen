/**
 * The CO section of AGENTS.md (the agent mailbox, owner 21 November 2026): every agent reads AGENTS.md at the start of a
 * session, so the rule that all agents talk through the mail must stay at the very top, carry the owner's words, the
 * install and watcher commands, everything the owner asked it to cover (messages, review and queue requests in order,
 * quota, who works on each PR) and the one case for asking the owner to relay.
 * Reads the file as it is; no network.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const agents = readFileSync("AGENTS.md", "utf8");
const end = agents.indexOf("\n## ", 1);
const co = agents.slice(0, end < 0 ? undefined : end);

part("CO is the first section of AGENTS.md");
is("the file starts with the CO section", agents.startsWith("## CO — Correio dos agentes"), true);
is("one CO section", agents.split("\n## CO — ").length + (agents.startsWith("## CO — ") ? 1 : 0), 2);

part("the owner's words, kept whole");
for (const words of [
  "HÁ UM SÉRIO PROBLEMA. VCS NAO SE COMUNICAM.",
  "NAO QUERO PROIBIR ME PEDIR PARA PASSAR RECADO, MAS APENAS EM CASO DE PROBLEMA",
  "QUERO QUE RESOLVA INCLUSIVE PARA PEDIDO DE REVISAO, ENFILEIRAMENTO(OS ENFILEIRAMENTOS DEVEM RESPEITAR A FILA)",
  "QUERO TAMBEM QUE UM AGENTE SAIBA QUANDO O OUTRO NAO TEM COTA.",
  "ESSE NOVO MEIO DE COMUNICACAO DEVE SERVIR PARA TUDO UTIL ENTRE OS AGENTES",
]) is(`quotes: ${words.slice(0, 40)}...`, co.includes(words), true);

part("how to install it and keep the watcher on");
is("the install command",
  co.includes("git fetch -q https://github.com/solrenning-llc/repo-id-transfer-test +correio:refs/correio/ferramenta && git show refs/correio/ferramenta:correio.mjs > /tmp/correio.mjs"), true);
is("the watcher, waking on mail and on review or queue requests", co.includes('node /tmp/correio.mjs vigiar --eu "Claude N" --tambem revisao,fila'), true);
is("the Codex reads it at each hourly task", /Codex[^.]*hora em hora/.test(co), true);

part("everything the owner asked it to cover");
for (const command of ["enviar", "confirmar", "pedir-revisao", "pegar-revisao", "concluir-revisao", "pedir-fila", "pegar-fila", "concluir-fila",
  "cota", "quem", "reivindicar", "segurar", "liberar", "estado-pr", "pendentes"]) is(`names \`${command}\``, co.includes(`\`${command}`), true);
is("the queue keeps its order: only the oldest open request, one at a time, another family", [/mais antigo ainda aberto, um de cada vez/.test(co), /Nenhum pedido mais novo passa na frente/.test(co)], [true, true]);
is("review goes to another family, and past a reviewer without quota", [/família diferente da do autor/.test(co), /só enquanto ele tem cota/.test(co)], [true, true]);
is("a mark set in the mailbox is also written on the PR, where FQ (1), AC (m) and AC (p) read it", [/além do CLAIMED, do UNCLAIMED e do HOLD/.test(co), /no próprio PR, que é onde FQ \(1\), AC \(m\) e AC \(p\) a leem/.test(co), /no lugar do CLAIMED/.test(co)], [true, true, false]);
is("the enqueuer checks `estado-pr` and the PR's comments, and a held first request waits", [/inclusive o `estado-pr` do PR e os comentários do próprio PR/.test(co), /HOLD, ou CLAIMED de outra família, no correio, `pegar-fila` não o entrega/.test(co)], [true, true]);
is("the sender learns that the recipient has no quota", /Quem envia para um agente sem cota é avisado na hora/.test(co), true);
is("asking the owner to relay only when there is a problem", /\(h\) \*\*Pedir ao dono para passar um recado\*\* só em caso de problema/.test(co), true);
part("review only by a family with no commit on the PR (owner, 21/11, #3929)");
is("quotes the owner's request", co.includes("gera regra para erro assim nao ocorrer mais, para quem pedir revisao só pedir a quem realmente pode fazer"), true);
is("pedir-revisao excludes every family with a commit, by itself", /`pedir-revisao`, que lê os commits do PR além do main e deixa de fora, sozinho, toda família com commit nele/.test(co), true);
is("pegar-revisao checks again and returns it", /`pegar-revisao` confere de novo, porque o head pode ter mudado, e devolve sozinho/.test(co), true);
is("a request outside the mailbox names only a family with no commit", /um pedido feito fora do correio \(no PR ou no canal\) só nomeia revisor de família sem commit no PR/.test(co), true);
is("a reviewer who finds its own family's commit returns at once", /devolve na hora \(`devolver-revisao`\), sem revisar/.test(co), true);

part("after the transition, the other sections' channel means the mailbox (j)");
is("(j) says when the transition ends, checkably", /termina quando `pendentes` do aviso de boas-vindas do correio não mostrar mais nenhuma família/.test(co), true);
for (const [what, command] of [["fila #N @sha", "pedir-fila"], ["re-review needed", "pedir-revisao"], ["CLAIMED, UNCLAIMED e HOLD", "reivindicar"], ["falta de uso", "cota --sem --ate"]] as const)
  is(`(j) maps "${what}" to \`${command}\``, new RegExp(`${what.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\n]*\`${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(co), true);
is("what is written on the PR stays on the PR", /Continuam onde estão, porque não são conversa entre agentes: o que se escreve no próprio PR/.test(co), true);
is("main-vermelho and prs-parados stay", [/a issue `main-vermelho` \(MV \(a\)\)/.test(co), /o relatório `prs-parados` \(PV \(c\)\)/.test(co)], [true, true]);
is("it ends with the standard sentence", co.trim().endsWith("Esta regra não muda nenhum preço, limite, comissão, trava, flag ou proibição deste arquivo."), true);

done();
