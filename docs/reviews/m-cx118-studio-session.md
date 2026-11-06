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
