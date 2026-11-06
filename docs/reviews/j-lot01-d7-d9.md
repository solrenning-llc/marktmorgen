# Conferência nominal do lote 01 — D7, D8 e D9

Base de leitura: main2bfa8ade8f59555b8d57aa03e554a99092a1285b, árvore3298708dd28b4342286fa86241e367f7fbc8fdbf. Fila12c016ae20b80ed5dbe9344bb44a38f30a42983f; lote174fb192e648b00cefed2e9e545e7c2227eb2b17. PedidoC4-2830-CX-171. Esta conferência é leitura de código, não teste GREEN, publicação, ativação ou certificação global. Inventário recebido136PRs/todosfilenames/0erro; novoscandidatosforamreconferidosantesreserva.

## D7 — item10: integração já existe parcialmente; não reconstruir importadores

Pedido fila2231: produtos e páginas importados podem cumprir fatos correspondentes; importação nunca cria lead confirmado nem venda. Estado documental a fazer2233/B19 em1232.

- lib/imports.ts755–800 chama addDraftProducts; lib/store.ts4075–4107 grava produto normal inicialmente hidden:true. Após publicação normal, lib/path-facts.ts186–195 lê catálogo/entregáveis sem discriminar origem; lib/path-rules.ts291–293 fecha Day2 com produto listado/arquivo/curso/link. Importar sozinho não conclui o fato.
- lib/clickfunnels-funnel.ts491–517 cria páginas normais inicialmente ocultas, mas não muda store.name/bio. PathFacts(path-rules167–200) não tem fato de página adicional importada; o fato de apresentação é name/bio(path-facts193). Não inventar uma missão para fazer qualquer página importada concluir Day1.
- Os leads usados pelo Path vêm de fs: (path-facts155–158), não de contatos importados. A distinção enviado/confirmado é a lacuna D10, não ficou resolvida aqui.
- readPathMoney(path-facts94–123) exige vendas reais/livemode; compras/concessões importadas não são essa fonte.
- tests/path-facts.test.ts19 usa addProduct/setProductLink, sem fluxo de importação real. docs/marktmorgen-path.md295 ainda declara pendência.

Menor trabalho real: prova de integração do importador com link, antes/depois de publicar, e importação sem inventar leads/vendas. O resultado pode ser teste/documentação de comportamento existente, não produto novo. lib/imports está em1933/2048; store/catalog em1933 e reservaB2; não editar esses autores. Nenhuma decisão de preço/flag/conta necessária; páginas significam apenas fatos correspondentes, sem missão nova.

### D7 — atualização factual após a prova de integração 53da5c56

A lacuna de prova descrita acima foi verificada no ramo `codex/j-d7-imported-path-proof`, commit `53da5c560a2d17db51e7e904f97233030c97e464`, árvore `65d2818b0f46bfa777b5f5d9b48f18c9d94acc8c`, sobre a mesma fonte congelada `2bfa8ade8f59555b8d57aa03e554a99092a1285b`. A conferência inicial fica preservada como histórico; esta atualização acrescenta execução concreta ao que antes era inferência de código.

Resultado: **28/28 checks, exit 0**, usando `startImport → addRows → finishUpload → runImport`, escritores reais de publicação e leitores/regras reais do Path. O produto com link foi realmente importado como oculto e deixou Day 2 aberto; `setProductHidden(..., false)` confirmou a publicação e o leitor passou a Day 2 concluído. Contato importado com acordo relatado e compra importada com `email:false` tiveram seus registros reais confirmados, sem criar lead do Path, venda ou campo `fs:*`. A compra importada continuou presente enquanto o controle financeiro sintético passou de uma venda própria para zero, sem confundir grant com venda.

Também foi importada e publicada uma página nativa com os escritores reais: ela não concluiu Day 1 enquanto faltava a introdução da própria loja. Somente a gravação real de `store.bio` por `updateDetails` concluiu esse fato. Não há missão nova para página adicional nem mudança na regra de fatos correspondentes.

O runner verificou **417 arquivos rastreados do grafo e de sua configuração** contra os blobs da fonte congelada. Prova adicional: **155 checks relacionados aprovados** (ClickFunnels/importação 56, Path facts 39 e Path rules 60), TypeScript estrito do grafo real, lint dos dois executáveis, scanner oficial 4.104/zero mais os três caminhos próprios/zero e whitespace sem achados. Execução reproduzível em `scripts/j-d7-imported-path.mjs`; relatório completo em `docs/reviews/j-d7-imported-path.md` no commit da prova.

Antes de avaliar o grafo, o runner bloqueou a rede no dispatcher real do SDK com `MockAgent.disableNetConnect()`, no socket e no fetch de inicialização. Os controles deliberadamente bloqueados passaram. Foram **19 GETs Stripe explicitamente sintéticos** (9 sessões, 9 payment intents, 1 refunds), sem tentativa adicional no dispatcher/socket e sem email, busca de link, Blob, outro provedor ou HTTP de inicialização. MemoryRedis canônico em processo isolado; nenhuma operação em fornecedor ou registro real.

Estado qualificado: **comportamento D7 existente verificado por integração sintética**. Não houve RED de produto, implementação nova, PR, CI ou entrega global D7. Navegador, Next hospedado, Redis nativo, concorrência arbitrária do importador e fornecedor real não foram certificados. A lacuna D10 sobre envio versus confirmação permanece separada. A prova evita reconstruir importadores e não autoriza alteração de preço, limite, flag, gate ou conta; custos de desenvolvimento/infraestrutura continuam desconhecidos, nunca zero.

## D8 — item11: resumo local em andamento, não um segundo cron de e-mail

Pedido fila2237–2241: resumo semanal factual no estúdio no fuso salvo, e-mail apenas se justificado/franquia/mayNotify/MR; escopo e custo antes/depois. Recurso irmão: weeklyMessage(stats-report375–435) e cron/weekly74–115; calcula UTC(stats-report271–275, SummaryWindow36), não usa mayNotify, e-mail pela empresa. Não concluir D8 por existir esse cron.

Path guarda answers.timeZone(path61/path-rules105–106), check-ins locais(path214–217) e mayNotify(path-rules566–568). A página Path43–95 antes desta unidade não trazia resumo semanal. Contagens acumuladas e missões sem timestamps não permitem inventar vendas/missões daquela semana. stats-report ocupado1496, cronweekly2516 e statspanel/stats2571. Sobreposição parcial E8/HX1 na fila1565 não autoriza duplicação.

**Atualização posterior à conferência:** root escolheu D8u1 cliente-visível com somente dados já lidos: cartão Your week in Path, SEG–DOM no fuso salvo, datas distintas salvas e streak atual separado; sem e-mail/IO/persistência/counter novo. Reserva89f066e ANTEScódigo; inventário145PRs/todosheadsfiles/0erro/zerooverlap5paths. PR2867/headbc57528f26d223bc657cfb2477b3fd213bf6950c, base749dac; teste real12/12+432ligados/strictTS-lint-scanner4126/0/client271/271. REDcorrigidod98e24ae preservado; primeirod7e4 tinha expectedstreak1 incorreto, única correção1→3 demonstrada pela regra antiga, antesGREEN. Revisão independente/noveexatos ainda necessários. Estado TESTADO NUM PR, não incorporado/publicado/D8globalfeito; e-mail continua fora.

## D9 — item12: PayPal real para Path ainda exige contrato e fontes ocupadas

Pedido fila2243–2247: PayPal em Day7/níveis só com confirmação servidor/loja/modo real e reembolsos descontados; nenhuma aprovação da plataforma inferida. Custo/cache não calculados, integração pausada não pode ser ligada.

- readPathMoney(path-facts95) retorna0 semStripe. Mesmo comStripe, readPaidSales(stats1072–1078) inclui PayPal, mas payPalSale(stats1003–1025) não põe livemode; path-facts109–110 o exclui.
- paypal-sales526–558 confirma captura e grava Paid; readPayPalSales911–928 filtra própria statsId. Porém Paid406–421 não guarda modo/beneficiário; PAYPAL_ENV60–64 atual não prova modo histórico.
- watchPayPal778–786 registra somente REFUNDED integral; readPayPalRefundsWithCoverage958–983 retorna valor integral. Cobertura parcial para níveis não localizada.
- Aviso correto atual: path-checkout-notice6 e marktmorgen-path154–155/297 dizem que PayPal não atualiza Path ainda.

Unidade real exige prova de ambiente/beneficiário/cobertura de reembolso no registro, legados desconhecidos preservados, leitor/admissão/cache/custo antes de Path. Não satisfazer isso com helper que aceita live:true fornecido pelo chamador. Fontes paypal-sales estavam ocupadas2839/2809 e agora também frentes monetáriasC4; stats1933/2571. Combinar com dono, nunca abrir/ativar parceiro por configuração. Nenhum arquivo produtivo foi alterado nesta conferência.
