# D7 — prova de integração de importações e fatos do Path

Reserva anterior ao código: canal `4be45d78ccb6a6629cd79b7957d3f263bcd358b6`. Fonte congelada `2bfa8ade8f59555b8d57aa03e554a99092a1285b`, árvore `3298708dd28b4342286fa86241e367f7fbc8fdbf`. Prova somente, com importadores, publicação e leitores reais; nenhuma fonte de produto é alterada.

Executar da raiz: `TMPDIR=/dev/shm node scripts/j-d7-imported-path.mjs`.

## Resultado: comportamento existente verificado

O ensaio encerrou com **28 checks aprovados, exit 0**, sem alteração produtiva. Não há RED de produto: esta é uma prova positiva do que já existe na fonte congelada, não uma nova unidade funcional. O estado antigo `not started`/`asks:[]` do lote não demonstra ausência de implementação.

Pedido conferido: item 10 [D7], `docs/codex-queue.md:2231–2235`: produtos e páginas importados podem cumprir fatos correspondentes; importar não cria lead confirmado nem venda. Fila blob `12c016ae20b80ed5dbe9344bb44a38f30a42983f`; lote blob `174fb192e648b00cefed2e9e545e7c2227eb2b17`.

| Critério | Percurso real e observação |
| --- | --- |
| Produto importado oculto | `startImport → addRows → finishUpload → runImport` recebe um CSV com link HTTPS e grava um produto real. `readProduct` confirma link e `hidden:true`; `readPathFacts`/`dayMissions` continuam com zero produtos listados e Day 2 aberto. Não há busca HTTP do link. |
| Publicação do produto importado | `setProductHidden(..., false)` confirma a gravação real. O leitor real passa a um produto listado, `productWithFile:true` e Day 2 concluído, sem adaptação por origem. |
| Contato importado | O importador grava um contato com acordo relatado no CSV, `source:import` e estado mailable. Isso não é confirmação por link na loja; o Path mantém zero leads e missão de lead aberta. |
| Compra importada | O fluxo real grava um grant associado ao produto e ao próprio ID do import. `email:false`, nenhum envio. O grant existe, mas o leitor do Path mantém zero vendas, receita zero na lista financeira sintética completa e Day 7 aberto. Nenhum campo `fs:*` é criado por esses imports. |
| Página importada | O conversor e `saveFunnelImport` gravam uma página nativa oculta; `writePage` a publica de verdade no Redis sintético. Como a própria loja continua sem introdução, Day 1 permanece aberto. Só `updateDetails` gravando a introdução da loja fecha esse fato. Não foi inventada missão para páginas adicionais. |
| Controle financeiro positivo | Uma sessão Stripe explicitamente sintética, paga, live-mode e pertencente à loja faz o leitor real contar exatamente uma venda e 1.900 centavos. Ao retirar essa sessão, o resultado volta a zero e o grant importado continua presente. Isso impede uma conclusão vazia obtida por um leitor permanentemente zerado. Não certifica venda ou modo real de conta alguma. |

Asserções de montagem também exigem que os jobs realmente terminem, sem erros, que o produto/contato/grant/página existam e que os escritores confirmem seus saves. Uma montagem interrompida não é tratada como regressão de produto.

## Fontes e fronteiras

Na fonte congelada, `lib/imports.ts:755–800` grava produtos com `addDraftProducts`; `lib/store.ts:4061–4109` cria o produto oculto. A publicação usa `lib/store.ts:4029–4036`. `lib/path-facts.ts:186–205` lê o catálogo corrente, nome e introdução da loja; Day 2 usa o fato em `lib/path-rules.ts:291–293`. Contatos passam por `lib/imports.ts:618–641`; compras, por `:873–905` e pelo escritor de grants em `lib/imported-purchases.ts:150–190`.

O runner usa `testAliases("clickfunnels-import.test.ts")` e `testEnvironment` canônicos. A prova roda em um subprocesso com MemoryRedis canônico próprio. Não substitui importadores, publicação, contatos, grants, escritores de página ou leitores/regras do Path. Antes de executar, o runner confere **417 arquivos rastreados do grafo e de sua configuração** contra os blobs de `2bfa8ade`; divergência interrompe o ensaio.

O SDK Blob instalado e a aplicação resolvem o mesmo `undici/index.js`. Antes de avaliar qualquer módulo da aplicação, o banner do runner instala `MockAgent.disableNetConnect()` sem exceção de rede, bloqueia `Socket.prototype.connect` antes de DNS/transporte e bloqueia fetch de inicialização. A prova instala depois somente respostas para três GETs Stripe sintéticos, com cabeçalho da conta sintética esperada. Qualquer outra tentativa é bloqueada e contada, mesmo que o consumidor engula o erro.

Controles de segurança aprovados: um pedido Undici deliberadamente não correspondente é recusado pelo MockAgent; uma conexão Socket deliberada é recusada pelo bloqueio. No restante do ensaio, dispatcher e socket não recebem nenhuma tentativa adicional. Houve **19 GETs Stripe interceptados**: nove `/v1/checkout/sessions`, nove `/v1/payment_intents` e um `/v1/refunds`. Não houve tentativa de email, busca do link, Blob, outro provedor ou HTTP de inicialização. O runner descarta configurações herdadas AWS/SES/Resend/Stripe/PayPal/Blob/R2/S3; somente identificadores/chave de teste sintéticos são usados dentro desse processo. Não há fallback para fornecedor real.

## Verificação e limites

- Prova final: 28/28 checks; exit 0. SHA-256 do log: `07098c52ce2bb6a7f77a211fe6fcdcf65bdf78c91bbb85ff8a664c9120cd774f`.
- Dirigidos em processos isolados, com aliases/ambiente canônicos e bloqueio de dispatcher/socket: `clickfunnels-import.test.ts` 56/56, `path-facts.test.ts` 39/39 e `path-rules.test.ts` 60/60, total 155 checks. O erro de refunds impresso pelo teste de Path é o cenário sintético esperado de paginação incompleta; seu exit é 0. SHA-256 do log: `0816e1cff42ba903da00c13b16436bd676bb625264a614aaf0835705fa77240d`.
- TypeScript semântico estrito do grafo real importado pela prova, sem emissão/incremental: exit 0. Não é typegen nem TSC global. A primeira preparação encontrou somente uma referência inalcançável a `reason` depois de `assert.equal(ok,true)`; a condição redundante do harness foi retirada e a prova foi repetida, mantendo todas as asserções.
- ESLint dos dois caminhos executáveis próprios: exit 0.
- Scanner oficial: 4.104 arquivos rastreados, zero achados; aplicação explícita de `findings` aos três caminhos novos, zero achados.
- Diff-check dos três arquivos próprios novos contra `/dev/null`; fonte de produto, aliases, fixtures e testes existentes permanecem idênticos ao main congelado. O índice e os nove caminhos não rastreados pré-existentes da cópia compartilhada são preservados.

SHA-256 dos executáveis finais: prova `4be808a74bf3f924777006bc5e9255a0617295266622648258bc78682b766914`; runner `791b1e98832829da240ef60dc35089f026f44efd7d91942f81532203b3117d5f`.

Não foram executados navegador, servidor Next hospedado, Redis nativo/Lua real, provedor real, suíte integral ou CI. A prova não cobre os modos arbitrários de falha, corrida ou apagamento do importador, que pertence a outros autores; não altera o trabalho C5/#2881. A lacuna D10 sobre envio versus confirmação de inscrição continua separada e não é resolvida por importar contatos. Não se afirma confirmação humana, auditoria AAA, publicação ou disponibilidade ao cliente.

O ganho desta etapa é evidência para evitar construir novamente a elegibilidade de produto que já existe e para delimitar quais fatos uma página realmente pode cumprir. Não há código novo para o cliente nem aumento produtivo de IO, armazenamento, contador, envio ou franquia. Custos de desenvolvimento/CI/infraestrutura continuam desconhecidos, nunca zero; não há margem ou lucro certificado. Preços, limites, flags, gates, termos, contas e conteúdo real permanecem intocados. O root mantém a responsabilidade de reconciliar o lote/fila com C4; este ramo não fecha D7 global nem abre PR de produto.
