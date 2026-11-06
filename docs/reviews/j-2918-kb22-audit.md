# Revisão documental G8 — #2918 / 601 [KB22]

Claim anterior à leitura: PR comment 6696749585; reserva de canal `3f32f155821747776a65c015ff497558650962c8`. PR OPEN, não draft, com um arquivo Markdown novo e 63 linhas na consulta efetuada.

**Head revisado:** `03cf63f2b70e2b1a3760f6c9a2b7db0fa4f79fa0`, árvore `648385c5e202eb616d1d568551f018e1bec11efa`. **Main de referência:** `5c07315505e1d53ee6401021601cd688fa98ecda`. O documento integral `docs/reviews/c5-kb22-audit.md`, seus 18 subitens e as 13 unidades foram lidos. Este relatório é o único arquivo próprio novo; o documento do autor, produto, refs do autor e CI permanecem sem alteração.

## Conclusão

**Classificação VR: LOW, documental.** Os ajustes abaixo se apoiam em contradições ou lacunas de referência estática; não atribuem gravidade a comportamento de produto não executado.

Há quatro ajustes documentais concretos recomendados antes de usar as 13 unidades como fila pronta para implementação. São correções de baseline, classificação e desenho; **não são falhas de produto reproduzidas**. Nenhum recurso foi executado, aprovado comercialmente, ativado ou declarado ausente apenas por falta de resultado em grep.

| ID | Local no documento do autor | Evidência estática na fonte fixada | Correção proporcional |
| --- | --- | --- | --- |
| D1 | linha 27, item 14; U9 na linha 49 | A frase “Client events for view, add to cart, checkout start not found” omite código cliente existente. `components/store-pixels.tsx:121` chama Meta PageView; `:249` chama Meta InitiateCheckout e `:250` chama GA4 begin_checkout. O handler de submit `:328`–`:345` chama esse caminho. O efeito `:293` exige estado de consentimento on. | Registrar visualização/início de checkout como caminhos existentes a verificar; limitar a lacuna ao que ainda não for atendido, por exemplo add-to-cart ou contexto por etapa. Reutilizar o caminho de consentimento e evitar eventos duplicados. A leitura não prova que os eventos disparam corretamente em navegador. |
| D2 | linhas 6, 30, 53 e 62 | Classe 1 é definida como “buildable now with no money or gate”, mas U13 declara “Needs owner wording first”; o próprio documento declara custo de Redis/PDF desconhecido e ainda sem linha de pior caso. `docs/codex-queue.md:21703` exige custo por plano/mensal/anual e teto antes do gasto; `:21705` mantém MR/TX. A ressalva do autor existe, portanto não se trata de um custo ocultado. | Separar “candidato técnico” de “pronto/liberado”. U13 continua aguardando a decisão expressamente nomeada pelo autor; as unidades com custo desconhecido continuam condicionadas à demonstração de custo/MR e às permissões aplicáveis. Não chamar execução na função existente de gasto nulo nem interpretar “sem fornecedor novo” como clearance. Nenhuma flag ou gate precisa ser alterada para corrigir o documento. |
| D3 | linha 16 e U4 na linha 44 | `lib/stats.ts:2335` já inclui a coluna tax no cabeçalho do CSV; `:2341` lê total_details.amount_tax e `:2368` grava o valor na linha. `app/api/store/export/route.ts:125` já chama salesCsv. | Resolver o unknown da coluna e retirar “sales CSV columns” como entrega nova genérica. Um resumo agrupado por região pode continuar como candidato distinto, com definição da fonte/região/cobertura. A presença da coluna não prova relatório fiscal completo nem valida os valores em runtime. |
| D4 | item 18, linha 31, e U8 na linha 48 | `docs/codex-queue.md:21672` já inclui controle por página de robôs de busca e IA em 594 [KB15]; a coluna Other work “none” precisa dessa ligação. `lib/agentic-feed.ts:3`–`:5` descreve partial upsert interno, não provider submission; `:23` exporta acpFeedBatch, que devolve objeto ou null. Busca estática de referências a acpFeedBatch em lib/app mostrou apenas sua definição. A listagem de rotas rastreadas mostrou store-robots e feeds de blog/podcast, sem demonstrar uma rota pública ACP desse helper. | Coordenar com KB15 e nomear as superfícies reais: helper/feed interno e robots públicos são contratos diferentes. “Off means feed 404” não é critério aplicável a uma função que retorna objeto/null; somente adotar esse HTTP se uma rota real e seu escopo forem identificados. Não inventar endpoint nem nova publicação ao fornecedor para cumprir o teste proposto. |

## Conferências e limites adicionais

- **ACH / item 1:** `lib/instant-pay.ts:21`–`:37` de fato lista us_bank_account e escreve excluded_payment_method_types. O texto documenta a exclusão intencional; nenhuma mudança de pagamento foi proposta nesta revisão.
- **Parcelas / item 2:** foi localizada a construção em `lib/store-checkout.ts:628`–`:640`: recorrência e metadados kind=plan/plan_payments/plan_interval. Isso melhora a referência que o autor declarou não ter localizado. Continua sendo evidência de código, não comprovação de pagamento parcelado funcionando.
- **PDF / itens 4–6 e U1–U3:** a reutilização de tagged-pdf é coerente com a infraestrutura existente. `lib/tagged-pdf.ts:10`–`:13` explicita que a estrutura por si só não prova conformidade e mantém veraPDF/leitor de tela pendentes. O autor preserva essa limitação; não há certificação PDF/UA nesta revisão. Numeração, lote, custo e retenção não foram executados ou validados.
- **Preview / item 10:** não confundir acesso autenticado a rascunho com link de teste para comprador. `lib/draft-view.ts:21`–`:31` verifica sessão/equipe e falha fechado; `app/[handle]/p/[product]/page.tsx:114`–`:115` ainda exclui hidden da página comum do produto. Isso não comprova nem invalida, sozinho, a necessidade de um link assinado novo.
- **Clone / item 12:** 582 [KB3], `docs/codex-queue.md:21633`–`:21634`, já é dono do pedido de duplicação; “covered” é cobertura de fila, não prova de entrega. Convém distinguir “já enfileirado” de classe 2 “done” na linha 33.
- **Plano / item 8:** `lib/billing-reminders.ts:181` lê hosted_invoice_url e `:184` restringe a URL de fatura em aberto a HTTPS. Isso não demonstra uma lista de faturas no estúdio nem autoriza um novo leitor em qualquer condição de conta/gate. Não afirmamos existência/ausência de portal completo.
- **Tiers / item 15:** `lib/tier-rules.ts:20`–`:21` confirma os limites de dois a seis. A regra descrita no arquivo é leitura do produto atual; sem execução nesta revisão, “done” permanece a classificação do autor, não certificação nossa.
- **Restante dos itens 7, 9, 11, 13, 16 e 17:** o texto foi lido integralmente; não fizemos verificação comportamental de faturas, preferências, diretório, WAF contratado, reembolso fiscal ou exclusão. Ausência de grep não é prova de ausência funcional, e configuração de conta de fornecedor não é inferível de vercel.json. Não há parecer fiscal/legal nem aprovação de fornecedor, conta, termos, preço ou gasto.

## Ownership e método

A fonte primária é o diff integral de #2918 mais consultas estáticas `git show`, `git grep` e `git ls-tree` na main SHA acima. Linhas do autor são contadas no Markdown novo; referências de produto são da main fixada. As ressalvas do autor — grep não demonstra comportamento, PRs OPEN não enumerados, métodos/portais/custos pendentes — foram preservadas na avaliação. Não atribuímos desonestidade ao autor por registrar unknowns.

Não foi refeita uma varredura global de PRs. As branches citadas no documento e os estados de ownership C5/root são metadados provisórios, sem prova de ausência de outros autores. Antes de reservar qualquer implementação, exige-se inventário atualizado dos arquivos e coordenação com os donos. Os overlaps confirmados aqui são da fila congelada (KB3 e KB15), não alegações de PR ativo descoberto por adivinhação. Tampouco se aprova o paralelismo U4/U5/U6 sem esse inventário.

**Execução:** nenhuma rota, teste, provider, build, TypeScript, lint, browser ou scanner de produto foi executado nesta atividade. Nenhum RED/GREEN/CI foi alegado. A atividade interrompida #2933 não foi retomada nem sua sessão consultada. O HEAD local antigo, os proofs, refs e logs anteriores não foram alterados por esta revisão.

Uma consulta posterior de fonte/status via exec_command não iniciou: o executor retornou “No such file or directory” ao criar o processo. Não foi repetida nem substituída por outro executor. Por isso não há recibo novo de status local nem scanner CLI. O relatório foi checado apenas como texto em memória para whitespace e padrões de dados públicos antes de publicar o único arquivo por API. Essa checagem documental não executa código de produto e não equivale ao scanner CLI oficial.


---

# Focal documentary return — exact da55d3091050d5b7417e92f6248e6c54accc07e2

This receipt supersedes only the four documentary LOW findings in J5807614184 at03cf63f2. The complete earlier report above, its scope limitations and original cee10c3 commit remain preserved. Root's new channel claim58b85bb9 preceded the corrective delta review; root retains the formal GitHub opinion.

**Conclusion: D1–D4 CLOSED. No new GRAVE, MEDIUM or LOW documentary finding observed in the complete corrective delta. PODE ENTRAR as documentation only, after the nine exact final SUCCESS checks, fresh clean gates and the author's normal expected-SHA merge.** This is not implementation readiness, a cost authorization, legal/fiscal advice, feature activation or proof that a customer journey works.

The entire03cf63f2..da55d309 delta is one commit changing only docs/reviews/c5-kb22-audit.md, final blob315df3d123edae12229f18060fe24b34632f1f36. The final document, all18 rows, all13 proposed units and its stated unknowns were read in full.

| Original finding | Exact documentary correction | Focal disposition |
| --- | --- | --- |
| D1 — existing client events omitted | Item14 now cites existing page-view initialization and checkout-start calls in components/store-pixels.tsx, the state-on consent boundary and the checkout submit handler. U9 narrows future work to product view/add-to-cart and explicitly preserves existing page-view/checkout-start paths. Source-only/browser-not-verified language remains. | CLOSED: existing source is acknowledged without promising verified browser delivery or duplicating those existing calls. |
| D2 — class1 confused with ready/cleared | Class1 is now explicitly a technical candidate, NOT cleared implementation; every unit still needs worst-case cost/MR and applicable owner wording. Item17/U13 is explicitly class3 until the owner gives wording. The cost unknown remains unknown, never zero; absence of a new supplier is not cost clearance. | CLOSED: no permission to implement, change a gate/flag, spend or bypass owner/MR prerequisites is created by the correction. |
| D3 — tax CSV column left unknown/replanned | Item3 and U4 now identify the existing tax column, total_details.amount_tax read/write and export route. Generic tax-column work is removed; the remaining proposal is a separately defined regional summary, with source/coverage still requiring verification. | CLOSED: source baseline is corrected without claiming a tested fiscal report, tax treatment or legal compliance. |
| D4 — KB15 overlap and invented HTTP feed surface | Item18 now cross-references594[KB15], describes acpFeedBatch as an internal partial-upsert object/null helper, and identifies storeRobots plus its real route/proxy mapping. U8 no longer requires an invented feed404 or supplier submission; it stays a future robots-setting candidate coordinated with KB15. | CLOSED: the nonexistent-HTTP acceptance requirement is removed; no endpoint, publication, default change or new supplier action is authorized. |

## Static source reconfirmation and limits

Reconfirmation stayed on frozen main5c07315505e1d53ee6401021601cd688fa98ecda, matching the author's stated audit baseline:

- components/store-pixels.tsx blob8e23d7c8: Meta PageView, Google config, checkout events and submit handler are present; the initialization/submit listener is behind state === "on". These are function-call/source observations, not provider delivery, tracking success or browser assertions.
- components/store-cart.tsx blob442659b6 was read for the narrowed add-to-cart proposal. Its actual browser event/storage/cart behavior was not executed.
- lib/stats.ts blob23f64960 and export route blobd01c2acf contain the cited tax/buyer_country columns, amount_tax formatting and salesCsv route. Presence does not validate amounts or regional tax semantics in runtime.
- lib/agentic-feed.ts blobb4c31848 declares internal partial upsert and returns object/null; tests/agentic-feed.test.ts blob048023cd imports it. storeRobots in lib/store-sitemap.ts blob9e6773da, store-robots route blobc3c25bd0 and proxy blob8fc2ffa9 establish the actual robots surface.
- The complete queue blob12c016ae20b80ed5dbe9344bb44a38f30a42983f was read after the contents endpoint returned only its SHA. Its594[KB15] text at21672 does include per-page search/AI robots control; an empty contents response was not mistaken for empty source.

No new repository-wide caller/route absence proof was made in this return. The author's “not found”/only-test-caller statements remain bounded by its disclosed static method and the earlier audit, not a blanket certification that every possible runtime surface was searched or tested. The important D4 correction is choosing an identified robots contract and removing the invented feed-HTTP acceptance step.

The existing caveats are retained: greps show presence, not behavior; OPEN PRs were not enumerated by the original author; supplier account configuration, worst-case PDF/Redis costs, permissions, owner wording and implementation file ownership still require their own fresh checks. The unchanged note that U4/U5/U6 may run in parallel is not a fresh reservation/inventory approval from J.

**Execution in this return: NONE.** No route, product test, RED/GREEN, TypeScript, lint, scanner CLI, build, browser, provider, account, payment or CI was run or certified. Source retrieval and exact textual comparison used GitHub reads only. The author document, product, author refs and CI were not edited. Only this existing own report is updated, in English, through its normal expected-blob update.
