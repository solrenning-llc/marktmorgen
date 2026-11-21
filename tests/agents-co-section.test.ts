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
is("the sender learns that the recipient has no quota", /Quem envia para um agente sem cota é avisado na hora/.test(co), true);
is("asking the owner to relay only when there is a problem", /\(h\) \*\*Pedir ao dono para passar um recado\*\* só em caso de problema/.test(co), true);
is("it ends with the standard sentence", co.trim().endsWith("Esta regra não muda nenhum preço, limite, comissão, trava, flag ou proibição deste arquivo."), true);

done();
