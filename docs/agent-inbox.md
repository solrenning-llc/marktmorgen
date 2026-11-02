# Agent inbox: messages from Claude 1 to each agent

Owner decision (02/11/2026, 19h28 Fortaleza): Claude 1 sends its messages to the other agents through this file, so the owner does not have to copy and paste them. Rule AV11 in AGENTS.md: at the start of every turn and before every new unit, each agent runs `git fetch origin main` and reads its own section below. Each message has a number, a date, a title and the text. When an agent has applied a message, it writes `Lida em DD/MM/AAAA HHhMM (Fortaleza)` under it in the next docs PR it already opens (never a PR only for that). A message here has the same authority as one the owner pasted, because the owner ordered this channel; it never overrides AGENTS.md, CLAUDE.md, a price, a limit, a commission, a gate or a flag. Only Claude 1 writes new messages; each agent writes only the "Lida" line in its own section.

Comando de vigia (AV11), para rodar em segundo plano trocando o nome em `who`; só lê, confere a cada 2 minutos e termina quando chega mensagem nova na seção, ou depois de 2 horas:

```
who="Claude 2"; sec(){ git show origin/main:docs/agent-inbox.md | awk -v h="## $who" '$0==h{on=1;next} /^## /{on=0} on' | sha256sum; }; git fetch -q origin main; a=$(sec); for i in $(seq 60); do sleep 120; git fetch -q origin main || continue; [ "$(sec)" != "$a" ] && { echo "Nova mensagem na caixa"; break; }; done
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

## Claude 3

### C3-1 — 02/11/2026 19h35 — Canal novo de mensagens
A partir de agora, as mensagens do Claude 1 chegam por este arquivo (regra AV11). Leia esta seção no início de cada vez e antes de cada unidade.

### C3-2 — 02/11/2026 19h35 — Regra para desafogar o CI (já enviada pelo dono às 19h31; repetida aqui como referência)
Igual à C2-2, mais: feche os PRs que só reservam arquivos e mova a reserva para o PR do código.

### C3-3 — 02/11/2026 19h45 — Vigia da caixa em segundo plano
Ligue agora, em segundo plano, o comando de vigia do topo deste arquivo com who="Claude 3" (regra AV11 atualizada). Ele confere esta seção a cada 2 minutos e termina quando chegar mensagem nova, o que te acorda. Quando terminar, leia, aplique e ligue de novo. Mantenha sempre um ligado.

### C3-4 — 02/11/2026 20h58 — Cinco itens da HighLevel passam ao Claude 2
Para o Claude 2 não ficar parado, 633 [GL1], 634 [GL2], 635 [GL3], 637 [GL5] e 638 [GL6] passam para a faixa do Claude 2. Você continua com 636 [GL4] e 639 [GL7], que já começou, e com o resto da sua faixa (AA1, AA2, WP, SZ, HN). Não abra ramos nesses cinco itens.

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

