# CX-118 — sessão, convite de app e caminho de configuração

Base executada: `1721109f1d2d3930cde6c54f6fe71412648043e3`. Workspace próprio: `/dev/shm/codex-m-cx118-session-2108`. Reserva anterior à escrita confirmada pelo root no canal `31e7533da73ef3eba930a7a690b541db564e08fc`. Publicação centralizada pelo root; esta frente não alterou GitHub, canal, CI, refs nem fontes de produto.

## Resultado verificável

**25 asserções executadas: 24 passaram e 1 ficou RED.** Na sessão aberta pelo callback real de link, a página real monta `AppCodeInvite`, embora o gate real negue adicionar fator. O POST real de `two-step/start` responde `403` com `{ok:false,error:"second_step"}` antes de envio, e o contador de e-mails continua zero. O controle com credencial sintética armazenada e sessão real marcada por passkey permite adicionar fator. A recusa de segurança funciona.

**O controle saudável refuta a alegação geral de que `set_up` é um caminho sem saída no main executado.** Um membro sem fator, barrado pela exigência da equipe, recebe os dois gerenciadores reais na página; a renderização dos componentes reais contém `Add a passkey` e `Turn on two-step login`. A rota real de opções de passkey responde `200`, `ok:true` e challenge textual, sem envio. Isso comprova a disponibilidade do começo do cadastro; não certifica conclusão de WebAuthn em navegador ou toda a jornada TOTP.

O controle com todas as passkeys aguardando remoção conserva a recusa, mantém a credencial e a programação, e renderiza explicação dos dias de espera e do login necessário. Não foi removida a espera para fazer o controle passar.

Grau proposto ao root para a divergência do convite: **LEVE, de recomendação/contexto da sessão**, condicionado aos limites abaixo. O convite leva a uma tentativa que a sessão atual não pode completar, mas o servidor recusa corretamente e o gerenciador tem mensagem de retorno. Não há prova de bypass, perda, bloqueio indevido da conta ou fundamento para classificá-lo como MÉDIO de segurança. A alegação de deadend saudável não deve ser mantida com esta evidência.

## Comando e saída final

Reprodução nesta cópia mínima sem `.git`: `CX118_OBJECT_ROOT=/dev/shm/codex-m-resume.c5DCg7 node scripts/m-cx118-studio-session-run.mjs`. Num clone normal do ramo da prova com os objetos de 172, basta `node scripts/m-cx118-studio-session-run.mjs`. O runner depende de objetos Git do frozen disponíveis no primário, configuráveis por `CX118_OBJECT_ROOT`, e das dependências já instaladas via symlink; não instala pacotes. Retorno esperado nesta base: exit **1**, causado pela única asserção de coerência do convite. Não é uma falha de compilação ou de infraestrutura.

| Cenário | Gate `mayAddSecondStep` | `liveSecondStep` | Convites retornados pela página | Comandos do simulador | Rotas no cenário | E-mails sintéticos acumulados |
| --- | --- | --- | --- | --- | --- | --- |
| link | false | null | 1 | 418 | 2 | 0 |
| passkey | true | passkey | 1 | 386 | 0 | 0 |
| team-no-factor | true | null | 0 | 95 | 1 | 0 |
| team-all-pending | false | null | 0 | 113 | 0 | 1 |

Asserção RED: `an invitation to immediate setup requires the session to be able to add`; esperado `true`, obtido `false`. Ela compara o componente efetivamente selecionado por `StudioPage` com a autorização obtida do gate real, sem reimplementar a regra de inventário ou ler código por regex. Os controles do próprio cenário continuam passando, inclusive `403 / second_step` e ausência de envio.

Controllers/rotas executados na rodada final:

- `StudioPage`: quatro chamadas, com `studioView`, equipe e gates reais, em contextos de cookies fornecidos pelo adaptador Next.
- Callback real `/api/auth/callback`: uma chamada com token sintético sem e-mail; abre a sessão link usada na prova principal.
- `/api/auth/two-step`: uma chamada `action:start`, recusada em `mayAddSecondStep` antes de `startSetup`.
- `/api/auth/passkey`: uma chamada `action:options` no controle saudável; retorna opções sem navegador/fornecedor.
- `openSession`: cria as sessões reais dos controles, sem marca para os membros e com `("passkey", "cx118-key")` no controle de passkey. A credencial correspondente foi previamente guardada por `makePasskey().keep()`.
- `scheduleRemoval`: escritor real executado no controle pending; exatamente um envio interceptado pelo stand-in. `pendingRemoval`, `secondStepWay`, `listPasskeys`, `liveSecondStep` e `mayAddSecondStep` são os módulos de negócio do frozen.

## Fronteiras e caps

O runner materializa sob `source/` somente os blobs necessários ao bundle: **711 arquivos / 10.233.645 bytes**, abaixo do teto de 16 MiB. Não usa o checkout vivo B92/9cd como fonte 172. Para cada arquivo carregado, compara bytes preexistentes com o blob exato do frozen; divergência aborta. Os oito módulos centrais também têm seus SHA-256 impressos antes do bundle. As cópias em `source/` são entradas reproduzíveis, não alterações de produto nem entregáveis para o PR.

O runner importa `testAliases` e `testEnvironment` do próprio frozen. Conserva suas fronteiras canônicas, incluindo Redis em memória e as fixtures padrão de transporte Resend/IA. O world próprio substitui somente Next headers/cookies/navigation e `after`. Headers/cookies reaproveitam o adaptador `tests/security/next-headers.ts` congelado; NextRequest/NextResponse vêm da instalação existente. `after` não executa tarefas pós-resposta. Nenhum gate, `studioView`, decisão do convite, pessoa, equipe ou gerenciador foi substituído por modelo paralelo.

O detector percorre elementos React retornados pela página por identidade do componente, sem chamá-los por nome de função ou comparar o texto-fonte. `PasskeyManager` e `TwoStepManager` são renderizados com `react-dom/server` nos controles de configuração. `AppCodeInvite` é identificado na composição real da página; seus efeitos de hidratação não foram executados. Portanto, o resultado não é apresentado como captura visual, clique real ou confirmação de que uma dica foi vista num navegador específico.

Caps efetivos: até 8 cenários / 40 asserções / 120 segundos / 128 KiB de saída do processo; até 2.000 comandos por cenário, contados **antes** do método `MemoryRedis.run` em todas as instâncias, incluindo operações internas do simulador; até **4 chamadas locais no total**, cada corpo até 4 KiB; até **4 e-mails sintéticos no total**. Rodada final: 4 cenários / 25 asserções / 3 rotas locais / 1 e-mail sintético / maior cenário 418 comandos; conclusão em poucos segundos, sem exceder os caps. `fetch` é interceptado, somente aceita a forma do destino sintético de Resend e retorna uma Response local; qualquer outro destino lança erro, sem rede externa.

A contagem de comandos do simulador inclui chamadas internas e não é preço, medida de Redis nativo nem certificação de custeio. A seleção da loja conserva a admissão real dentro do ambiente sintético; a prova não certifica financiamento ou gasto produtivo. Nenhum preço, limite visível, comissão, flag, conta, chave produtiva, termo, pagamento ou dado pessoal real mudou.

## Evolução da instrumentação e limites de validação

A primeira prova obteve o mesmo RED causal e os controles saudáveis, com hash SHA-256 de prova `00cc2c4770f30b63c2008168b68f34095f8ce07cdd27252230bd96021a9a513a`; ela contava o pipeline primário. Ao ampliar a cobertura de contagem, uma tentativa em `MemoryRedis.prototype.pipeline` registrou zero porque `pipeline` é campo da instância. **Essa contagem foi descartada**, sem ser tratada como custo zero ou resultado válido. A instrumentação final usa o método real `run`, sem alterar respostas ou estado. Também foi adotado cap global de rotas/e-mails: os controles de equipe usam `openSession` real sem marca, preservando a classe de autorização, e o callback real fica no cenário principal. A rodada final é a tabela acima.

`node --check scripts/m-cx118-studio-session-run.mjs` passou. O esbuild compilou o recorte e a execução terminou com o RED intencional. O runtime emitiu avisos experimentais de Web Crypto/ML-DSA-44; não foram convertidos em erro de produto. Não foram executados TypeScript global, lint global, suíte integral, CI, navegador, Next servidor publicado, Redis nativo, dispositivo WebAuthn ou fornecedor. Não há GREEN de produto, pois esta entrega é prova e não corrige fonte reservada.

Acessibilidade: o teste verifica presença de componentes e texto renderizado, sem auditoria AAA, leitor de tela, foco ou navegação por teclado. Nenhuma interface foi alterada; passos/decisões permanecem 0 → 0 nesta entrega. O eventual ajuste de recomendação precisa preservar a recusa e ser coordenado com C4/C6, donos das fontes.

## Identificação dos arquivos próprios

SHA-256 dos três arquivos executáveis da prova final:

| Arquivo | SHA-256 | Bytes |
| --- | --- | --- |
| `tests/m-cx118-studio-session.proof.tsx` | `b33f4c5febd7bba96f39c1ad78b718c6c1817505867d585895b8aeca4d1f993b` | 7635 |
| `tests/m-cx118-studio-session-world.tsx` | `16b2dbdb5a5516d9788265a53ec345a3a398c484c997689d26a6227502ce896e` | 619 |
| `scripts/m-cx118-studio-session-run.mjs` | `d50eca686ed61313a4f8ab67af926013027b8f03ff55a19ec19657d45c510f3a` | 3798 |

O hash deste relatório é informado separadamente ao root após a gravação, para evitar autorreferência. Estes são os únicos quatro caminhos próprios entregues; `source/` e `node_modules` não entram na publicação.


## Validação adicional de publicação — 06/11/2026

Esta etapa não repetiu a prova causal e não mudou suas 25 asserções, fixtures de autorização ou fontes de negócio. A única correção de código próprio foi remover `statSync`, importado e não usado no runner. Seus hashes acima foram atualizados; prova e world conservam os hashes anteriores.

| Check | Execução e resultado exato |
| --- | --- |
| Tipos estritos das duas raízes próprias e imports reais | Configuração em `/tmp/cx118-checks-2148/tsconfig.json`; driver em `/tmp/cx118-checks-2148/typecheck.cjs`, sem alteração do tsconfig do repositório. Comando: `timeout 120s node --max-old-space-size=768 /tmp/cx118-checks-2148/typecheck.cjs`. O sistema imprimiu `Killed`; log de diagnósticos ficou vazio, sem resultado TypeScript. **NÃO PASSOU / sem diagnóstico conclusivo.** O shell externo continuou para mostrar o log; seu exit 0 não é exit do compilador. Não foi atribuído sucesso ao wrapper. |
| Escopo dos tipos | Raízes: prova e world próprios. `strict:true`, `noEmit:true`, opções de JSX canônicas e mapeamento `@/*` para os blobs materializados de 172; Redis/IA/Resend canônicos e apenas os mesmos Next adapters usados na execução. Não houve substituição de página, pessoa, equipe ou gates para simplificar a API validada. `skipLibCheck` preserva a opção do projeto; não desliga verificação dos imports de código. |
| Limite de recurso observado após o encerramento | Cgroup: teto 8.589.934.592 bytes; primeiro uso observado 8.334.495.744; leitura posterior 8.588.976.128. Não prova isoladamente a causa do sinal, mas demonstra pressão de memória compartilhada e impede afirmar erro de tipos ou check verde. O root foi avisado antes de qualquer nova tentativa. |
| ESLint dos quatro caminhos próprios | `timeout 120s node --max-old-space-size=768 node_modules/eslint/bin/eslint.js --config /dev/shm/codex-m-resume.c5DCg7/eslint.config.mjs` seguido dos quatro caminhos desta entrega. Config comparada byte a byte com `1721109f:eslint.config.mjs`: idêntica. Rodada final exit 0, zero erros nos três arquivos de código. Um aviso: Markdown ignorado por não haver configuração aplicável; não é lint aprovado do documento. Também foi emitido aviso Next de diretório pages ausente no workspace mínimo. |
| Scanner público | A função original `findings` de `1721109f:scripts/check_public_data.py` foi carregada de cópia scratch e aplicada explicitamente às quatro novidades: **4 arquivos / 0 achados**. O CLI global baseado em `git ls-files` não foi usado para fingir cobertura de arquivos não rastreados. |
| Diff-check | Para cada novidade, `git diff --no-index --check /dev/null ARQUIVO`: saída vazia, sem aviso de whitespace. O status 1 indica a diferença de um arquivo novo contra vazio; não foi tratado como erro de whitespace nem apresentado como exit 0. |
| Sintaxe do runner | `node --check scripts/m-cx118-studio-session-run.mjs`: exit 0 após a remoção do import não usado. |

As entradas de tipo acrescentaram somente fontes necessárias do mesmo frozen: **728 arquivos / 10.454.729 bytes**, abaixo de 16 MiB. Os oito pins centrais permanecem inalterados. Não houve instalação, clone, suíte integral, profiler ou teste de produto. Logs de validação ficam em scratch fora dos quatro entregáveis, limitados ao recorte; não entram no PR.

Estado de publicação: prova causal RED preservada, scanner e whitespace conferidos, ESLint de código sem erros; **validação estrita de tipos ainda inconclusiva por encerramento do processo**. Não declarar todos os checks locais verdes nem solicitar incorporação enquanto faltar esse resultado ou decisão explícita do coordenador sobre o bloqueio.


### Segunda tentativa estrita: resultado capturado

Depois de a memória compartilhada cair temporariamente para 7.418.241.024 de 8.589.934.592 bytes, o root foi informado e foi feita uma única tentativa técnica menor, serial, do mesmo driver/configuração e mesmos imports reais: `timeout 120s node --max-old-space-size=512 /tmp/cx118-checks-2148/typecheck.cjs`. **Exit do compilador capturado: 134**, após cerca de 14 segundos. Mensagem exata: `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`. Log: `/tmp/cx118-checks-2148/types-final.log`, 627 bytes. O processo não produziu diagnósticos TypeScript. Nenhuma asserção, gate ou import foi relaxado para reduzir o escopo.

A leitura posterior do cgroup foi 8.571.748.352 de 8.589.934.592 bytes; não foi iniciada outra tentativa nesse estado. Esta segunda falha confirma insuficiência do heap menor, sem converter o encerramento anterior em diagnóstico de tipos. Tipos estritos continuam **não validados**. Os outros resultados locais permanecem os da tabela; não houve repetição da prova causal. Próximo passo técnico: obter janela estável de memória para o compilador real até o teto autorizado de 768 MiB, ou o coordenador decidir como registrar o bloqueio. Não substituir os imports reais por declarações falsas para alegar aprovação.


### Portabilidade do runner

A resolução do repositório de objetos foi ajustada para `process.env.CX118_OBJECT_ROOT || root`. O clone normal passa a usar seus próprios objetos; nesta cópia mínima, a variável explícita aponta para o primário, conforme o comando de reprodução acima. **Somente essa resolução mudou no runner**: SHA congelado, pins, fontes, as 25 asserções e caps permanecem idênticos. Não houve novo runtime causal, navegador ou TypeScript. A autorização desta etapa restringe a verificação a sintaxe e lint do runner.


Verificação da correção de portabilidade: `node --check scripts/m-cx118-studio-session-run.mjs` terminou com exit 0; ESLint somente do runner, com a mesma configuração já conferida, terminou com exit 0 e nenhum erro de código. O aviso Next de diretório pages ausente no workspace mínimo continua. Não foram executados runtime causal, TSC ou navegador nesta etapa; o bloqueio de tipos registrado permanece. Houve indisponibilidade temporária do executor antes da primeira coleta final de hashes; após a recuperação, os arquivos foram relidos, sem repetir os checks de execução.


## Atualização documental para publicação — mesma frente CX-118

O prefixo de 15.869 bytes acima é preservado integralmente, com Git blob `c84e882d1a119dd123b4a83b15b7750230cf27c7`. Esta atualização reúne as notas locais subsequentes no único caminho documental já reservado. Os três executáveis publicados permanecem byte a byte iguais; nenhum helper novo é incluído na publicação deste pacote.

Estado atual da evidência: permanece a execução histórica de 25 asserções, 24 PASS / 1 RED, com a recusa de segurança preservada e o controle saudável de set_up refutando o alegado caminho sem saída. O typecheck estrito finalmente concluiu, mas FALHOU com 74 diagnósticos concretos de fronteiras do harness; os trechos anteriores sobre OOM permanecem histórico, não o resultado mais recente. A validação 5/0 do hardening cobre somente seu preflight proposto e não aprova o runner inteiro. O patch separado não foi aplicado aos executáveis publicados.

A proposta focal a C6 é reutilizar needsStep já lido para tornar a recomendação coerente, sem novo IO produtivo. Não há proposta de transportar cookie, token, segredo ou identidade de credencial ao cliente; o gate continua no servidor e a rota continua recusando a sessão sem autorização. A espera de remoção, a recusa em caso desconhecido, a proteção de dados e os limites privados existentes não são afrouxados. Reutilizar a leitura não certifica custo integral zero nem abre disponibilidade de produto. Nada neste pacote declara uma implementação entregue por C6 ou uma decisão nova dele.

As notas abaixo são transcritas como registros com seus escopos e momentos. A referência 177372d foi informada pelo root; não houve nova consulta remota para conferir o ramo ou o head atual. Não foram repetidos runtime da prova, TSC, esbuild ou navegador durante esta preparação editorial. A frente 2945 não foi lida nem iniciada por este pacote; depende do recibo de coordenação do root.


### Nota focal preparada para C6

# Nota focal ao Claude 6 — CX-118

Texto preparado localmente para publicação pelo root. Referência de publicação informada pelo root: `177372d`; não foi feita consulta remota nesta recuperação, em razão do bloqueio de quota informado às 22h09 UTC. Os quatro arquivos foram reconstruídos do contexto e conferidos pelos Git SHA-1 já registrados, sem rede e sem executar a prova.

Claude 6, a prova CX-118 executada anteriormente sobre `1721109f1d2d3930cde6c54f6fe71412648043e3` terminou com **25 asserções: 24 passaram e 1 RED**, focalizado na recomendação:

- Sessão por link: `StudioPage` real monta `AppCodeInvite`, mas `mayAddSecondStep` real retorna false. O POST real de `two-step/start` preserva `403 / second_step`, antes de qualquer envio; zero e-mails nesse cenário.
- Sessão por passkey: credencial sintética realmente armazenada, sessão real marcada e gate permitem adicionar; o convite continua pertinente.
- `set_up` saudável: a página monta os gerenciadores reais; os controles de cadastro aparecem na renderização e a rota real de opções de passkey responde `200`, com challenge. **Isso refuta o alegado caminho sem saída nesse controle**, sem certificar conclusão de WebAuthn ou TOTP.
- Todas as passkeys aguardando remoção: a recusa, a credencial e a programação são preservadas; o gerenciador explica a espera. Não afrouxar esse caso.

O grau proposto é **LEVE, de recomendação/contexto da sessão**. O servidor protege corretamente; não há prova de bypass, perda ou bloqueio indevido da conta que fundamente um MÉDIO de segurança.

Recorte mínimo proposto para sua avaliação, sem produto escrito por esta frente: em `app/studio/page.tsx:1265` da base executada, condicionar a recomendação direta também a `!needsStep`. Essa autorização já é lida em `:1153` por `mayAddSecondStep`; a proposta reutiliza o resultado, com **zero IO novo**, sem alterar gate, flag ou política de segurança. Quando `needsStep` for true, preservar as orientações de reautenticação/espera já renderizadas pelos gerenciadores. A ausência ou leitura desconhecida de autorização não deve virar convite de configuração imediata.

Se o recorte nominal exigir manter a dica visível com a orientação “Log in with your passkey, then add an app code”, transportar o mesmo resultado já lido ao texto/link exige coordenação dos arquivos de componente e palavras. Não chamar novamente o gate e não recomendar autenticar pela própria passkey que está pending. A supressão da recomendação direta é a alteração de menor superfície; a decisão de produto e a reserva dos caminhos permanecem com você/root.

A prova publicada registra o comportamento anterior e contém uma asserção de controle que confirma a presença atual do convite no caso link. Preservá-la como RED histórico; a regressão permanente da correção deve distinguir o comportamento pretendido de cada sessão e manter os controles da recusa. Não remover proteção nem afrouxar uma asserção para anunciar GREEN.

Limites: foram executados página, gates e rotas reais com armazenamento e transporte sintéticos. A presença do convite foi observada na árvore React da página; efeitos de hidratação, exibição em navegador e clique real não foram testados. O controle `set_up` prova o início utilizável do cadastro, não sua conclusão completa. Os tipos estritos não foram validados: a execução de 768 MiB foi encerrada pelo sistema; a de 512 MiB terminou com exit 134/OOM. O relatório preserva esses bloqueios, o scanner 4/0 e os resultados de lint/sintaxe já obtidos. Nenhum check foi repetido nesta recuperação.

Arquivos recuperados, byte a byte pelos hashes conhecidos:

| Caminho | Git SHA-1 | Bytes |
| --- | --- | --- |
| `tests/m-cx118-studio-session.proof.tsx` | `bbc59d222a54eb50a0273ffe7eb18b61545cfd49` | 7635 |
| `tests/m-cx118-studio-session-world.tsx` | `c5f783ba20d1e6811395587d697bc76b7b885622` | 619 |
| `scripts/m-cx118-studio-session-run.mjs` | `fc8a1db8be53a7c6748e4be5cb0ddb6cd63e5580` | 3798 |
| `docs/reviews/m-cx118-studio-session.md` | `c84e882d1a119dd123b4a83b15b7750230cf27c7` | 15869 |

O runner recuperado usa `CX118_OBJECT_ROOT || root`; seus pins e asserções permanecem intactos. Não houve implementação de produto, alteração de fonte reservada, API, publicação, canal, ref ou CI nesta recuperação. O root encaminha esta nota após a liberação do canal.


### Auditoria estática do harness e plano de tipos

CX-118 — releitura estática do harness e plano de tipos

Sem novo teste, API, produto, navegador, esbuild ou TSC. Revisão estática pela mesma frente autora; não é parecer de outro revisor. Quatro blobs publicados preservados.

ADMISSÃO E MEDIÇÃO
Prova:30 confere commands + 1 antes de invocar o MemoryRedis.run original e incrementa antes da chamada. Isso admite cada comando do simulador, não um pipeline inteiro antes de sua entrada; um lote pode ter comandos anteriores aplicados quando um posterior é recusado. O hook do protótipo alcança instâncias e internos que voltam a this.run; não cobre automaticamente estado manipulado sem esse método, overrides ou referência original previamente capturada. Imports são avaliados antes da instalação do hook.
418/386/95/113 são resultados históricos não recalculados: incluem setup, página e verificações posteriores, além dos internos encaminhados ao hook. Não são custo isolado da página nem Redis nativo/atomicidade Lua. Contador de comandos reinicia por cenário; rotas/e-mails são cumulativos. O helper limita corpo/rotas antes do controller e o fetch limita mail antes da Response sintética. Não há evidência de cap excedido na rodada histórica.

AUTORIZAÇÃO E FRONTEIRAS
Token sintético é consumido pelo callback real, e o cookie da Response entra no contexto da página. O controle passkey usa credencial armazenada por makePasskey e openSession real com marca/id: prova autorização, não assinatura WebAuthn. Equipe usa sessões reais sem marca. putMember, setRequireTwoStep e scheduleRemoval são imports de negócio; pending é gravado pelo escritor real e relido. Seu aviso é aceito por stand-in, sem entrega real comprovada.
World substitui somente Next headers/cookies/navigation/after, exportando NextRequest/Response da dependência instalada. O harness TOTAL também herda os aliases canônicos Redis/IA/Resend. after descarta trabalho pós-resposta, que não é medido. useRouter retorna {}, pathname é fixo e searchParams vazio: não há validação de navegação cliente; tipos podem diagnosticar essas fronteiras. Não escondê-las com APIs falsas.

RISCOS DE CLAIM
A árvore React prova seleção do convite; não hidrata, não testa sessionStorage ou clique. Setup saudável prova controles e options, não cadastro completo. O 403 observado não indica bypass/perda.
fetch aceita substring “resend”, não allowlist exata: chamada inesperada pode ser classificada como mail sintético. Não chama o fetch original, mas isso não isola todos os transportes possíveis de SDK.
Runner:13/17 chama git ls-tree/show sem proibir lazy fetch. Em clone parcial, objeto ausente pode disparar busca remota; portanto “zero rede” não é garantia geral de toda materialização/reprodução. Recomendar GIT_NO_LAZY_FETCH=1 na execução futura, sem modificar os quatro hashes atuais.
O cap de fonte soma blobs carregados na rodada, não sobras existentes em source/. maxBuffer limita o filho, não toda saída do runner/compilador. Nenhum desses pontos eleva o convite a MED de segurança.

PLANO ESTRITO — NÃO EXECUTADO
1. Aguardar liberação do slot após H1. Com lazy fetch proibido, conferir bytes do frozen 1721109f1d2d3930cde6c54f6fe71412648043e3 para os oito pins: app/studio/page.tsx; lib/studio-route.ts; lib/team.ts; lib/auth.ts; lib/passkeys.ts; lib/two-step.ts; lib/second-step-gate.ts; lib/app-code-invite-words.ts. Conferir também test-config, redis-stub/MemoryRedis, passkey-world e headers, que sustentam o harness. Objeto ausente bloqueia sem rede.
2. Config apenas scratch: strict/noEmit e opções canônicas; raízes próprias prova/world, imports reais transitivos dos oito pins e aliases canônicos/Next já usados. Sem noResolve, noCheck, any amplo, supressões ou validação só contra mocks.
3. Um compilador serial, até 768 MiB, timeout externo 120 s, log até 128 KiB e fontes físicas até 16 MiB. Capturar exit do compilador e diagnósticos por origem: próprios, adapters, frozen e bibliotecas. OOM/Killed permanece inconclusivo; não substituir imports para obter verde.
4. Não repetir prova causal/browser/esbuild/CI/produto. Correção da recomendação continua C6/root, reutilizando needsStep e preservando espera/recusa. A prova RED histórica não deve ser afrouxada para virar a regressão final.


### Resultado concluído do typecheck estrito real — 74 diagnósticos

CX-118 — resultado estrito real da prova publicada

Fonte congelada: 1721109f1d2d3930cde6c54f6fe71412648043e3. Prova/world copiados sem alteração de bytes; oito pins centrais conferidos antes e depois da execução. Object store autônomo local, sem alternates/promisor observado; Git nativo com globals/sistema ignorados e todos os transportes negados. Nenhuma API foi consultada.

Comando: timeout 120s /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node --max-old-space-size=768 /workspace/scratch/d1ece80b1417/m-cx118-strict/validation/typecheck.cjs

RESULTADO: exit 2 / FAIL, 74 diagnósticos, 58.012 s de criação/verificação semântica. Dois roots próprios e imports reais transitivos: 1482 sourceFiles. Livre no início: 6536855552 bytes (acima de 1 GiB); fonte física 10456483 bytes (abaixo de 16 MiB); log 8592 bytes (abaixo de 128 KiB). Não houve OOM nesta janela.

Origem exibida: 74 em arquivos congelados; 0 diretos na prova, 0 diretos no world, 0 de biblioteca ou configuração. Isso NÃO aprova o conjunto: os diagnósticos nos consumidores resultam de APIs estreitadas pelos adapters/aliases realmente usados no harness.

Causas, separadas por fronteira:
- 68 TS2339 em componentes: refresh/push não existem no tipo {}. Causa rastreável ao world:8, useRouter() retornando {}; por exemplo answers-editor.tsx:46 e course-toggle.tsx:73. Não são 68 defeitos novos de produto.
- 5 em lib/ai.ts:226–237: TS2554 (assinaturas sem parâmetros versus chamadas com argumentos) e TS2367 (tipo literal creator versus trial/setup/ended), decorrentes do alias canônico ai-spend-regression-stub.
- 1 TS2459 em lib/email.ts:20: a fixture canônica resend-fallback-transport declara ResendTransportRuntime sem reexportá-lo.
- Outros: 0.

Não foram escritos stubs novos, declarações ambient falsas, casts amplos ou supressões para produzir verde. O mapping manteve Redis/IA/Resend canônicos e os mesmos Next adapters da execução histórica. Nenhum erro exigiu LayoutProps/PageProps global; não foi gerado ambient Next adicional. As declarações oficiais das dependências instaladas foram usadas normalmente. A configuração strict/noEmit e o driver ficam nesta pasta, fora dos quatro blobs publicados.

Não foram executados esbuild, runtime das 25 asserções, navegador, typecheck das cinco raízes 2858, produto ou CI. O RED 25/1 e os quatro hashes publicados permanecem intactos. A validação deixou de estar apenas bloqueada por memória: agora há incompatibilidades concretas de tipagem do harness. Qualquer ajuste deve ser um recorte autorizado dos adapters/fixtures, preservando a API real e a evidência; não alterar o frozen nem trocar por API falsa. Esta nota não declara PASS semântico da prova.

Arquivos de prova da validação: strict-real.log, strict-real.result.json, typecheck.cjs e ../tsconfig.cx118.strict.json. SHA-256 do log: 5686ab775b4db571d9aff0c0bb0d5127d27b4eb214e49c421490077c6b5a5ad3.


### Hardening do preflight — patch separado, não aplicado

CX-118 — proposta de hardening do runner, não aplicada aos quatro blobs publicados

Arquivos separados: portability-no-network.patch e portability-no-network-validation.py. A prova, o world, o runner publicado e o relatório de 177372d mantêm os hashes anteriores. Nenhuma das 25 asserções, o SHA frozen ou os oito pins foi alterado.

O patch fixa /usr/bin/git e limpa variáveis GIT_* herdadas antes de criar um ambiente explícito. Ignora configuração global/sistema, desliga prompts e transportes e usa saída capturada, sem exibir nomes/valores de configuração. Antes de ls-tree/show, resolve apenas metadados locais do repositório e verifica nomes de chaves nos arquivos config/config.worktree, com includes desativados. Recusa chaves partialClone/promisor/partialCloneFilter, includes locais, arquivos alternates/http-alternates e marcadores .promisor. Erro de inspeção falha fechado com mensagem genérica. Não depende de GIT_NO_LAZY_FETCH.

Restrição deliberada: repositórios com alternates ou includes são recusados, inclusive quando o destino poderia ser íntegro. Essa escolha evita certificar stores/configurações não inspecionados. Um clone normal completo continua sendo o caso suportado; não foi criado clone nem alterado um repositório de produto.

Validação executada SOMENTE do preflight adicionado, extraído do patch e aplicado estruturalmente à base conhecida; nenhum modelo paralelo da lógica. Não houve compilação nem execução de produto, esbuild, TSC, navegador, API ou rede. /usr/bin/git foi observado como arquivo ELF nativo. Um controle limpo e quatro negativos locais foram executados sob timeout total de 10 s e teto de arquivos de fixture de 20 MB:
- clean: aceito, exit 0, mesmo com injeção sintética de GIT_CONFIG_GLOBAL/SYSTEM, GIT_CONFIG_COUNT e GIT_DIR no ambiente de entrada;
- partial/promisor: recusado, exit 1, pelo motivo de configuração esperado;
- marcador .promisor: recusado, exit 1, pelo motivo de store esperado;
- alternates: recusado, exit 1, pelo motivo esperado;
- include local: recusado, exit 1, pelo motivo esperado.
Resultado observado: 5 casos, 0 falhas, 0,829 s; 2.976 bytes de arquivos temporários, removidos ao terminar. O teto de 20 MB mede os arquivos da fixture, não RSS do processo Node. A validação não executou ls-tree/show nem tentou transporte de rede; não atesta o restante do runner ou comportamento de protocolo mediante chamada remota. Os caminhos nativos e o preflight proposto foram exercitados; o RED histórico 25/1 e o bloqueio de tipos permanecem os mesmos.

Publicação e eventual aplicação continuam centralizadas pelo root no ramo da prova existente. Não há PR de produto ou alteração de fonte C4/C6 nesta frente.


### Fechamento editorial e fronteiras preservadas

Esta alteração é exclusivamente documental no caminho já reservado. O histórico 25/1 não foi convertido em GREEN; setup saudável não foi reclassificado como deadend; nenhum diagnóstico dos aliases foi corrigido ou suprimido. A proposta de C6 mantém zero leitura adicional de autorização, conservando os controles privados existentes. Scanner e diff/whitespace do pacote são conferidos localmente e informados ao root com o novo hash, sem mutação remota, declaração de nove checks, equivalência de árvore ou aprovação de produto.
