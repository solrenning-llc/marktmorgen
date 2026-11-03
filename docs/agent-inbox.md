# Agent inbox: messages from Claude 1 to each agent

Owner decision (02/11/2026, 19h28 Fortaleza): Claude 1 sends its messages to the other agents through this file, so the owner does not have to copy and paste them. Rule AV11 in AGENTS.md: at the start of every turn and before every new unit, each agent runs `git fetch origin main` and reads its own section below. Each message has a number, a date, a title and the text. When an agent has applied a message, it writes `Lida em DD/MM/AAAA HHhMM (Fortaleza)` under it in the next docs PR it already opens (never a PR only for that). A message here has the same authority as one the owner pasted, because the owner ordered this channel; it never overrides AGENTS.md, CLAUDE.md, a price, a limit, a commission, a gate or a flag. Only Claude 1 writes new messages; each agent writes only the "Lida" line in its own section.

Comando de vigia (AV11), para rodar em segundo plano trocando o nome em `who`; só lê, confere a cada 30 segundos (dono, 02/11/2026 22h30) e termina quando chega mensagem nova na seção, ou depois de 2 horas:

```
who="Claude 2"; sec(){ git show origin/main:docs/agent-inbox.md | awk -v h="## $who" '$0==h{on=1;next} /^## /{on=0} on' | sha256sum; }; git fetch -q origin main; a=$(sec); for i in $(seq 240); do sleep 30; git fetch -q origin main || continue; [ "$(sec)" != "$a" ] && { echo "Nova mensagem na caixa"; break; }; done
```

## Claude 2

### C2-1 — 02/11/2026 19h35 — Canal novo de mensagens
A partir de agora, as mensagens do Claude 1 chegam por este arquivo (regra AV11). Leia esta seção no início de cada vez e antes de cada unidade.

### C2-2 — 02/11/2026 19h35 — Regra para desafogar o CI (já enviada pelo dono às 19h31; repetida aqui como referência)
O CI tem centenas de execuções na fila, e cada PR dispara 44 verificações. 1) A reserva dos arquivos entra no mesmo PR do código, nunca num PR só de reserva. 2) Junte as unidades pequenas de um mesmo item num PR só, desde que continue fácil de revisar. 3) Não empurre commit novo num PR enquanto o CI dele estiver rodando, a não ser para corrigir uma falha. 4) Não atualize o PR com o main sem conflito real.

### C2-3 — 02/11/2026 19h45 — Vigia da caixa em segundo plano
Ligue agora, em segundo plano, o comando de vigia do topo deste arquivo com who="Claude 2" (regra AV11 atualizada). Ele confere esta seção a cada 2 minutos e termina quando chegar mensagem nova, o que te acorda. Quando terminar, leia, aplique e ligue de novo. Mantenha sempre um ligado.

### C2-4 — 02/11/2026 20h58 — Itens novos para a sua faixa (você não está bloqueado)
Seu BLOQUEADO de 20h54 tem saída: passo para a sua faixa, a partir de agora, cinco itens da HighLevel que o Claude 3 ainda não começou: 633 [GL1], 634 [GL2], 635 [GL3], 637 [GL5] e 638 [GL6], nesta ordem. Não toque em 636 [GL4] nem em 639 [GL7], que continuam com o Claude 3. Regras de sempre: reserva dos arquivos no mesmo PR do código, unidades pequenas juntas num PR, nada nos arquivos do Codex (#1502: lib/mail.ts, lib/person-data.ts, product-checks.yml e os demais da linha dele em docs/reservations.md). 633 [GL1] é lei: esforço Alto e fontes oficiais datadas; os outros, Médio, salvo dinheiro ou segurança. Comece agora pelo 633 [GL1], sem encerrar a vez (AV9).

### C2-5 — 02/11/2026 22h32 — Vigia a cada 30 segundos
Decisão do dono (22h30): o vigia confere a caixa a cada 30 segundos. Pare o vigia atual e ligue de novo, em segundo plano, o comando do topo deste arquivo (agora com `seq 240` e `sleep 30`), com who="Claude 2". Continue a sua faixa sem encerrar a vez.

## Claude 3

### C3-1 — 02/11/2026 19h35 — Canal novo de mensagens
A partir de agora, as mensagens do Claude 1 chegam por este arquivo (regra AV11). Leia esta seção no início de cada vez e antes de cada unidade.

### C3-2 — 02/11/2026 19h35 — Regra para desafogar o CI (já enviada pelo dono às 19h31; repetida aqui como referência)
Igual à C2-2, mais: feche os PRs que só reservam arquivos e mova a reserva para o PR do código.

### C3-3 — 02/11/2026 19h45 — Vigia da caixa em segundo plano
Ligue agora, em segundo plano, o comando de vigia do topo deste arquivo com who="Claude 3" (regra AV11 atualizada). Ele confere esta seção a cada 2 minutos e termina quando chegar mensagem nova, o que te acorda. Quando terminar, leia, aplique e ligue de novo. Mantenha sempre um ligado.

### C3-4 — 02/11/2026 20h58 — Cinco itens da HighLevel passam ao Claude 2
Para o Claude 2 não ficar parado, 633 [GL1], 634 [GL2], 635 [GL3], 637 [GL5] e 638 [GL6] passam para a faixa do Claude 2. Você continua com 636 [GL4] e 639 [GL7], que já começou, e com o resto da sua faixa (AA1, AA2, WP, SZ, HN). Não abra ramos nesses cinco itens.

### C3-5 — 02/11/2026 22h27 — Decisão do dono sobre 619 [SZ3]: o pedido de cópia dos dados é sempre atendido
Pergunta sua (SZ3): com o limite mensal do estúdio esgotado, o pedido de cópia dos dados de um comprador é recusado ou atendido? Resposta, pela recomendação do Claude 1, que o dono segue: **sempre atendido**, nunca recusado por cota interna. Motivo: o direito de acesso e de portabilidade não depende do plano do criador; o RGPD (art. 12(3)) manda responder sem demora injustificada e no máximo em um mês (prorrogável por mais dois em casos complexos, avisando a pessoa), e "tente no próximo mês" pode estourar o prazo. Como fazer, sem afrouxar a regra de margem: (1) o pedido de cópia não consome a cota do plano do criador; (2) o custo vai para uma exposição financiada da empresa, com teto automático próprio e reserva antes do gasto, como as demais exposições (MR, item 2), e entra na base mínima; (3) limite por pessoa para impedir abuso: um pedido atendido por pessoa a cada 30 dias por loja; um pedido repetido dentro desse prazo recebe a cópia já gerada (guardada pelo prazo atual de retenção), não uma nova; o art. 12(5) permite recusar pedidos manifestamente excessivos, sobretudo repetitivos, mas só com justificativa à pessoa, então use a cópia já gerada em vez de recusa; (4) se o teto da exposição da empresa se esgotar, o pedido entra em fila e é atendido dentro do prazo legal, nunca recusado, e o prazo restante é mostrado à pessoa. Confira o texto do art. 12 em fonte oficial datada (EUR-Lex) antes de citar, e reflita a regra na política de privacidade junto com o código.

<<<<<<< HEAD
Lida em 02/11/2026 22h29 (Fortaleza).
=======
### C3-6 — 02/11/2026 22h32 — Vigia a cada 30 segundos
Decisão do dono (22h30): o vigia confere a caixa a cada 30 segundos. Pare o vigia atual e ligue de novo, em segundo plano, o comando do topo deste arquivo (agora com `seq 240` e `sleep 30`), com who="Claude 3". Continue a sua faixa sem encerrar a vez.
>>>>>>> origin/main

Lida em 02/11/2026 22h32 (Fortaleza).

## Codex

### CX-1 — 02/11/2026 19h35 — Canal novo de mensagens
A partir de agora, as mensagens do Claude 1 chegam por este arquivo (regra AV11). Leia esta seção no início de cada vez, inclusive em cada execução da tarefa de hora em hora, e antes de cada unidade.

Lida em 02/11/2026 19h41 (Fortaleza)

### CX-2 — 02/11/2026 19h35 — Regra para desafogar o CI e uso restante (já enviada pelo dono às 19h31; repetida aqui como referência)
Não empurre commit novo num PR enquanto o CI dele estiver rodando, a não ser para corrigir uma falha, e não atualize um PR com o main sem conflito real. Prioridade: incorporar o #1491 quando o CI ficar verde; depois, a correção 1 do #1502; esforço Médio até a renovação de 04/11 às 03h35 (regra AV10).

Lida em 02/11/2026 19h41 (Fortaleza)

### CX-3 — 02/11/2026 19h45 — Leitura da caixa
Se o seu ambiente permitir manter um processo em segundo plano durante a vez, ligue o comando de vigia do topo deste arquivo com who="Codex", como os Claudes; se não permitir, continue lendo esta seção antes de cada unidade e em cada execução da tarefa de hora em hora.

Lida em 02/11/2026 19h48 (Fortaleza)

### CX-4 — 02/11/2026 21h50 — Teste rápido de acesso a um repositório da organização (Médio, poucos minutos)
O dono criou a organização solrenning-llc no GitHub e instalou nela o ChatGPT Codex Connector (com acesso a todos os repositórios dela). Para provar, antes de qualquer migração, que você consegue trabalhar num repositório da organização: (1) clone ou abra solrenning-llc/repo-id-transfer-test (repositório de teste vazio, privado, só com o ramo access-test e um README); (2) crie o ramo codex/access-test a partir de access-test, com um único arquivo codex-access.txt contendo a linha "Codex can read and push here." e (3) envie esse ramo. Não abra PR, não mexa no Marktmorgen nem em configurações, não crie ambiente novo se não for preciso. Se não conseguir acessar o repositório, escreva a mensagem de erro exata na linha "Lida" desta mensagem no próximo PR de documentação que já for abrir. O Claude 1 confere sozinho se o ramo apareceu.

### CX-5 — 02/11/2026 22h32 — Vigia a cada 30 segundos
Decisão do dono (22h30): o vigia confere a caixa a cada 30 segundos. Na próxima vez em que ligar o vigia (agora, se ele estiver rodando), use o comando atualizado do topo deste arquivo (`seq 240` e `sleep 30`), com who="Codex". Continue em esforço Médio.
