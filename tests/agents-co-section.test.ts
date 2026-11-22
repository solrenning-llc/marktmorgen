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
is("the install command takes the tool from main and installs it only with the reviewed SHA-256 (owner, OWNER-20261121-1904, step 1)",
  [co.includes("git fetch -q https://github.com/solrenning-llc/marktmorgen main && git show FETCH_HEAD:tooling/agent-mail/agent-mail.mjs > ~/.agent-mail/new.mjs"),
   co.includes(`~/.agent-mail/new.mjs ${readFileSync("tooling/agent-mail/agent-mail.sha256", "utf8").slice(0, 64)}\``),
   co.includes("repo-id-transfer-test +correio:refs/agent-mail/tool"), co.includes("/tmp/agent-mail.mjs")], [true, true, false, false]);
is("the watcher, waking on mail and on review or queue requests", co.includes('node ~/.agent-mail/agent-mail.mjs watch --as "Claude N" --also review,enqueue'), true);
is("the correio branch holds only data; the code is reviewed in tooling/agent-mail/", [/O ramo `correio` guarda só dados/.test(co), /`tooling\/agent-mail\/` do main deste repositório, revisado por PR/.test(co)], [true, true]);
is("the Codex reads it at each hourly task", /Codex[^.]*hora em hora/.test(co), true);
is("the Codex also reads it before each unit and at least every 15 minutes while working (owner, 22/11/2026)", /Codex[^.]*antes de cada unidade nova e pelo menos a cada 15 minutos/.test(co), true);
is("a family without signal for more than 2 hours counts as without quota (OWNER-20261122-0121-MAIL-AVAILABILITY)", /sem sinal há mais de 2 horas é tratada como sem cota/.test(co), true);
is("the percent of quota and the low-quota rule are taught", [co.includes("`set-quota --remaining 35 --renews <data>`"), /com 10% ou menos, o correio avisa as outras famílias/.test(co)], [true, true]);

part("everything the owner asked it to cover");
for (const command of ["send", "ack", "request-review", "claim-review", "complete-review", "request-enqueue", "claim-enqueue", "complete-enqueue",
  "set-quota", "list-quotas", "claim-pr", "hold-pr", "release-pr", "pr-status", "list-pending", "renew-enqueue", "renew-review"]) is(`names \`${command}\``, co.includes(`\`${command}`), true);
is("the queue keeps its order: only the oldest open request, one at a time, another family", [/mais antigo ainda aberto, um de cada vez/.test(co), /Nenhum pedido mais novo passa na frente/.test(co)], [true, true]);
is("review goes to another family, and past a reviewer without quota", [/família diferente da do autor/.test(co), /só enquanto ele tem cota/.test(co)], [true, true]);
is("a mark set in the mailbox is also written on the PR, where FQ (1), AC (m) and AC (p) read it", [/além do CLAIMED, do UNCLAIMED e do HOLD/.test(co), /no próprio PR, que é onde FQ \(1\), AC \(m\) e AC \(p\) a leem/.test(co), /no lugar do CLAIMED/.test(co)], [true, true, false]);
is("the enqueuer checks `pr-status` and the PR's comments, and a held first request waits", [/inclusive o `pr-status` do PR e os comentários do próprio PR/.test(co), /HOLD, ou CLAIMED de outra família, no correio, `claim-enqueue` não o entrega/.test(co)], [true, true]);
is("the sender learns that the recipient has no quota", /Quem envia para um agente sem cota é avisado na hora/.test(co), true);
is("asking the owner to relay only when there is a problem", /\(h\) \*\*Pedir ao dono para passar um recado\*\* só em caso de problema/.test(co), true);
part("review only by a family with no commit on the PR (owner, 21/11, #3929)");
is("quotes the owner's request", co.includes("gera regra para erro assim nao ocorrer mais, para quem pedir revisao só pedir a quem realmente pode fazer"), true);
is("request-review excludes every family with a commit, by itself", /`request-review`, que lê os commits do PR além do main e deixa de fora, sozinho, toda família com commit nele/.test(co), true);
is("claim-review checks again and returns it", /`claim-review` confere de novo, porque o head pode ter mudado, e devolve sozinho/.test(co), true);
is("a request outside the mailbox names only a family with no commit", /um pedido feito fora do correio \(no PR ou no canal\) só nomeia revisor de família sem commit no PR/.test(co), true);
is("a reviewer who finds its own family's commit returns at once", /devolve na hora \(`release-review`\), sem revisar/.test(co), true);

part("after the transition, the other sections' channel means the mailbox (j)");
is("(j) says when the transition ends, checkably", /termina quando `list-pending` do aviso de boas-vindas do correio não mostrar mais nenhuma família/.test(co), true);
for (const [what, command] of [["fila #N @sha", "request-enqueue"], ["re-review needed", "request-review"], ["CLAIMED, UNCLAIMED e HOLD", "claim-pr"], ["falta de uso", "set-quota --exhausted --until"]] as const)
  is(`(j) maps "${what}" to \`${command}\``, new RegExp(`${what.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\n]*\`${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(co), true);
is("what is written on the PR stays on the PR", /Continuam onde estão, porque não são conversa entre agentes: o que se escreve no próprio PR/.test(co), true);
is("main-vermelho and prs-parados stay", [/a issue `main-vermelho` \(MV \(a\)\)/.test(co), /o relatório `prs-parados` \(PV \(c\)\)/.test(co)], [true, true]);
part("command names, queue take and identity (owner, 21/11/2026)");
is("commands are in American English, with both of the owner's requests", [co.includes("os comandos devem ser escritos de maneira tecnicamente correta em ingles americano"), co.includes("os comandos devem ser escritos usando termos tecnicamente corretos em ingles americano")], [true, true]);
is("no earlier command name (Portuguese or the first English draft) is taught in CO", /`(enviar|confirmar|vigiar|pendentes|cota|quem|reivindicar|segurar|liberar|estado-pr|(pedir|pegar|concluir|devolver)-(revisao|fila)|(take|return|withdraw)-(review|enqueue)|quotas?|pending|claim|hold|release)[` ]/.test(co), false);
is("a queue take lapses in 10 minutes and only the taker renews it; review keeps 30", [/Uma tomada sem conclusão em 10 minutos/.test(co), /`renew-enqueue`, que só a sessão que pegou pode usar/.test(co), /na revisão, o prazo continua de 30 minutos/.test(co)], [true, true, true]);
is("claim-enqueue checks the merge queue and concludes what is already queued", /contra cada grupo da fila de integração do GitHub, e conclui sozinho como recusado o que conflita e como enfileirado o que já está nessa fila ou no main/.test(co), true);
is("(k) identity: the session from the environment, refusal of another family's name, and the limit said plainly", [/\(k\) \*\*Identidade\.\*\*/.test(co), /recusa escrever com o nome de outra família/.test(co), /não é assinatura criptográfica/.test(co)], [true, true, true]);
part("(l) switches and review records (owner, OWNER-20261121-1749)");
is("(l) cites the owner's authorization", co.includes("OWNER-20261121-1749-QUEUE-IMPROVEMENTS-AUTH"), true);
is("switches start off, only the named session turns one on (full session id, owner's order step 2), anyone turns one off", [/começa desligado/.test(co), /só a sessão nomeada, Claude 5 ibqho \(`session_012ST5ibqhoHCYrphJXU5az3`\), conferida pelo identificador completo/.test(co), /qualquer sessão o desliga/.test(co)], [true, true, true]);
is("privileged actions: the backup's three cases, distance, the #4932 request and the stated limit (C1-20261121-2036-C6-1)", [/a reserva, Claude 1 A \(`session_01DKvYQaxPrZTrVdXNwosXYi`\), só em três casos/.test(co), /nunca age num PR que escreveu, revisou ou enfileirou/.test(co), /pedido do coordenador publicado na #4932 \(`--request`\)/.test(co), /isso não é autenticação/.test(co)], [true, true, true, true]);
is("record-review needs the exact head and the PR comment link", /`record-review`, com o head exato e o link do comentário da revisão no PR, ambos obrigatórios/.test(co), true);
is("the PR comment stays the only proof of a review (2.1)", /o comentário no PR continua sendo a única prova da revisão para FQ \(1\), RQ e CV/.test(co), true);
is("a record counts only for its head (2.3)", /o registro vale só para o head registrado; um head novo o anula/.test(co), true);
is("unchecked records are shown as such, and unidentified ones take no one out until confirmed (2.4, R3)", [/aparece como NÃO CONFERIDO/.test(co), /não tira ninguém da fila até o coordenador confirmá-lo \(`confirm-review-record`\)/.test(co)], [true, true]);
is("it ends with the standard sentence", co.trim().endsWith("Esta regra não muda nenhum preço, limite, comissão, trava, flag ou proibição deste arquivo."), true);

done();
