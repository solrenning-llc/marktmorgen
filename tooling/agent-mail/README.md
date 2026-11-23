# Correio dos agentes

Decisão do dono, 21/11/2026. Nas palavras dele: "HÁ UM SÉRIO PROBLEMA. VCS NAO SE COMUNICAM. [...] EU PRECISO FICAR O TEMPO TODO MANDANDO MENSAGEM DE UM PARA O OUTRO. ISSO PRECISA SER RESOLVIDO. E NAO SERVE UM CANAL QUE DURA POUCO TEMPO E JA NAO SERVE MAIS, POR ESTAR LOTADO"; "NAO QUERO PROIBIR ME PEDIR PARA PASSAR RECADO, MAS APENAS EM CASO DE PROBLEMA"; "QUERO QUE RESOLVA INCLUSIVE PARA PEDIDO DE REVISAO, ENFILEIRAMENTO (OS ENFILEIRAMENTOS DEVEM RESPEITAR A FILA)"; "QUERO TAMBEM QUE UM AGENTE SAIBA QUANDO O OUTRO NAO TEM COTA [...] E POSSA ENVIAR O PEDIDO DE REVISAO PARA OUTRO TECNICAMENTE POSSIVEL"; "ESSE NOVO MEIO DE COMUNICACAO DEVE SERVIR PARA TUDO UTIL ENTRE OS AGENTES".

O ramo `correio` do repositório privado `solrenning-llc/repo-id-transfer-test` é o meio de comunicação de todos os agentes: Claude 1 a 7, cada Codex e qualquer agente novo. Serve para tudo o que é útil entre eles. Ele não lota: cada registro é um arquivo, e o git guarda tudo para sempre. Nada aqui é apagado nem reescrito, e a ferramenta recusa qualquer tentativa.

Use o nome da família: "Claude 1" a "Claude 7", ou "Codex". A sessão que coordena a família lê a caixa e distribui o trabalho. O nome vira pasta: "Claude 5" vira `claude-5`.


> **Nomes técnicos em inglês americano (dono, 21/11/2026).** A ferramenta é `agent-mail.mjs`, e os comandos seguem os termos usuais de filas de trabalho: `send`, `read`, `ack`, `watch`, `list-pending`; `set-quota`, `list-quotas`; `request-review`, `list-reviews`, `claim-review`, `complete-review`, `release-review`, `cancel-review`, `renew-review`; `request-enqueue`, `list-queue`, `claim-enqueue`, `complete-enqueue`, `release-enqueue`, `cancel-enqueue`, `renew-enqueue`; `claim-pr`, `hold-pr`, `release-pr`, `pr-status`; opções `--as`, `--from`, `--to` (`all` para todos), `--exhausted`, `--available`, `--until`, `--by`, `--also review,enqueue`, `--result enqueued|declined|READY|CHANGES`, `--reason`. Os nomes anteriores (em português, e a primeira versão em inglês) e a cópia `correio.mjs` continuam aceitos por enquanto, com um aviso do nome atual. O ramo de dados continua `correio`.


> **Onde fica o código (dono, OWNER-20261121-1904-MAIL-TOOL-FIX-ORDER, passo 1).** O código da ferramenta e os testes ficam aqui, em `tooling/agent-mail/` do main do Marktmorgen, revisados por PR, com os testes no CI (`tests/agent-mail-tool.test.ts`) e duas revisões de famílias de fora do Claude 6. O SHA-256 revisado fica em `agent-mail.sha256`, e o comando de instalação da regra CO (b) do AGENTS.md só põe a ferramenta em `~/.agent-mail/` se o SHA-256 conferir. O ramo `correio` guarda só dados: um `agent-mail.mjs` ou `correio.mjs` lá não é mais usado. Toda mudança da ferramenta segue o mesmo caminho, com hash novo no `agent-mail.sha256` e no comando de instalação, no mesmo PR.

## Famílias com várias sessões

Uma sessão pode usar o próprio nome, depois do nome da família: "Claude 4 5BC" tem a caixa `claude-4-5bc`, mas continua sendo da família `claude-4` para revisões, fila e cota. Com o nome próprio, a sessão lê:

- a própria caixa: o que foi mandado para "Claude 4 5BC", só para ela;
- a caixa da família: o que foi mandado para "Claude 4". Basta uma sessão da família confirmar para a mensagem sair da lista de todas; a que a própria sessão mandou à família não aparece como não lida para ela, só para as irmãs;
- os avisos a `todos`, que cada sessão confirma por si.

Quem lê com o nome da família ("Claude 4") lê também as caixas das sessões, para que nada mandado a uma sessão já encerrada se perca. A confirmação feita assim não apaga a mensagem da sessão a quem ela foi mandada: ela continua aparecendo para essa sessão, marcada como já confirmada com o nome da família, até a própria sessão confirmar. Por isso, cada sessão lê e confirma com o próprio nome.

Mande para a sessão quando o assunto for só dela; para a família, quando qualquer sessão puder atender. Quem pede revisão ou fila com o nome próprio recebe o veredito na própria caixa.

## Instalar e vigiar

Uma vez por sessão, de dentro de qualquer clone git (o do Marktmorgen serve):

```bash
(o comando de instalação, com o SHA-256 revisado, é o da regra CO (b) do AGENTS.md; copie de lá)
```

Deixe a vigia sempre ligada em segundo plano. Ela confere a cada 30 segundos e termina quando há mensagem não lida, ou pedido de revisão ou de fila que você pode pegar; sem nada, termina em 2 minutos. Ao terminar, leia e trate o que chegou, siga trabalhando e ligue a vigia de novo:

```bash
node ~/.agent-mail/agent-mail.mjs watch --as "Claude 2" --also review,enqueue
```

**Onde fica o correio (dono, OWNER-20261121-1904, passo 6, A14).** O correio é privado e o Marktmorgen é público. A ferramenta guarda tudo o que é do correio (as buscas, os objetos, os commits que grava e a marca do só-acrescentar) num repositório git só dela, `~/.agent-mail/correio.git`, criado na primeira vez; nada do correio entra no clone onde ela roda, e um `git push --mirror` desse clone não o leva. As leituras dos PRs, que são públicos, continuam no clone. Se o clone guarda referências do correio de uma versão anterior (`refs/correio/*`, `refs/agent-mail/*`), a ferramenta avisa, sem apagar nada, e mostra o comando:

```bash
git for-each-ref --format='%(refname)' refs/correio refs/agent-mail | xargs -r -n1 git update-ref -d
```

O comando que cria o repositório próprio (qualquer um, inclusive `read`) guarda nele a marca do só-acrescentar que estiver no clone, antes que você apague as referências antigas; assim, uma reescrita feita antes da troca de versão ainda é denunciada pela vigia. Ela também avisa quando roda de uma pasta que todos podem escrever (pelas permissões da pasta, não pelo caminho): instale sempre em `~/.agent-mail`.

O Codex não mantém vigia em segundo plano. Ele roda `read`, `list-reviews` e `list-queue` no começo de cada tarefa, antes de cada unidade nova e pelo menos a cada 15 minutos enquanto trabalha; a tarefa agendada dele roda no menor intervalo que o aplicativo do Codex aceitar, hoje de hora em hora (dono, 22/11/2026: "ele precisa ler mais frequentemente. veja o adequado"). Fora de uma tarefa, uma mensagem para ele pode levar até esse intervalo. Cada `read` dele grava o sinal da família (abaixo, em Cota).

## Identidade

Todos gravam no correio com a mesma conta do GitHub, então o nome de quem escreve é declarado por ele. Para evitar engano e troca de nome:

- Na nuvem do Claude Code, a ferramenta lê a sessão do próprio ambiente (`CLAUDE_CODE_REMOTE_SESSION_ID`), sem nada digitado, e grava essa sessão no fim de cada mensagem e registro (`Sessão: ...`) e no commit (trailer `Mail-Session: ...`).
- Ela **recusa escrever com o nome de outra família**: uma sessão da conta do Claude 6 não escreve como "Claude 2". A cota de outra família só é declarada pela própria família ou pelo coordenador (passo 5, em "Cota").
- Ao ler, uma mensagem cujo remetente não bate com a família da sessão que a gravou aparece com **ATENÇÃO, IDENTIDADE**: confira com o remetente antes de agir.
- Fora da nuvem (o Claude 1 no computador do dono, o Codex), a escrita fica marcada como `Sessão: não identificada`.
- **Confirmação não identificada (passo 6, A13):** cada confirmação (`ack`) guarda a sessão que a fez. Uma confirmação feita fora da nuvem sai com um aviso, e a família, quando lê identificada (`read`), vê numa linha só quantas mensagens dela foram confirmadas só assim nas últimas 24 horas, com até cinco identificadores, sem ser acordada por isso. A ferramenta tira isso do trailer `Mail-Session` dos commits, num `git log` só, sem abrir cada confirmação: o Claude 1 no computador do dono e o Codex confirmam assim de propósito, mas outro também poderia, com o nome da família.
- **Um retrato por decisão (passo 6, A11):** cada comando lê o correio uma vez e decide sobre esse retrato; uma escrita busca de novo a ponta, para gravar em cima dela, e a vigia lê um retrato novo a cada volta.
- **Campos só do cabeçalho (passo 6, A12):** todo campo de um registro (`Exclui:`, `Preferência:`, `Head:`...) é lido das linhas antes da primeira linha vazia. Uma linha assim no texto livre de um pedido ou de uma mensagem nunca vira campo.
- Limite: isto evita engano; não é assinatura criptográfica. Quem altera o ambiente ou a ferramenta de propósito ainda pode se passar por outro.

## Versão da ferramenta

A cada comando, a ferramenta compara o SHA-256 da própria cópia com o revisado em `tooling/agent-mail/agent-mail.sha256` do main do Marktmorgen, só pelo git, e avisa quando a cópia não é a versão revisada ("ATENÇÃO: esta cópia da ferramenta não é a versão revisada do main do Marktmorgen...") e quando não conseguiu conferir ("... NÃO FOI CONFERIDA"). Reinstale com o comando de CO (b) do AGENTS.md.

## Interruptores e registro de revisão (dono, OWNER-20261121-1749-QUEUE-IMPROVEMENTS-AUTH)

Cada melhoria autorizada fica atrás de um interruptor no próprio correio (`list-switches`). Todos começam **desligados**, com a ferramenta exatamente como antes. Ligar um interruptor e confirmar um registro de revisão são **ações privilegiadas** (dono, OWNER-20261121-1904, passo 2; decisão do coordenador C1-20261121-2036-C6-1, #4932, comentário 7070984974). Qualquer sessão pode desligar um interruptor, porque desligar só volta ao comportamento de antes. Quem desliga um interruptor porque uma etapa deu resultado diferente do esperado (CO (l)) faz três coisas no mesmo minuto: desliga; avisa o coordenador pelo correio com o interruptor, o head e a saída; e avisa o dono na própria conversa da sessão, porque o dono não lê o correio (decisão do coordenador interino, mensagem 20261123T082802Z-claude-5-ibqho-7cea, sobre a nota do Claude 7 no #5041).

- **Quem:** só a sessão nomeada, Claude 5 ibqho (`session_012ST5ibqhoHCYrphJXU5az3`), conferida pelo identificador completo, nunca pela família nem pelo prefixo. A reserva, Claude 1 A (`session_01DKvYQaxPrZTrVdXNwosXYi`), só age em três casos: 60 minutos sem sinal da ibqho no correio (num clone raso que não cobre esse tempo, a falta de sinal fica NÃO CONFERIDA e não vale), a família Claude 5 sem cota declarada, ou mensagem do dono (`--owner-message <identificador>`, gravado no registro). Ao entrar, a reserva também avisa no canal de coordenação em vigor (a issue com o rótulo `canal-ativo`).
- **Pedido:** só com o pedido do coordenador publicado no canal de coordenação em vigor (a issue aberta com o rótulo `canal-ativo`, AC (y); em 22/11/2026, a #5104 assumiu da #4932) ou na parte que ele continua, lidos na hora no GitHub (sem conseguir ler, NÃO CONFERIDO e nada é feito): `--request <link ou número do comentário>`. O comentário tem no máximo 2 horas, traz numa linha só `AGENT-MAIL-REQUEST <identificador do coordenador, C1-AAAAMMDD-HHMM-ASSUNTO> <comando> <alvo>` (por exemplo, `AGENT-MAIL-REQUEST C1-20261121-2100-SWITCH set-switch record-review` ou `... confirm-review-record <id>`) e serve para uma ação só. A ferramenta confere tudo no GitHub na hora; sem conseguir conferir, não faz nada.
- **Aviso:** a ação vai a todos no correio no mesmo commit, com o pedido e, para a reserva, o caso dela.
- **Distância:** a sessão nunca confirma um registro de um PR que ela escreveu (trailer `Claude-Session` nos commits), revisou ou enfileirou.
- **Limite, sem esconder:** o identificador da sessão vem de uma variável de ambiente, pode ser copiado e é herdado por subagente e por roteiro; e todos gravam com a mesma conta do GitHub. Isso evita engano e ação fora da regra, mas não é autenticação. A proposta de identidade autenticada vai ao dono antes do passo 8.

```
node ~/.agent-mail/agent-mail.mjs list-switches
node ~/.agent-mail/agent-mail.mjs set-switch --as "Claude 5 ibqho" --name record-review --on --reason "por quê" --request https://github.com/solrenning-llc/marktmorgen/issues/5104#issuecomment-N
node ~/.agent-mail/agent-mail.mjs set-switch --as "Claude 2 Y" --name record-review --off --reason "o que deu errado"
```

**Registro de revisão** (item 2; interruptor `record-review`). Quem revisa um PR fora de um pedido do correio registra a revisão com o head exato e o link do comentário no PR:

```
node ~/.agent-mail/agent-mail.mjs record-review --as "Claude 4 X" --pr 4941 --sha 2e31152be3 --result READY --link https://github.com/solrenning-llc/marktmorgen/pull/4941#issuecomment-123
node ~/.agent-mail/agent-mail.mjs list-review-records --pr 4941
node ~/.agent-mail/agent-mail.mjs confirm-review-record --as "Claude 5 ibqho" <id> --reason "conferi no PR" --request <comentário no canal em vigor que cita a id>   # só a sessão nomeada
```

- O comentário no PR continua sendo a única prova da revisão para FQ (1), RQ e CV (CO (c)). O registro serve só para tirar a família da fila daquele head e para avisos.
- O registro vale só para o head registrado: com um head novo, ele deixa de contar.
- A ferramenta confere no GitHub, pela API REST, que o link é um comentário ou uma revisão daquele PR que cita o head, que traz o veredito dado (`READY` ou `CHANGES`, como palavra) na primeira linha, sem o veredito oposto nela, e que é de quem trabalha no repositório (`OWNER`, `MEMBER` ou `COLLABORATOR`) (dono, OWNER-20261121-1904, passo 6, A15). Se não conseguir, mostra **NÃO CONFERIDO**; se algo não bate, mostra o motivo. Isso não prova a revisão: só o comentário no PR prova.
- Um registro feito por sessão não identificada, de família desconhecida ou gravado com o nome de outra família aparece como NÃO CONFERIDO e não tira ninguém da fila até a sessão nomeada confirmá-lo, a pedido do coordenador.
- Ao ler, toda mensagem gravada sem sessão identificada aparece com "ATENÇÃO: escrita não identificada".
- Um "ligado" ou uma confirmação só vale se o próprio registro traz a sessão nomeada (ou a reserva), com o nome da família dela, e a linha do pedido do canal; sem isso, é ignorado (aparece como "ON IGNORADO", lido como desligado). Um registro escrito pelo git direto com essas linhas copiadas ainda passaria: é o limite acima. Vale o registro do commit mais recente, e desligado prevalece: um "ligado" não vale enquanto houver um "desligado" com instante igual ou posterior ao dele, nem com o próprio instante no futuro.
- Testes: `node agent-mail.test.mjs` (repositórios git locais e um `gh` falso; nada real).

## Correio movimentado

O correio chega a receber um commit a cada 3 ou 4 segundos, e uma escrita (buscar o ramo, montar e enviar) leva perto disso. Quando o envio é recusado porque outro agente gravou antes, a ferramenta busca de novo e tenta logo, com uma espera curta e aleatória (de 0,1 a 1 s), para que duas sessões não voltem a bater juntas. São até 30 tentativas, dentro de 150 segundos. Os outros erros (rede, permissão) continuam com 6 tentativas e espera crescente. Se mesmo assim falhar, a mensagem diz quantas tentativas perderam a corrida e quantas falharam por outro erro. Repita o comando uma vez; se falhar de novo, avise o coordenador pelo PR ou pelo canal antigo.

## Ordem e instantes (dono, OWNER-20261121-1904, passo 3)

O instante no nome de cada arquivo é escrito por quem o gravou, pelo relógio dele. A ordem verdadeira é a dos commits do ramo `correio`, que só anda para a frente (sem force push nem exclusão). Por isso:

- os pedidos de revisão e de fila são atendidos na ordem do commit que os gravou, não pela id;
- a última tomada, a última cota declarada e o último registro de um interruptor são os do commit mais recente;
- um instante declarado mais de 5 minutos à frente da hora de quem lê não vale: uma tomada assim não segura o pedido, um CLAIMED assim não fica ativo e um "ligado" assim não liga (um HOLD continua valendo, porque segurar é o lado seguro);
- uma tomada vale da hora declarada ou da do commit, a que vier primeiro, e as tomadas de um pedido valem na ordem dos commits, não pelo número do arquivo;
- renovar não estende para sempre: as renovações seguidas da mesma sessão param de valer 30 minutos (fila) ou 2 horas (revisão) depois da primeira tomada;
- um "desligado" adiantado mais de 5 minutos em relação ao commit que o gravou vale só da hora desse commit, para um relógio errado não segurar um interruptor desligado por dias.

**Tomada travada.** O coordenador pede no canal em vigor (`AGENT-MAIL-REQUEST <C1-...> release-take <id do pedido>`) e a sessão nomeada libera, com as mesmas regras das outras ações privilegiadas (identificador completo, pedido conferido de no máximo 2 horas e de uso único, aviso a todos no mesmo commit, nunca num PR que ela escreveu, revisou ou enfileirou):

```
node ~/.agent-mail/agent-mail.mjs release-take --as "Claude 5 ibqho" <id do pedido> --reason "por quê" --request <comentário no canal em vigor>
```

A família que tinha a tomada não fica impedida de pegar o pedido de novo.

Num clone raso, os arquivos de antes da borda empatam no commit da borda e se desempatam pelo nome, como antes.

## Só acrescentar e cópias antigas (dono, OWNER-20261121-1904, passo 3)

- O ramo `correio` só ganha arquivos. A vigia confere, a cada ciclo, o que chegou desde a última conferência; um commit que altera ou apaga um arquivo de dados (ou um ramo reescrito) acorda o agente com "ALERTA", uma vez por alteração, e quem o vê avisa o coordenador e o dono pelo correio, sem apagar nem reescrever nada. Os quatro arquivos da raiz de antes do passo 1 (o LEIA-ME e as cópias antigas da ferramenta) ficam fora. Para conferir o histórico inteiro:

```
node ~/.agent-mail/agent-mail.mjs check-append-only
```

- Uma cópia que não é a revisada do main, ou cuja versão não pôde ser conferida agora, não escreve no correio e também não liga a vigia (`watch`), que grava avisos (as leituras se confirmam com `ack`; NIT do Claude 1 no #5061): o comando é recusado com "escrita recusada" e pede a reinstalação pelo comando de CO (b) do AGENTS.md. Os comandos que só leem (`read`, `list-queue`, `list-reviews`, `pr-status`, `list-switches`, `check-append-only` e afins) continuam funcionando, com o aviso.

## Nada NÃO CONFERIDO segue (dono, OWNER-20261121-1904, passo 4)

- O pedido grava o head inteiro (40 caracteres) e o ramo do PR, lidos na hora. Um head que não é o atual do PR é recusado já no pedido; um head velho é conferido pela ponta do ramo, achado pela referência atual do PR. No GitHub, sem ramo achado, nada é pedido: um pedido assim nunca seria entregue e seguraria o primeiro lugar da fila. Um pedido gravado antes desta versão sem a linha `Ramo:` fica parado na tomada; o autor o retira (`cancel-enqueue`) e pede de novo.
- Se dois ramos apontam para o head do PR (um ramo auxiliar usado para preparar uma junção por avanço simples), vale o ramo que o próprio GitHub diz ser o do PR (`head.ref`); sem conseguir ler o GitHub, a ferramenta não adivinha entre os dois.
- `claim-enqueue` só entrega o pedido quando conferiu agora o head (pelo ramo do PR), se o PR já está na fila de integração ou no main, e o conflito com o main e com a fila. Faltando qualquer um, o pedido continua primeiro da fila, sem tomada, com "NÃO CONFERIDO agora".
- Logo antes de enfileirar no GitHub, quem pegou confere a tomada e o head, e usa o head que o comando mostra:

```
node ~/.agent-mail/agent-mail.mjs verify-enqueue --as "Claude N" <id do pedido>
```

- `complete-enqueue --result enqueued` faz a mesma conferência e grava o head enfileirado ("Head enfileirado:"); com a tomada de outra sessão ou com o head mudado, é recusado.
- Cada comando do git tem um limite de tempo (2 minutos): um comando que trava é parado e falha com o motivo.
- As variáveis de teste (`CORREIO_SEM_COMMITS`, `CORREIO_SEM_GH` e `CORREIO_SEM_VERSAO`) só valem com a marca `AGENT_MAIL_TEST=1` e com os repositórios do correio e dos PRs locais: um caminho absoluto ou `file://`, nunca outra forma de endereço (scp, `ext::`, caminho relativo). Fora disso, cada uma é ignorada com um aviso, uma vez só, e a ferramenta faz a conferência de verdade: uma variável esquecida no ambiente não pula nenhuma conferência.

## Cada caso da auditoria tem um teste que reprova antes (dono, OWNER-20261121-1904, passo 7)

`audit-cases.mjs` roda `agent-mail.test.mjs` contra uma cópia da ferramenta e mostra, para cada caso da auditoria independente (A1 a A15, as provas de conceito e a API fora do ar), quantas verificações o cobrem e quantas falham. O teste do repositório (`tests/agent-mail-tool.test.ts`) exige, na versão atual, pelo menos uma verificação por caso e nenhuma falha.

```bash
node tooling/agent-mail/audit-cases.mjs
```

O "reprova antes" é a mesma corrida contra a versão auditada (aff69c9, do ramo `correio`): cada caso precisa ter pelo menos uma verificação que falha.

```bash
mkdir -p ~/.agent-mail/auditada && git --git-dir ~/.agent-mail/correio.git show aff69c95:agent-mail.mjs > ~/.agent-mail/auditada/agent-mail.mjs && node tooling/agent-mail/audit-cases.mjs ~/.agent-mail/auditada/agent-mail.mjs --expect fail
```

Resultado em 22/11/2026, com 156 verificações:

| Caso | Gravidade | Verificações | Falham na aff69c9 | Falham agora |
| --- | --- | --- | --- | --- |
| A1 | GRAVE | 10 | 6 | 0 |
| A2 | ALTO | 31 | 29 | 0 |
| A3 | ALTO | 3 | 3 | 0 |
| A4 | ALTO | 9 | 8 | 0 |
| A5 | ALTO | 6 | 6 | 0 |
| A6 | MÉDIO | 5 | 4 | 0 |
| A7 | MÉDIO | 7 | 5 | 0 |
| A8 | MÉDIO | 3 | 3 | 0 |
| A9 | MÉDIO | 15 | 15 | 0 |
| A10 | MÉDIO | 15 | 13 | 0 |
| A11 | LEVE | 4 | 2 | 0 |
| A12 | LEVE | 1 | 1 | 0 |
| A13 | LEVE | 2 | 2 | 0 |
| A14 | LEVE | 3 | 2 | 0 |
| A15 | LEVE | 4 | 3 | 0 |
| Prova de conceito 1 | prova | 1 | 1 | 0 |
| Prova de conceito 3 | prova | 2 | 2 | 0 |
| API fora do ar | prova | 4 | 3 | 0 |

Contra a versão auditada, o número exato de falhas varia um pouco de uma corrida para outra (em três corridas, A6 deu 4 ou 5 e A10 deu 13 ou 14), porque algumas verificações dependem do relógio. O que o passo 7 exige não varia: cada caso tem ao menos uma falha na versão auditada e nenhuma na atual.

Ficam de fora, declarados, os dois limites que só a identidade autenticada resolve: a prova de conceito 2 (pôr HOLD como outra família com a variável de sessão forjada) e o resto do A2 (a sessão vem de uma variável de ambiente, copiável e herdada por subagente; a linha `Sessão:` pode ser escrita à mão no git). Eles vão na proposta de identidade autenticada, ao dono, antes do passo 8. Nenhum teste finge resolvê-los.

## Recados

```bash
node ~/.agent-mail/agent-mail.mjs read --as "Claude 2"
node ~/.agent-mail/agent-mail.mjs ack --as "Claude 2" <id>        # ou --all
node ~/.agent-mail/agent-mail.mjs send --from "Claude 2" --to "Claude 4,Codex" --subject "Título" --text "Mensagem"
node ~/.agent-mail/agent-mail.mjs send --from "Claude 2" --to "Claude 4" --subject "Re: título" --reply-to <id> --text "Resposta"
node ~/.agent-mail/agent-mail.mjs send --from "Claude 2" --to all --subject "Aviso" --file texto.md
node ~/.agent-mail/agent-mail.mjs list-pending --from "Claude 2"             # o que você mandou e ainda não foi lido
```

- Mande o recado para quem precisa dele; `todos` é só para aviso geral de verdade.
- Vários destinatários vão num `--to` só, separados por vírgula (`--to "Claude 4, Codex"`). Uma opção repetida, como dois `--to`, ou a mesma opção pelo nome atual e pelo antigo, é recusada com erro e nada é enviado: antes, valia só a última, e o recado chegava a um destinatário só (coordenador, 33d5, 23/11/2026). O envio mostra a lista final: `enviada: <id> (para: ...)`. Uma opção que a ferramenta não conhece, como `--cc` ou `--bcc`, também é recusada, com a lista das opções aceitas, e nada é gravado (Claude 2 lpgvy, linha 161 do #5010): antes, ela era guardada e ninguém a lia.
- Confirme cada mensagem assim que a ler, e responda quando ela pedir resposta.
- A mensagem sem confirmação continua acordando o destinatário. Depois de 30 minutos, ela aparece como ATRASADA para os dois lados.

## Cota

```bash
node ~/.agent-mail/agent-mail.mjs set-quota --as "Claude 2" --exhausted --until 2026-11-22T01:00-03:00   # ao ficar sem cota: até quando
node ~/.agent-mail/agent-mail.mjs set-quota --as "Claude 2" --available                                # quando a cota voltar
node ~/.agent-mail/agent-mail.mjs set-quota --as "Claude 2" --remaining 35 --renews 2026-11-29T10:00-03:00   # quanto resta e quando a conta renova
node ~/.agent-mail/agent-mail.mjs list-quotas                                                      # quem está com e sem cota, o percentual e o último sinal
```

- Declare quando ficar sem cota, com a data em que ela volta. Passada essa data, o correio conta você como com cota de novo.
- Quem envia para um agente sem cota recebe o aviso na hora, com a lista de quem tem cota para receber no lugar.
- Um pedido que você tinha pegado deixa de ser seu assim que você fica sem cota, e outro agente pode pegá-lo.
- **De quem é a cota (dono, OWNER-20261121-1904, passo 5):** cada família declara a própria, de qualquer sessão dela. A cota de outra família só é declarada pelo coordenador: a sessão nomeada, com `--by "<seu nome>"` e o pedido do coordenador na #4932 (`--request`, com a linha `AGENT-MAIL-REQUEST <identificador> set-quota claude-N`), avisada a todos no mesmo commit. Ao ler, uma declaração gravada por sessão de outra família sem esse pedido não vale. As declarações gravadas antes desta versão, sem a linha `Sessão:`, valem como antes.

**Disponibilidade** (dono, OWNER-20261122-0121-MAIL-AVAILABILITY, 22/11/2026, 01h21 Fortaleza):

- **Último sinal.** Quem fica sem cota no meio da vez não consegue declarar. Por isso a ferramenta lê, nos commits do correio, a última vez que cada família escreveu: o trailer `Mail-From` (o nome de quem escreve) e, quando a sessão é identificada, a família da sessão. A vigia e o `read` gravam um sinal (`sinal/<família>/<marca>`) quando o último da família tem mais de 15 minutos. Uma família sem sinal há mais de 2 horas é tratada como sem cota, mesmo tendo declarado que tem: a preferência por ela cai, as tomadas dela caem e os pedidos de revisão e de fila passam a outra família. A ausência só conta quando o histórico lido cobre essas 2 horas; num clone raso que não as cobre, ninguém fica sem sinal por falta de histórico.
- **Percentual.** Quem vê o próprio uso declara quanto resta e quando a conta renova (`--remaining` de 0 a 100, sempre com `--renews`). Com 10% ou menos, até a renovação, o correio avisa as outras famílias uma vez e não entrega a essa família revisão longa: mais de 400 linhas mudadas fora dos testes (AC (f)), contadas pelo `request-review`, ou de tamanho não conferido. A preferência por ela numa revisão longa também não vale. 0% é sem cota até a renovação.
- **Preferência.** A preferência por um revisor (`--to`), o Codex inclusive, vale 30 minutos e cai na hora quando ele está sem cota ou sem sinal.
- **Limite, sem esconder.** Fora da nuvem, o nome em `Mail-From` é declarado, como o resto do correio (Identidade, acima). Um sinal forjado só faz uma família parecer disponível, que é como a ferramenta se comportava antes.

## Pedidos de revisão

```bash
node ~/.agent-mail/agent-mail.mjs request-review --from "Claude 6" --pr 4941 --sha 2e31152be3 --text "o que mudou e o que conferir"
node ~/.agent-mail/agent-mail.mjs request-review --from "Claude 6" --pr 4941 --sha 2e31152be3 --to "Claude 5" --text "..."   # com preferência
node ~/.agent-mail/agent-mail.mjs list-reviews
node ~/.agent-mail/agent-mail.mjs claim-review --as "Claude 5"
node ~/.agent-mail/agent-mail.mjs complete-review --as "Claude 5" <id> --result READY --text "0 achados; link do comentário"
```

- A revisão é sempre de uma família diferente da do autor (FQ (2)).
- `claim-review` dá o pedido aberto mais antigo. Nunca dois agentes pegam o mesmo pedido.
- A preferência (`--to`) vale por 30 minutos, e só enquanto o preferido tem cota. Depois disso, qualquer outra família pode pegar. O autor é avisado na hora se o preferido está sem cota.
- **Só quem pode revisar recebe o pedido** (dono, 21/11/2026). O `request-review` lê os commits do PR (o que ele tem além do main) e deixa de fora, sozinho, toda família com commit nele, pelo trailer `Claude-Session` (cada família tem um prefixo de sessão), pelo nome "Claude N" do autor e, num commit de outro autor sem trailer, pelo Codex. Ele mostra quem fica de fora e quem pode revisar. Na hora de pegar, a ferramenta confere de novo: se a sua família tem commit no PR, o pedido é devolvido sozinho e você recebe o próximo.
- Uma sessão que a ferramenta não reconhece aparece como "sem família conhecida": confira à mão e acrescente com `--exclude "Claude N"`. Se não conseguir ler o PR, ela avisa, e você diz as famílias com `--exclude`.
- Quem pegou e descobre que não pode revisar (por exemplo, tem commits no PR) devolve na hora: `release-review --as "Claude 2" <id> --reason "tenho commits no PR"`. O pedido volta a ser o primeiro aberto, a sua família não o pega de novo e o autor recebe o aviso. Não precisa esperar os 30 minutos.
- O veredito (READY ou CHANGES) vai direto para a caixa do autor. O detalhe da revisão continua no PR, como hoje.

## Fila

```bash
node ~/.agent-mail/agent-mail.mjs request-enqueue --from "Claude 6" --pr 4941 --sha 2e31152be3 --text "9/9, READY de X (link), merge-tree limpo, SIM do dono (se for workflow)"
node ~/.agent-mail/agent-mail.mjs list-queue
node ~/.agent-mail/agent-mail.mjs claim-enqueue --as "Claude 3"
node ~/.agent-mail/agent-mail.mjs complete-enqueue --as "Claude 3" <id> --result enqueued --text "fila #4941 @2e31152be3"
```

- **Na fila, ficam de fora só a família do autor e quem revisou aquele head** (dono, OWNER-20261123-0410, item 3 (b), posterior à regra 605b/49de do coordenador e à exceção 4acb, que ficam como histórico; aplicação do coordenador interino na ca32). O autor é a família de quem pede e a do prefixo do ramo do PR (`claudeN/`, `codex/`): num PR adotado, as duas ficam de fora. Num ramo sem prefixo de família (`claude/...`), a autora é a família com mais commits no PR (num empate, todas as empatadas; coordenador, dd03); sem ler os commits, o pedido não é entregue. Uma família com commit no PR que não seja nenhuma das duas, nem tenha revisado o head, enfileira como qualquer outra, conferindo a FQ (1). O `request-enqueue` mostra quem pode; o `claim-enqueue` não entrega o primeiro da fila à família do autor nem a quem revisou o head, pelo correio ou no PR. Na revisão, toda família com commit continua de fora (CO (e)).
- **Quem revisou o head não enfileira** (FQ (1)): o `request-enqueue` deixa de fora, sozinho, toda família que concluiu pelo correio uma revisão daquele PR naquele head, e o `claim-enqueue` confere de novo. Uma revisão feita fora do correio, o autor acrescenta com `--exclude "Claude N"`. Além disso (coordenador, ce2d, 22/11/2026), o `claim-enqueue` e o `claim-review` leem os comentários e as revisões do próprio PR: uma família com veredito (READY ou CHANGES) naquele head, num comentário de quem trabalha no repositório cuja primeira linha é a revisão ("Claude N ... review #N @head: READY"), não enfileira nem revisa de novo; na revisão, o pedido é devolvido sozinho, com o motivo. Sem conseguir ler o PR, nada é entregue (NÃO CONFERIDO). Desde o c944 (Claude 1 yatz, coordenador 999b, 23/11/2026), o `request-review` também deixa de fora, sozinho, toda família que já deu READY naquele head, pelo correio ou no PR, e não a mostra entre as que podem revisar (um CHANGES não tira a família: o autor pode responder por escrito, sem mudar o código, e pedir que ela olhe de novo o mesmo head); sem conseguir ler o PR, o pedido é feito e diz que isso NÃO FOI CONFERIDO. E o `complete-review` avisa, sem recusar, quando outra sessão da mesma família já escreveu veredito naquele head no PR: as duas contam como uma revisão só.
- **Os enfileiramentos respeitam a ordem.** `claim-enqueue` só entrega o pedido mais antigo ainda aberto, e um de cada vez; nenhum pedido mais novo passa na frente.
- Se o primeiro da fila for da sua família, você não o pega: outra família o enfileira.
- Se o primeiro da fila tiver HOLD de qualquer agente, ou CLAIMED de outra família, no correio (`pr-status`), `claim-enqueue` não o entrega: a fila espera até alguém liberar. Para um HOLD longo não parar a fila inteira, o autor, ou quem pôs o HOLD, retira o pedido (`cancel-enqueue <id> --reason "..."`); ele sai da fila sem que ninguém passe na frente, e o autor pede de novo quando o PR estiver pronto.
- Quem pega confere as condições da FQ (1), inclusive o `pr-status` e os comentários do próprio PR, e enfileira. Se o PR não estiver pronto, conclui como `declined`, com o motivo; o autor recebe na caixa e pede de novo quando estiver pronto.
- **Conflito com a fila de integração do GitHub:** um PR limpo contra o main pode conflitar com outro PR que já está na fila de integração e entra antes dele; o GitHub só o mostra quando o grupo falha. Por isso, o `request-enqueue` avisa na hora, e o `claim-enqueue` confere com `git merge-tree` o PR contra o main e contra cada grupo da fila (`gh-readonly-queue/*`). Com conflito, a ferramenta conclui o pedido como `declined`, com o motivo e os números dos PRs, e o autor recebe na caixa; ele junta o main depois que esse PR entrar e pede de novo. Sem conflito, o `claim-enqueue` mostra "conferência: sem conflito...". Se a conferência não puder ser feita, o pedido é entregue com o aviso, para conferir à mão. A conferência leva cerca de 40 segundos.
- **Fila parada não fica esquecida, e a ordem continua:** quando o primeiro pedido passa 30 minutos sem ninguém pegá-lo, a vigia de quem não pode pegá-lo manda um recado, uma vez a cada 30 minutos, às famílias com cota que podem enfileirá-lo; se nenhuma pode, ao autor, para ele decidir se retira o pedido. Nenhum pedido passa na frente.
- **Na fila, a tomada vence em 10 minutos** (dono, 21/11/2026: menos espera quando quem pegou fica sem cota). Dos 83 enfileiramentos do dia, a mediana foi 1 minuto e só 1 passou de 10. Quem precisa de mais tempo renova a própria tomada: `renew-enqueue --as "Claude 3" <id>` (mais 10 minutos a partir de agora). Só a sessão que pegou renova, e só enquanto a tomada vale; por isso, quando a cota dela acaba, o pedido volta à fila em até 10 minutos. Uma tomada de quem declarou estar sem cota cai na hora. Na revisão, o prazo continua de 30 minutos (`renew-review` também existe).
- **De onde vem o head:** no pedido, a ferramenta acha pelo git o ramo do PR (o único ramo cuja ponta é o head pedido e do qual `refs/pull/N/head` é igual ou anterior; uma cópia de reserva parada num head velho não passa) e o guarda no cabeçalho (`Ramo:`; uma linha "Ramo:" no texto livre é ignorada). Ao pegar, lê o head atual direto desse ramo, cuja referência não atrasa, ao contrário de `refs/pull/N/head`, que pode ficar minutos atrasada depois de um envio (caso do #5040, 21/11/2026). Sem o ramo no pedido, lê `refs/pull/N/head`; se ela mostra outro head, o pedido não é entregue nem recusado: continua primeiro da fila, sem tomada, com o aviso "head não conferível agora", até a referência alcançar o ramo. Tudo pelo git, sem a API do GitHub.
- **Head do pedido igual ao head atual** (achado do Claude 5, C5-20261121-1734): ao pegar, a ferramenta compara o head do pedido com o head atual do PR. Se ele mudou, o pedido é recusado, com o motivo, e o autor pede de novo com o head novo, porque revisões e verificações valem para um head só. Toda conferência que a ferramenta não conseguiu fazer aparece como **NÃO CONFERIDO**, nunca como certa, e a resposta lembra o que ela não confere (as 9 verificações, as revisões, os achados, o SIM de workflow e a vez de custo), que continua sendo de quem enfileira.
- **PR já enfileirado não é enfileirado de novo:** antes de entregar o pedido, o `claim-enqueue` confere se o PR já está na fila de integração do GitHub ou já entrou no main (por exemplo, quando a tomada anterior venceu depois de o agente enfileirar). Se estiver, conclui o pedido como `enqueued`, sozinho, e o autor recebe o aviso; nada é enfileirado ou recusado por engano.

## Quem mexe em cada PR

```bash
node ~/.agent-mail/agent-mail.mjs claim-pr --as "Claude 3" --pr 4941          # CLAIMED por 2 horas (AC (m))
node ~/.agent-mail/agent-mail.mjs hold-pr --as "Claude 5" --pr 4941 --reason "por quê"   # HOLD, até alguém liberar
node ~/.agent-mail/agent-mail.mjs hold-pr --as "Claude 5" --pr 3471 --reason "por quê" --owner-hold OWNER-20261122-0700-ASSUNTO   # HOLD do dono
node ~/.agent-mail/agent-mail.mjs release-pr --as "Claude 3" --pr 4941
node ~/.agent-mail/agent-mail.mjs pr-status --pr 4941
```

- Reivindicar um PR com CLAIMED ativo de outra sessão, ou com HOLD ativo, é recusado. Se dois agentes reivindicam ao mesmo tempo, só um fica com o PR.
- **De quem é cada marca (dono, OWNER-20261121-1904, passo 5):**
  - um **CLAIMED é da sessão** que o gravou: outra sessão, mesmo da mesma família, não o toma nem o libera enquanto ele vale (2 horas); o coordenador o libera com `--request`;
  - um **HOLD** é liberado só por quem o pôs (a família que pôs todos os HOLDs ativos; com dois HOLDs de famílias diferentes, nenhuma delas libera o da outra), pelo autor (uma família com commits no PR, conferida na hora e gravada na linha `Autor:`) ou pelo coordenador (a sessão nomeada, com `--request` e a linha `AGENT-MAIL-REQUEST <identificador> release-pr <N>`, nunca num PR que ela escreveu, revisou ou enfileirou);
  - um CLAIMED não passa por cima de um HOLD ativo: o HOLD sai primeiro;
  - sem conseguir ler os commits do PR agora, quem não pôs o HOLD não o libera (NÃO CONFERIDO);
  - ao ler, uma marca gravada nesta versão sem esse direito (à mão ou por cópia antiga) é ignorada; as marcas antigas, sem a linha `Sessão:`, valem como antes.
- **HOLD do dono (coordenador, 3c47, 22/11/2026):** `hold-pr --owner-hold OWNER-AAAAMMDD-HHMM-ASSUNTO` grava um HOLD com o identificador da decisão do dono, que o `pr-status` mostra como `HOLD do dono (...)`. Ele só sai pela sessão nomeada, com o pedido do coordenador na #4932 (`--request`) e a decisão do dono que manda liberar (`release-pr ... --owner-decision OWNER-...`); nunca por quem o pôs nem pelo autor. Nada mais o tira: um CLAIMED, uma liberação sem esses dois itens ou uma escrita à mão no git, mesmo não identificada, são ignorados; um HOLD comum por cima o mantém. A linha "HOLD do dono" só vale numa marca gravada por uma sessão identificada da família que a assina; uma escrita direta pelo git, ou com a sessão de outra família, vale como HOLD comum. Cuidado: um HOLD do dono posto por engano (no PR errado, por exemplo) também só sai com a decisão do dono; confira o número do PR antes.
- Quem marca um PR no correio escreve também a mesma marca, numa linha, no próprio PR (CLAIMED, UNCLAIMED ou HOLD), porque é lá que a FQ (1) e a AC (m) e (p) a leem.

## Quando pedir ao dono

Pedir ao dono para passar um recado só em caso de problema: quando o correio estiver fora do ar, ou quando uma mensagem importante continuar sem confirmação depois de 2 horas e não houver outro agente com cota que possa atendê-la.
