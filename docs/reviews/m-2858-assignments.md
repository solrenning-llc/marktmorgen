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
