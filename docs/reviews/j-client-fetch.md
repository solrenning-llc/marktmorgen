# Leitura cliente desconhecida tratada como vazio — prova causal

Nominal C4-2930-CX-179; reserva anterior ao código `e95ecee21349e8842184d91b8d1595e96b2bbda0`. Fonte congelada `5c07315505e1d53ee6401021601cd688fa98ecda`, árvore `f4a0fab311a3bb3675b03e990aa4ff5d646cab27`. Somente os cinco caminhos próprios desta prova foram criados; componentes, rotas, stores e aliases compartilhados permaneceram byte a byte na fonte.

Execução: `TMPDIR=/dev/shm node scripts/j-client-fetch.mjs`. Resultado final: **26 verificações, 16 passam e 10 falham; processo 1**, registrado integralmente em `docs/reviews/j-client-fetch-output.txt`. São duas causas, não dez achados independentes. Este é RED de contratos observáveis no runtime controlado; não houve correção de produto, PR ou conclusão global.

## Resultados

| Caso | Evidência causal na fonte congelada | Limite / encaminhamento |
| --- | --- | --- |
| CourseEditor / LessonEditor: falha de leitura permite apagar conteúdo existente | `components/course-editor.tsx:863` converte HTTP 503 com `ok:false`, rejeição de fetch, JSON inválido e JSON parcial `{ok:true}` em `text = savedText = ""`. Em cada vetor, o botão **Save text** permanece habilitado (`:1067`), sem alerta. O callback real do formulário (`:1033`) envia `text:""`; o POST real autenticado em `app/api/store/course/route.ts:376` chama `saveBody`; `lib/course.ts:617` efetivamente remove o body do MemoryRedis. `readBody` antes do clique mantém o original; depois do clique devolve vazio. | Candidato a **Medium ou superior**, por perda de conteúdo após clique do usuário; exige execução R2 independente desta mesma prova antes de qualquer fix. O ensaio não afirma perda automática só por abrir, nem incidente em dados reais. |
| BundleEditor: resposta incompleta ou HTTP de falha com corpo positivo afirma loja vazia | Em `components/bundle-editor.tsx:94`, `{ok:true}` sem campos e HTTP 503 com `{ok:true, products:[], matches:0, more:false}` passam pela verificação de `data.ok`; campos ausentes viram zero/lista vazia. A árvore real mostra **Your store has no other products yet.** (`:368`) e nenhum alerta, apesar de produtos reais preparados no MemoryRedis. | Falha de validação defensiva, impacto visual delimitado; não foi demonstrada perda de dados. Ambos os payloads são injetados no limite HTTP. A rota real saudável `app/api/store/bundle/route.ts:27` devolve campos completos: não alegamos que ela naturalmente produz esses payloads nem que todo HTTP 503 seja ocultado. |

Controles que passam: texto existente chega ao campo e Save preserva o conteúdo; body legitimamente vazio é aceito; GET saudável de bundle mostra os produtos criados pelos writers reais; busca confirmada sem correspondências mostra o texto adequado. Bundle já mostra alerta para HTTP 503 `ok:false`, rejeição de fetch e JSON inválido. O ticket existente protege a resposta nova contra uma resposta antiga atrasada. Os mesmos handlers e rotas reais são usados nos cenários saudáveis e falhos.

## Método e rede

O runner verifica o hash Git de **454 inputs rastreados** do grafo efetivo, inclusive `tests/test-config.mjs` e `tsconfig.json`, contra a fonte congelada. Emprega exatamente os aliases canônicos de `course-template-studio.test.ts`: MemoryRedis e demais fixtures existentes; não extrai/reimplementa callbacks nem substitui módulos de produto por mocks novos. Os registros iniciais são produzidos por `claimHandle`, writers de produto/link, abertura de sessão e POSTs reais de curso. A sessão/cookie e plano são fixtures sintéticas; nada demonstra conta ou pagamento reais.

Antes da avaliação do grafo, bloqueia o dispatcher Undici realmente resolvido pelo SDK Blob com `MockAgent.disableNetConnect`, proíbe `net.Socket.connect` e instala um fetch inicial que rejeita. O runner para se SDK e guard não resolverem a mesma instância Undici. Os controles negativos devem falhar antes de transporte, ou todo o ensaio para. Ao final: **1 tentativa deliberada no dispatcher, 1 no socket, 0 fetches inesperados**; apenas 21 chamadas fetch internas sintéticas permitidas (16 GET e 5 POST). Os GETs saudáveis e os POSTs de aula executam as rotas autenticadas reais; erros são respostas/rejeições sintéticas. Preparação e leituras de verificação também acessam diretamente os helpers/rotas reais em memória. Nenhum fornecedor, email, upload, contato ou transporte externo é executado.

O `ClientWorld` é um host controlado de hooks/efeitos em Node: elementos React reais, funções dos componentes reais, callbacks reais, contexto real do AppRouter com router sintético, render limitado a 20 passagens e timers de debounce controlados. Não é ReactDOM nem navegador; não verifica hidratação, foco, CSS, comportamento nativo de formulário, leitor de tela ou AAA. O clique é invocação do callback real exposto pela árvore, com `preventDefault` sintético. O fluxo observado sustenta a cadeia de estado e escrita indicada, sem alegar equivalência total de agendamento com o navegador.

## Validação e histórico do ensaio

- Prova final: 26 verificações / 10 falhas causais esperadas / saída 1. Asserções de proteção não foram enfraquecidas para obter GREEN.
- TypeScript estrito com imports reais de ambos os novos TSX: passa, sem emissão ou aliases de teste no typecheck.
- ESLint nos dois TSX e runner: passa.
- Relacionados, com transporte também bloqueado e aliases canônicos: `course-template-studio.test.ts` **55/55**, `pick-bundle.test.ts` **13/13**; total **68/68**.
- Scanner de dados públicos: **4132 arquivos rastreados + os cinco novos, zero achados**; whitespace dos cinco novos: zero achados. Não houve execução de navegador nem alegação de CI verde; custo de CI desconhecido. Bundle de produção não foi alterado; o grafo completo dos componentes é compilado pela própria prova.

A primeira tentativa parou em erro de preparação (`storeFolder` recebeu um store em vez do email); isso foi corrigido para o helper real e não é RED de produto. O primeiro typecheck exigiu o campo `bfcacheId` no router sintético; somente o world foi ajustado e a prova foi repetida. O recibo incluído é o ensaio final completo, posterior a essas correções de harness.

## Ownership e próximo passo

Escopo somente leitura de `components/course-editor.tsx`, `components/bundle-editor.tsx`, `app/api/store/course/route.ts`, `app/api/store/bundle/route.ts` e `lib/course.ts`. Root recebeu esses caminhos exatos para coordenação com C5; ownership continua provisório porque o inventário OPEN disponível era histórico e a API apresentou 403 durante a sessão. A ausência da branch própria foi confirmada por `git ls-remote` e depois por GET API 404 antes da publicação. Isso não concede exclusividade para modificar produto. K2/forms, C6/page-editor/storefront e demais fontes ocupadas ficam fora deste trabalho. Qualquer fix futuro requer inventário atualizado, reserva própria e, para o caso M+, R2 executando o mesmo recibo. Não há decisão de preço, limites, flags, gate, termos ou dono de regra neste recorte.
