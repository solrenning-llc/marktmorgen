# Revisão independente M — #2858

Data: 06/11/2026. Revisor: Codex M, atribuição C4-2930 em substituição a R2. Autor do PR: Claude 4; M não é autor do produto. Claim informado pelo coordenador e recebido antes da primeira leitura de diff/fonte/teste: `39fcc06549e713553c39e2a47c09309e56293a6e`.

**Parecer no head `697f1b40a68c9e0f894cbf06d67b627bef3a857a`: pode entrar quanto a esta revisão independente.** Há uma observação **LEVE (LOW), condicional e preexistente**, de apresentação sob índice impossível, detalhada abaixo. O coordenador deve comunicá-la ao autor. Incorporação continua subordinada à base empilhada e aos checks exigidos; este parecer não afirma CI global verde.

## Identidades, recuperação e limites

PR: [#2858](https://github.com/solrenning-llc/marktmorgen/pull/2858). Base real: `1224a5d3a4da2953c67a3324bd9acdf8e044be8f`, ramo do #2847. RED real: `fbcf5ef72c9f779ca0bd5b9d5aed66b05c391adc`. Head reparado: `697f1b40a68c9e0f894cbf06d67b627bef3a857a`.

Este relatório foi reconstituído do contexto depois da reinicialização global de `/dev/shm`. O diretório antigo realmente deixou de existir; o ENOENT foi inicialmente diagnosticado como indisponibilidade de execução sem antes conferir o cwd. A execução funcionou no cwd novo, e a presença física dos arquivos restaurados foi conferida. Não se presume que o antigo cache, índice, árvore ou dependências continuem disponíveis.

Os dois arquivos de prova foram restaurados **byte a byte**, comprovado pelos hashes anteriores e atuais:

| Arquivo | SHA-1 Git de blob | SHA-256 |
| --- | --- | --- |
| `tests/m-2858-assignments.proof.ts` | `b5ae3729a6fc196bcca8ba4f226e3e31a7ca08b2` | `e485ecae1294b0281e96da50c75a65d765dbbe5a6648f6a6c8b5b43d04a3a0a4` |
| `proofs/m/review-2858-assignments.mjs` | `dfd50a69c51f792de460b35534dbf95b08275350` | `0cd11ec4dc102ff32086cff35431b803abdab977183d135411a220ed3a86af85` |

O próprio relatório tem conteúdo atualizado de recuperação; seu hash final é transmitido pelo coordenador fora do arquivo, evitando autorreferência. Não houve refetch ou repetição de teste, tsc, esbuild ou navegador durante a recuperação. Os resultados comportamentais abaixo pertencem às execuções anteriores, cujos scripts foram restaurados com os mesmos bytes. Os caminhos antigos de cache/dependências permanecem no launcher para preservar seu hash; **eles precisam ser restabelecidos antes de uma futura execução**.

## Diferença inteira: cinco arquivos

Foram lidos patch integral, lista de arquivos, conteúdo dos cinco caminhos no head, metadados do commit/PR e dois compares. Base → RED contém somente o novo teste; RED → head contém os quatro arquivos de produto, mantendo o teste idêntico. A prova RED não foi presumida a partir da descrição do autor.

| Todos os arquivos do PR | Blob no head | Efeito conferido |
| --- | --- | --- |
| `app/studio/course/[product]/page.tsx` | `ceaf5482f8b72c5e5eb9f3a09dcb81da768b45da` | Separa submissão legível de marcador unread e passa contagem ao componente |
| `components/course-work-studio.tsx` | `423d852b269f7df49a22b108d320fcca0012d381` | Mostra aviso com role=status e não mostra vazio quando unread conhecido é positivo |
| `lib/assignment.ts` | `61a61ba02e2d9db9512d1148d8f4a6ab45343b7e` | Valida envelope/tipo de prompt e lote; JSON persistido ilegível de submissão vira marcador explícito; extrai parser de objeto |
| `lib/person-copy.ts` | `e0e4621e42ca2f313cf7ccb8620c4bbb18bb7a04` | A cópia mantém entrada curso/aula/aviso quando o registro não pode ser lido, sem copiar seu caminho interno |
| `tests/assignment-export-exact.test.ts` | `dbcd74c38728134f5cf41818396be08a96656132` | Vinte casos do autor, lidos e executados no anterior e no head |

Blobs dos quatro arquivos de produto da base: página `e0c02ce7ddaf6d065a1bc3b1259c4202d020c079`; componente `5fc6cd0e4283d9dc3c02ac033ae8dab4b6c220c6`; assignment `ea99b8994d25c5ab8d3eada276ac524c92205b0b`; person-copy `36fc97db9d18534b34b5094210477471c9ccc2c3`. O launcher embute esses quatro, os quatro do head e o teste, e verifica seus nove hashes Git antes dos testes. Após recuperar os arquivos, esses nove hashes foram novamente conferidos por Python, sem executar fonte de produto.

O cache anterior não continha os commits base/head. Compare tipado `90eca6cb… → 697f1b40…` informou merge-base `2bfa8ade8f59555b8d57aa03e554a99092a1285b` e seis caminhos: os cinco do PR e o teste herdado `tests/assignment-reads-exact.test.ts`. No cache anterior, merge-base → `90eca6cb…` alterava somente três arquivos de socials fora do recorte. Assim os transitivos inalterados vieram de `git show 2bfa8ade…:path`, com overlays exatos por arquivo. Foi um loader virtual restrito, não checkout ou prova de árvore completa.

## Chamadores e efeitos transitivos

O inventário de `readTaskFor` e `submissionsOf` identificou todos os chamadores produtivos diretos abaixo. Esses caminhos inalterados não estavam entre as seis diferenças do compare, além dos overlays já identificados. A tabela distingue leitura estática e execução, sem apresentar mocks como integração completa.

| Caminho | Conferência e limite |
| --- | --- |
| `lib/assignment.ts:55–77` → `redis-reply.repliesFor`, `assignment-rules.parseTaskSetup` | Funções reais executadas; nil explícito é ausência; envelope/tipo/JSON/switch ilegível lança UnknownReplyError. Switch false preservado no controle |
| `lib/assignment.ts:173–221` → `storedSubmission`, `ITEM_ID_PATTERN`, `WHO`, `repliesFor` | Funções reais executadas; valida lote antes de mapear; JSON ilegível vira unread, nil vira ausência |
| `app/studio/course/[product]/page.tsx:101–115,211–220` → `waitingWork`, `submissionsOf`, `CourseWorkStudio` | Página assíncrona real e componente real executados em SSR; auth, catálogo, aluno, vídeo, IA e componentes não relacionados são mocks explícitos sem rede |
| `components/course-work-studio.tsx:149–205` → React, Link, AiOn | React/renderizador reais; Link/AiOn simplificados. Não houve navegador, hidratação, foco ou leitor real |
| `lib/person-copy.ts:253–271` → assignment copier | Corpo real da seção executado com legível, nil, JSON ilegível, envelope desconhecido e outro learner. Outros copiers não foram executados |
| `lib/person-copy.ts:452–465` → `copyPerson` | Laço lido: falha do copier propaga, não há catch que entregue o restante. Não foi executada a cópia integral de todas as famílias |
| `lib/person-erasure.ts:213–234`, `lib/learn.ts:80` | Escopo e hash learner lidos; lessonIds vêm do curso. Exclusão integral e persistência real não foram testadas |
| `app/[handle]/course/[product]/[lesson]/page.tsx:121–129` → `readTaskFor` | Leitura estática; Promise.all propaga falha. `app/error.tsx` tem estado de página indisponível; boundary Next não executado |
| `lib/assignment-access.ts:22–36` → `readTaskFor` | Leitura estática; tarefa ilegível não vira acesso confirmado. Chamadores transitivos: `app/api/store/course/task/route.ts:58,157` e `app/api/store/course/task/upload/route.ts:50` |
| `app/api/store/course/task/route.ts:48–66` e rota de upload | Writer obtém who de studentOnTask; não usa identidade livre do corpo. Upload trata UnknownReplyError como 503. Rotas, upload e fornecedor não executados |
| `app/api/store/course/route.ts:75` → `readTaskFor` | GET propaga a exceção; não cria ok:true/task:null a partir dela. Framework HTTP não simulado |
| `app/api/store/ai/route.ts:290` → `readTaskFor`, `submissionOf` | Não chega a writeFeedback quando a leitura lança. IA/cobrança reais não executadas |
| `lib/mcp-tools.ts:575–583` → `readTaskFor`; `app/api/mcp/route.ts:153,188–190` | Catch devolve isError:true e indisponibilidade. POST MCP/autenticação/custeio não executados |
| `lib/assignment.ts:524–576` → `fileOfRecord`, `forgetTasksPerson` → `lib/person-erasure.ts:141–142` | Leitura do parser extraído: preserva objeto versus array/JSON inválido e file null/ilegível. Rotina de apagamento não executada |

Além dos overlays, o loader carregou exatamente cinco arquivos congelados: `tests/redis-stub.ts`, `lib/redis-memory.ts`, `lib/redis-reply.ts`, `lib/course.ts` e `lib/assignment-rules.ts`, somando 140.960 bytes locais. A execução independente resolveu 108 arestas de import. As demais dependências do fluxo não usado são mocks explícitos que lançam se um método inesperado for chamado, não fontes auditadas ou integrações aprovadas. TypeScript e React já instalados foram reutilizados naquele momento; nada foi instalado.

## Observação LOW condicional: índice impossível e texto contraditório

Resultado SSR provado: fila sintética com um membro inválido retorna total:1, mas a página mostra `the first 0 of 1` e `Nothing is waiting`, sem aviso unread.

Formato esperado: lessonId `^[a-z0-9]{12}$`; who hexadecimal minúsculo de 16 a 64 caracteres. O writer normal usa `emailKey(email)`, hash de 32 caracteres (`lib/learn.ts:80–81`), obtido a partir do aluno autenticado por `studentOnTask` (`lib/assignment-access.ts:29–36`). Não foi demonstrado caminho público normal que grave who `not-a-student`.

Seam alterada: **estado interno do MemoryRedis diretamente**, não resposta HTTP ou writer público. A prova insere:

```text
ZADD nl:course:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:tasks:waiting 1700000000 lessonexpor1|not-a-student
SET nl:course:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:task:lessonexpor1:sub:not-a-student "{unread synthetic record"
```

`waitingWork` aceita campos não vazios (`lib/assignment.ts:395–414`, especialmente 410–412); `submissionsOf:215–221` filtra who inválido e devolve nil para a linha filtrada. Página 108–115 chega a rows0/unread0; componente 191–194 mostra vazio. A asserção que detecta isso permanece falhando. Não se afrouxou parser para buscar identificador inválido.

Não existe no cenário submissão válida de aluno real ou gravada pelo writer público. Não se corrompeu uma resposta de índice de trabalho válido para provar sua ocultação. Não foram demonstrados registro válido omitido, perda, exclusão, vazamento, cross-learner access, bloqueio permanente ou falha permanente de privacidade. O efeito sustentado é apresentação inconsistente quando o índice interno já contém um membro impossível.

A inferência inicial de MÉDIO foi retirada depois da delimitação causal com o coordenador. O grau final é LOW condicional e não bloqueia este PR. Essa retificação permanece registrada; não se usa o teste sintético para inventar gravidade. Toda observação deve ser declarada ao autor pela publicação central.

Antes/head: o corpo de waitingWork é idêntico na base (começa em 378) e no head (395). O modo explícito `residual-base` executou só a mesma asserção sobre os quatro blobs de produto anteriores e reproduziu 0 PASS/1 FAIL; o head reproduziu o mesmo efeito. Não é regressão demonstrada do #2858.

Correção futura pode propagar indisponibilidade/unread para membro inválido. Aceitar who impossível ou filtrar como ausência não comprova leitura. A regra 30 justifica o registro do padrão; elevar o grau exige reprodução causal adicional.

## Execuções anteriores reproduzidas e controles

Comandos executados antes do reset, na pasta antiga:

```bash
node proofs/m/review-2858-assignments.mjs author-red
node proofs/m/review-2858-assignments.mjs author-head
node proofs/m/review-2858-assignments.mjs independent-head
node proofs/m/review-2858-assignments.mjs residual-base
```

| Execução | Resultado real | Alcance |
| --- | --- | --- |
| Teste do autor sobre produto anterior e teste RED idêntico | 20 casos: **4 PASS/16 FAIL**, saída 1 | Reproduziu RED e quatro controles normais |
| Teste do autor no head | 20 casos: **20 PASS/0 FAIL**, saída 0 | Reparou os vetores originais no harness restrito |
| Própria, primeira execução | 26 casos: **24 PASS/2 FAIL**, saída 1 | Resíduo de apresentação e erro do fixture |
| Própria, fixture corrigido | 26 casos: **25 PASS/1 FAIL**, saída 1 | Só permaneceu LOW condicional; não há global green |
| Mesma asserção residual na base | 1 caso: **0 PASS/1 FAIL**, saída 1 | Efeito preexistente |

Erro inicial do fixture: `async pipeline => proxy` faz a resolução de Promise consultar a propriedade then antes de entregar o valor ao produto. A instrumentação contou esse acesso como trap de dados e falhou com `1 !== 0`. A causa e o ajuste foram comunicados antes da edição. O fixture final conta then separadamente, exige exatamente um acesso de assimilação e mantém **zero traps de dados**, além das recusas UnknownReplyError. Nenhuma asserção de apresentação ou proteção foi removida. Não é achado de segurança do produto.

Os 26 casos e suas asserções foram preservados na restauração. Controles aprovados: trabalho/nil; switches false; oito formas persistidas ilegíveis; outro learner não copiado e caminho interno omitido; seis envelopes desconhecidos; accessor/Proxy; erro de transporte; cinco prompts ilegíveis; página real com unread conhecido, legível e ausência. Redis é o double de memória existente, não Redis nativo.

Não foram executados por M suíte global, os 53 testes citados pelo autor, client-bundles, navegador, CI, produção, Redis nativo ou fornecedor. Esses 53 casos permanecem relato do autor. Nenhum teste foi repetido para ocultar falha; o único erro de fixture foi explicado e registrado.

## Scanner, sintaxe, lint, tipos e diff

| Verificação | Resultado e limite |
| --- | --- |
| Scanner antes do reset | Função findings() canônica de `scripts/check_public_data.py` em 2bfa, aplicada aos três artefatos: **3 arquivos/0 achados/saída0**. Apenas o enumerador git ls-files foi substituído por allowlist explícita; nenhuma regex foi removida |
| Scanner restaurado | Fonte reconstituída com SHA-256 **idêntico** ao anterior: `6ae1393f74b1849b4b84cf97f7b38bff1875d5032dba4342d94c73f93b665c7e`. Aplicação Python à allowlist dos três restaurados: **3 arquivos/0 achados/saída0**, sem executar produto |
| Sintaxe do runner | `node --check proofs/m/review-2858-assignments.mjs` deu **saída0** antes do reset, inclusive após residual-base. O runner restaurado tem os mesmos bytes; não se alega nova execução Node após o reset |
| Whitespace/diff | Antes do reset, `git diff --no-index --check /dev/null <arquivo>` nos três não produziu diagnóstico; Python conferiu trailing whitespace e quebra final única. Retorno1 de no-index significa diferença de arquivo novo, não falha de lint |
| ESLint real | `NODE_OPTIONS=--max-old-space-size=96 /dev/shm/codex-m-resume.c5DCg7/node_modules/.bin/eslint --config /dev/shm/codex-m-resume.c5DCg7/eslint.config.mjs proofs/m/review-2858-assignments.mjs --max-warnings=0` **abortou com saída134 por V8 heap de96MiB** ao carregar regras. Não produziu resultado de lint. Não se reduziu grafo/regras para fingir verde nem aumentou heap sob pressão |
| Config do lint | Blob do config realmente usado e do congelado coincidiam: `05e726d1b4201bc8c7716d2b058279676582e8c0`, incluindo Next/TypeScript. Cache e dependências antigos foram depois perdidos no reset |
| Tipos estritos | Apenas leitura: strict:true, moduleResolution:bundler, jsxImportSource:@/lib/content-jsx, alias @/*. **Nenhum typecheck semântico estrito foi executado**. transpileModule não faz typecheck; globais/mocks/casts any da prova não validam a API. Falta tsc com grafo real e capacidade autorizada |

A tentativa de lint foi limitada para proteger a execução concorrente. Não houve tsc/esbuild/browser durante a instrução de reserva de capacidade. A conclusão do lint real continua pendente, agora também da restauração do ambiente de regras/dependências. Sintaxe, scanner e hashes não substituem esse resultado. O parecer de produto e a validação incompleta do lint são estados distintos, explicitados para publicação.

## Árvore candidata e manifesto restaurado

O coordenador autorizou depois construir árvore candidata nativa em repositório/índice próprios, sem ref e sem afirmar equivalência. Foi concluído antes do reset: init bare próprio; alternates de leitura; hash-object -w de seis blobs com SHA conferido; read-tree de2bfa; update-index com seis elementos; write-tree. O diff-tree da base para candidata tinha exatamente seis caminhos.

| Identidade | Valor |
| --- | --- |
| Fonte local base | `2bfa8ade8f59555b8d57aa03e554a99092a1285b` |
| Tree exata dessa base, conferida localmente antes do reset | `3298708dd28b4342286fa86241e367f7fbc8fdbf` |
| Tree candidata calculada anteriormente | `93384bd395d0f4c48b43b15b8320f84c5c1d1e3c` |
| Tree real dos commits remotos head/base | **Não confirmada por M**: wrapper não expôs tree e commits completos não foram importados |
| Estado físico após recuperação | Manifesto e seis conteúdos recuperados; antigos objetos/índice locais **perdidos**. A árvore não foi reconstruída nem equivalência inventada |

Elementos GitData candidatos, preservando os demais caminhos da árvore base:

```json
[
  {"path":"app/studio/course/[product]/page.tsx","mode":"100644","type":"blob","sha":"ceaf5482f8b72c5e5eb9f3a09dcb81da768b45da"},
  {"path":"components/course-work-studio.tsx","mode":"100644","type":"blob","sha":"423d852b269f7df49a22b108d320fcca0012d381"},
  {"path":"lib/assignment.ts","mode":"100644","type":"blob","sha":"61a61ba02e2d9db9512d1148d8f4a6ab45343b7e"},
  {"path":"lib/person-copy.ts","mode":"100644","type":"blob","sha":"e0e4621e42ca2f313cf7ccb8620c4bbb18bb7a04"},
  {"path":"tests/assignment-export-exact.test.ts","mode":"100644","type":"blob","sha":"dbcd74c38728134f5cf41818396be08a96656132"},
  {"path":"tests/assignment-reads-exact.test.ts","mode":"100644","type":"blob","sha":"a9d1402c1700d04a8dbc99c4b3eb1b160f4f488d"}
]
```

O sexto arquivo foi obtido no head exato por fetch_file tipado e seu blob conferido; serve só para fechar o snapshot, não foi executado. O manifesto scratch `.m2858-candidate-manifest.json` contém os seis elementos e o inventário dos14 objetos anteriormente criados: seis blobs e oito trees — `0b26340007efa7dd2d7fd202055f526178ed2e52`, `108c329cf38d5743a9039d5e216b564d903849d2`, `11f1496ca05a053f2d3ffe46f1a8a9e0e08a0c4c`, `208fa1bbfbd5585d3038079e030e1dac01ade4e8`, `6fe78f9e9b8f8867ed6f6c1976b0656c701b07f6`, `73ec0580360f741f61ef52d33304ebd503ffa91c`, `93384bd395d0f4c48b43b15b8320f84c5c1d1e3c`, `c6141082ba1c39eb7b5b55f29530995c2d6798f0`. O manifesto marca explicitamente que os objetos locais antigos foram perdidos; seus IDs não demonstram presença física atual.

Verificação central ainda necessária: filho **sem ref**, com pai real697f e tree candidata; compare697f→filho deve apresentar files:[] e ahead_by:1. Isso confere inclusive modos100644 candidatos. Sem esse resultado, não apresentar candidata como tree equivalente ao head. O coordenador poderá então publicar os três artefatos com pai real; M não publicou ref ou commit externo.

## Reserva, exposição e acessibilidade

São três artefatos publicáveis, nos caminhos reservados deste relatório, prova e launcher. Checkpoints/manifesto/scanner em arquivos scratch separados não são produto nem novos itens da fila. Não houve edição de produto ou índice de outro agente, instalação, conta, termo aceito, chave, fornecedor, envio, contato externo, GitHub mutation, CI, canal, push ou PR. H1 não foi alterado nesta frente.

Foram22 invocações tipadas no trabalho original, incluindo quatro erros de vínculo de argumentos e a leitura do sexto caminho, dentro do teto40leituras/4MiB. Não se repetiu o endpoint genérico que havia retornado403, nem token/IP alternativo ou bypass. Recuperação não fez refetch. Exposição admitida não é custo monetário medido: custos continuam desconhecidos, não zero; preço/limite/comissão/flag/gate/modelo financeiro intactos.

O PR acrescenta texto de status sem controle novo. SSR de página/componente foi exercitado antes do reset; não houve foco/hidratação/navegador/leitor/pessoa real ou certificaçãoAAA. Os artefatos da revisão acrescentam0passos/decisões à interface do produto. O coordenador centraliza publicação e comunicação da observação LOW ao autor.
+
## Atualização final do artefato original — janela autorizada

Este adendo atualiza o estado das verificações do artefato ORIGINAL e preserva o histórico anterior de recuperação/OOM. Os dois scripts originais e seus blobs executados continuam intactos. Resultados de v2 não integram este relatório original; a versão separada permanece pendente para publicação e execução após o commit ancestral coordenado.

Após GO do coordenador, o preflight registrou 6.095.106.048 bytes livres, acima do mínimo de 1,5 GiB. Foi preparada cópia própria de 4106 arquivos rastreados sobre a base completa recuperada `2bfa8ade8f59555b8d57aa03e554a99092a1285b`, tree `3298708dd28b4342286fa86241e367f7fbc8fdbf`, com os seis conteúdos conferidos por SHA antes do overlay. A árvore local resultante foi novamente `93384bd395d0f4c48b43b15b8320f84c5c1d1e3c`. Git nativo `/usr/bin/git`, índice próprio e dependências K2 somente leitura; nenhum produto, índice ou ref do autor foi alterado.

Os manifests reais das dependências foram lidos: React 19.2.8, Next 16.4.2, esbuild 0.28.2 e TypeScript 5.9.3. Cada processo abaixo teve heap de 1536 MiB, teto de120s, log de128KiB e monitor de memória livre mínima de1,5GiB; não houve timeout, OOM, queda desse mínimo ou retry automático.

| Verificação ORIGINAL atual | Resultado real |
| --- | --- |
| Next typegen oficial | **Saída0/PASS**, 0,664s; mínimo observado de memória livre 5.765.517.312 bytes; log59 bytes. Gerou next-env.d.ts e tipos reais de rotas/root-params. Sem declaração vazia ou mock |
| Configuração após typegen | tsconfig.json **não foi alterado**; bytes originais preservados, SHA-256 `30c8aa5c24848e63fcc303cab095c0d1a33a8edccac1b5f9bd97024527d4adf2` |
| Strict dos cinco roots do PR | **Saída0/PASS**, 22,427s, zero diagnósticos; mínimo livre 4.774.187.008 bytes; log0 bytes. Config scratch estende a real, strict/noEmit, incremental:false e cinco roots mais ambient real; imports transitivos completos, sem aliases de stubs ou tipos fictícios |
| ESLint dos dois códigos ORIGINAIS | **Saída1/FAIL**, 3,726s; mínimo livre 5.376.700.416 bytes; log613 bytes. São **dois erros e um aviso**, descritos abaixo. Este é o resultado atual; o OOM com96MiB fica somente como histórico |
| Markdown | Config canônica não tem parser Markdown. Scanner/diff e whitespace são as verificações próprias do relatório; não se apresentou lint inexistente do MD |

Os cinco roots efetivamente checados foram `app/studio/course/[product]/page.tsx`, `components/course-work-studio.tsx`, `lib/assignment.ts`, `lib/person-copy.ts` e `tests/assignment-export-exact.test.ts`. Não se confundem com tipos da fixture independente ou com a suíte global. O comando real foi TypeScript `typescript/lib/tsc.js --project tsconfig.m2858.strict.json --pretty false`, depois do `next/dist/bin/next typegen`, ambos dos módulos K2 conferidos.

Ambient gerado oficialmente: next-env.d.ts288bytes, SHA-256 `1862ac4bbbc5192d4bf562161df66ea547ed3e67173100656ab606ae9797db2b`; .next/types/routes.d.ts31223bytes, `cf773322f70ef14a8abe6f87642ebf9ab840de1ce0d1eaa4c0b69ca66576ca4d`; .next/types/root-params.d.ts101bytes, `f3387dd7800eec3c34273f7a8efad13e864598c7e8f788d321e407390989bb59`.

Diagnósticos canônicos do lint ORIGINAL, sem afrouxar regra:
- Runner, linha45: aviso `@typescript-eslint/no-unused-vars`, parâmetro `_args` não usado.
- Runner, linha79: erro `@next/next/no-assign-module-variable`, variável local `module`.
- Prova TS, linha5: erro `@typescript-eslint/no-explicit-any`, cast explícito `any`.

O lint foi executado com o config real e `--max-warnings=0`, sobre cópias com blobs exatamente `dfd50a69c51f792de460b35534dbf95b08275350` e `b5ae3729a6fc196bcca8ba4f226e3e31a7ca08b2`. Os diagnósticos são dos artefatos de M, não achados do produto. Sua correção está preparada em v2 separado, sem alterar ou reexecutar estes originais. Não há aprovação formal ou confirmação de nove checks neste adendo.

Proveniência remota recebida do coordenador: create_tree remoto produziu a candidata `93384bd395d0f4c48b43b15b8320f84c5c1d1e3c`, e foi criado o filho sem ref `e358a3bfd1602fb2493e7183b96c1c1737ee1659`, com pai real `697f1b40a68c9e0f894cbf06d67b627bef3a857a`. O compare continuou bloqueado por quota403. **Equivalência remota de árvore/modos permanece pendente**, sem inferir files:[] ou ahead_by:1 apenas pela criação do filho. M não repetiu chamada de API ou efetuou escrita GitHub.

Os logs limitados e seus metadados ficam em `validation-logs/typegen.{log,result.json}`, `validation-logs/strict-five-roots.{log,result.json}` e `validation-logs/eslint-evidence.{log,result.json}`. Os resultados comportamentais originais continuam os já registrados: autor4/16→20/0, própria25/1 e base focada0/1, com LOW condicional preexistente e sem perda de trabalho válido demonstrada.


## Adendo de artefatos v2 — publicação central

# Revisão M/#2858 — artefatos v2 e conclusão para COMMENT

Head de produto revisado: `697f1b40a68c9e0f894cbf06d67b627bef3a857a`. Base do PR: `1224a5d3a4da2953c67a3324bd9acdf8e044be8f`. M é revisor independente; Claude 4 é autor do produto.

**Conclusão mantida: pode entrar quanto à revisão independente, com uma observação LOW condicional e preexistente declarada ao autor.** Não há médio/grave sustentado pelas reproduções realizadas. Não é aprovação formal, confirmação de nove checks, suíte global ou equivalência remota de árvore.

## Ancestral original preservado

O coordenador informou publicação dos artefatos ORIGINAIS antes de autorizar runtimev2: ramo `codex/m-review-2858-assignments`, commit `06faff51d4381ebbc68168c6330a8253698df278`, tree `cc60c64bc2140cd64cc063e6e1ed2a8a2048c3ec`. Os blobs originais são:

| Original | Git SHA-1 |
| --- | --- |
| Relatório `docs/reviews/m-2858-assignments.md` | `80fda9d0f173ad3a28be6c5732096a79dcfe46ed` |
| Prova TS | `b5ae3729a6fc196bcca8ba4f226e3e31a7ca08b2` |
| Runner | `dfd50a69c51f792de460b35534dbf95b08275350` |

Esses arquivos locais não foram alterados para criar v2. O relatório original contém diff inteiro de cinco arquivos, blobs exatos, chamadores/transitivos, RED, erro do fixture then e retificação de grau. A v2 corrige somente ferramentas de prova de M, sem mudança no produto.

## O que mudou em v2

- Runner: argumentos `--git-cwd` e `--deps`, Git nativo `/usr/bin/git`, nome local `evaluatedModule` e remoção do rest não usado. Snapshots e nove validações de blob permanecem iguais.
- Prova: World usa `typeof import` dos módulos reais assignment/person-copy e classe MemoryRedis real. O acesso global cru atravessa uma fronteira unknown explícita, sem any declarado.
- O fixture do copier continua contendo somente os campos realmente usados pela seção de assignment; sua conversão a ErasureScope é explícita, não uma prova do escopo completo ou da autorização real.
- A injeção proposital de retorno de pipeline inválido continua explícita. Não há stub de declaração para alterar a API do produto.
- Os 26 casos, as asserções anteriores, os valores nil/corruptos e a string de falha residual foram preservados. Foram acrescentadas guardas de objeto/string na interpretação da cópia; nenhuma asserção anterior foi removida.

O patch completo das duas ferramentas é `artifact-v2.patch`. `portability.patch` mantém a proposta inicial de parametrização separada. V2 não transforma o LOW em sucesso.

## Verificações estáticas e histórico dos erros

Todos os processos autorizados foram serializados, com preflight de pelo menos1,5GiB livres, heap1536MiB, timeout120s, log128KiB e monitor do mínimo livre. Não houve OOM, timeout, cruzamento do mínimo ou retry de processo por recurso.

| Etapa | Resultado real |
| --- | --- |
| Nexttypegen oficial na cópia própria | PASS/saída0, 0,664s; ambient real de Next16.4.2, sem .d.ts vazio; tsconfig original não alterado |
| Strict dos cinco roots do PR | PASS/saída0, 22,427s, zero diagnósticos. Não foi repetido depois |
| Lint dos artefatos originais | FAIL/saída1, 3,726s: dois erros e um aviso. Runner: module e rest não usado; prova: any explícito. O OOM96MiB era tentativa anterior e permanece histórico |
| Lint v2 inicial | PASS/saída0, 3,602s, zero diagnósticos |
| Strict v2 inicial | FAIL/saída2, 17,346s: TS7006 no parâmetro record. A interseção com typeof globalThis conservava o any inferido pelo runnerJS incluído |
| Correção da fronteira global | Alterado para `globalThis as unknown as { __M2858?: ProofWorld }`, conservando os imports de tipos reais. Não se silenciou regra nem se adicionou declaração fictícia |
| Lint v2 final | **PASS/saída0, 3,678s**, zero diagnósticos, mínimo livre5.888.663.552 bytes |
| Strict v2 final | **PASS/saída0, 30,283s**, zero diagnósticos, mínimo livre5.583.552.512 bytes |

O config scratch de v2 inclui a prova TS e o runnerJS, estende o config real, preserva strict e os imports transitivos completos e usa ambient gerado oficialmente. **checkJs permanece false, herdado do projeto:** a checagem semântica estrita da v2 aplica-se à prova TypeScript, não certifica a semântica do runnerJavaScript. O runner foi coberto por lint e pela execução dos quatro modos. A checagem dos cinco roots de produto é separada e real.

Não houve eslint-disable, redução de regras, grafo truncado, tipo/export vazio ou substituição dos tipos do produto por mocks. A interface tipada da fixture não é certificação da API ou dos serviços reais.

## Runtime v2, somente após publicação ancestral

Os quatro modos foram autorizados pelo coordenador depois de publicar os originais. Foram executados uma vez por modo, em sequência, com a mesma política de recursos. Os códigos de saída1 abaixo são **falhas preservadas e esperadas**, não globalgreen.

| Modo v2 | Casos/PASS/FAIL | Saída | Tempo | Mínimo livre | Bytes de log |
| --- | --- | --- | --- | --- | --- |
| author-head | 20/20/0 | 0 | 1,651s | 6.281.224.192 | 2386 |
| author-red | 20/4/16 | 1 | 1,562s | 6.274.650.112 | 27036 |
| independent-head | 26/25/1 | 1 | 1,760s | 6.301.446.144 | 6867 |
| residual-base | 1/0/1 | 1 | 1,438s | 6.300.782.592 | 4693 |

Em todos os modos: nove blobs embutidos conferidos; cinco fontes locais inalteradas somaram140.960bytes; rede bloqueada no harness; Redis de memória existente; mocks não usados lançam se chamados inesperadamente. O runner mantém restauração do pipeline com finally na prova. O modo residual-base seleciona explicitamente só a mesma asserção residual, não mascara o restante como teste aprovado.

Comando-base, com caminhos reais fornecidos e conferidos:

```bash
node v2/proofs/m/review-2858-assignments.mjs MODE \
  --git-cwd /workspace/scratch/d1ece80b1417/m-source-recovery \
  --deps /workspace/scratch/k2-recovery-20261106-2157/dependencies/installed-node_modules
```

O controlador limitador também definiu NODE_PATH para esse diretório e NEXT_TELEMETRY_DISABLED=1. As dependências reais lidas foram React19.2.8, Next16.4.2, esbuild0.28.2 e TypeScript5.9.3. Não houve instalação.

## LOW, alcance causal e o que não foi demonstrado

Inserir diretamente no estado interno do MemoryRedis `lessonexpor1|not-a-student` faz waitingWork informar uma linha/total1, enquanto submissionsOf filtra o who impossível. A página real mostra ao mesmo tempo `the first 0 of 1` e `Nothing is waiting`. A mesma asserção falha na base e no head.

É condição de índice interno impossível; o writer público normal deriva who de hash do aluno autenticado. Não há nesta prova submissão válida gravada pelo writer público, nem evidência de trabalho válido perdido/omitido, vazamento, acesso entre alunos ou falha permanente de privacidade. O grau sustentado é LOW de apresentação, preexistente; a proposta inicial de MÉDIO foi retirada e permanece no histórico. Toda observação deve chegar ao autor por COMMENT central.

Os controles continuam verificando legível/nil/ilegível, envelope desconhecido, tipos de prompt/switch, outro learner excluído da cópia, caminho interno omitido e SSR da página/componente. Nenhum ensaio é Redis nativo, upload real, comprador real ou fornecedor.

## Identidade de fonte e limites

A cópia própria tem base completa `2bfa8ade8f59555b8d57aa03e554a99092a1285b`, tree `3298708dd28b4342286fa86241e367f7fbc8fdbf`, mais os seis conteúdos SHA-exatos; sua tree local resulta na candidata `93384bd395d0f4c48b43b15b8320f84c5c1d1e3c`. O sexto é teste herdado necessário à identidade, sem virar root extra do strict de produto.

O coordenador informou create_tree remoto93384 e filho sem ref `e358a3bfd1602fb2493e7183b96c1c1737ee1659`, pai697f. O compare remoto continuava403/pendente: equivalência de conteúdo e modos não é inferida. M não escreveu API, PR, comentário, ref ou CI.

Não foram executados suíte global, os53 testes relatados pelo autor, client-bundles, build completo, browser, leitor real, produção, Redis nativo, pagamento, IA ou fornecedor. Não há nove checks completos alegados. A revisão não muda preço, limite, comissão, flag, gate, conteúdo ou dados de cliente. Custos reais permanecem desconhecidos, não zero.

Logs e metadados completos limitados estão em validation-logs com os nomes typegen, strict-five-roots, eslint-evidence, eslint-artifacts-v2, strict-artifacts-v2, eslint-artifacts-v2-boundary, strict-artifacts-v2-boundary e os quatro modos v2. A publicação e o COMMENT continuam centralizados no coordenador.


### Verificação remota posterior pelo coordenador

Em 06/11/2026 às22:30UTC, compare697f1b40a68c9e0f894cbf06d67b627bef3a857a→e358a3bfd1602fb2493e7183b96c1c1737ee1659 retornou ahead_by:1, behind_by:0 e files:[], merge-base697f. Isso confirma a árvore93384bd395d0f4c48b43b15b8320f84c5c1d1e3c e seus modos contra a fonte real. O estado pendente narrado acima permanece histórico. Nenhuma referência do autor foi movida.

Na publicação, o adendo permanece neste mesmo caminho reservado e os dois códigos v2 usam os mesmos caminhos da prova original; os bytes originais são recuperáveis no ancestral06faff51. Para reproduzir a partir da publicação use node proofs/m/review-2858-assignments.mjs MODE --git-cwd OBJECT_REPOSITORY --deps EXACT_NODE_MODULES; o prefixo v2 do comando histórico descreve apenas o workspace de validação.
