# Revisão Codex G de #1947 — retorno integrado e identidade de pendência

**Head exato7f1a309d7222f951b5cbb699e6707be67123a5ae: MÉDIO5803643633 FECHADO; novo MÉDIO condicional de ID inválido/concorrência.**

Retorno nominal começou no d2e9754540f2f75ce003330bf963298b8759c74b, anunciado3cd7a302. Durante a conferência pré-parecer o autor integrou main; anunciei o head7f1 antes de repetir seus testes no canal8d2d533a1023e89127d4cf1b22e0817e6f0b4e04. Não confundi o ensaio do head anterior com teste do integrado.

Li todo0861..d2e (6arquivos206+/7-), comparei as duas cópias da prova com15763ba2 (BYTE-ID, canônico+1crédito), reli a resolução de product/route e editor recebida do main e conferi o diff atual de13arquivos. Nove patches repetem o anterior exceto coordenadas de hunk; os quatro com contexto diferente foram lidos integralmente. O helper de campanhas continua blob8970d87b nos dois heads. Não alego auditoria global do #2810 nem de todo main herdado.

## Fechamento do achado anterior

Prova15763ba2911441e6349ddc147955480729f523d2 idêntica, SHA25655f3e73cffa28ebc76e5aa2a1a6c1a1e8481396ed59f6035ad25a4a0e25b6ca4:
- d2e e head REAL7f1: unapplied, healthy e lost **8/8 cada**;
- no0861 eram8/2 no modo não aplicado, preservado na evidência anterior.

A resposta informa cleanupPending quando o produto saiu e os textos não foram confirmados apagados; a repetição pelo ID correto alcança a limpeza e libera o slot. A provaG2ad5734a5 continua5/5 nos dois heads. O texto do aviso do editor foi lido; não fiz ensaio de browser/tecnologia assistiva. O MÉDIO do chamador antigo está fechado.

## Novo MÉDIO — product/route.ts:305–308; campaign-landing-store.ts:283–289

A repetição aceita qualquer id não vazio quando removeProduct responde unknown. finishLandingsDrop usa EXISTS do nome de chave calculado como confirmação de uma pendência, sem confirmar a identidade do produto. Um id malformado **<id>:gone** aponta para o marcador de exclusão do produto original. O helper encontra esse marcador e DROP_LANDINGS o apaga como se fosse um registro de campanha. O marcador original desaparece; o novo marcador criado é <id>:gone:gone.

**[Prova2f250bb3](https://github.com/solrenning-llc/marktmorgen/blob/2f250bb3a79962246f9a07187f777ba5b251a8c8/tests/g1947-retry-marker-alias.proof.ts):**
1. Loja, produto, página, campanha e sessão sintéticos criados pelos escritores reais.
2. Uma gravação antiga de saveLanding real fica pausada por promessa antes do EVAL; nenhum sleep nem avanço de relógio.
3. POST REAL remove o produto pelo ID correto:200, produto ausente no catálogo novo, campanha apagada, marcador:gone confirmado presente.
4. A MESMA sessão autorizada envia POST remove com id="<id>:gone". O pedido responde200; o marcador original passa de1a0.
5. A gravação antiga retoma, recebe o conflito de comparação, relê ausente e acaba saved. Campanha stale-request e slot240 reaparecem, embora o produto continue removido.

Nenhuma resposta Redis é substituída por valor falso nesta prova, nenhum registro/contador/marcador é forjado. O marcador foi criado e apagado pelos caminhos reais; só a ordem de execução é controlada e o segundo ID vem do corpo HTTP.

**MESMOS bytes da prova:**
- pai0861: **9/9**, pedido malformado404 e marcador preservado;
- corretivo d2e: **9verificações/4falhas**;
- head integrado7f1: **9verificações/4falhas**;
- controle no7f1, sem o segundo pedido malformado: **9/9**, marcador preservado e gravação antiga recusada com LandingsGone.

As quatro falhas são o sucesso dado ao ID malformado, o marcador removido, a campanha recriada e o slot revivido. **É regressão do novo caminho de repetição**, não resíduo que já estivesse vermelho no0861. Reabre a classe de ressurreição de dados do MÉDIO3 antigo por uma entrada adicional não coberta na provaG2.

**Condições e alcance:** precisa de sessão com permissão products na MESMA loja e de gravação antiga já admitida. A gravação é a função real; não executei a interface/rota do PR1950. Não demonstrei acesso anônimo ou a outra loja, exposição de comprador, invasão, pagamento ou estouro de margem. O grauMÉDIO é de integridade/retenção de conteúdo do criador sob ID fora do formato e concorrência. A campanha recriada continua contada; não é unknown transformado em custo zero.

O retry precisa reconhecer identidades reais de pendências/produtos e impedir que o sufixo de marcador seja interpretado como um produto; EXISTS de qualquer chave calculada não basta. Não basta apenas repetir o mesmo drop mais vezes. Não proponho afrouxar recibos ou liberar sala sem apagar.

## Verificações do head REAL7f1

**17 arquivos canônicos:432checks customizados+76node PASS,0falhas/skip.** Todos17status0. No d2e, o mesmo conjunto tinha429+76; não misturo os totais. Manifesto e28656739272425bb0d346b1ada42d07f5aca244, docs/reviews/g1947-7f1-manifest.json. As provas novas vermelhas e seus controles são separados desses canônicos; não declaro tudo verde.

tsc -p tsconfig.g1947-7f1.json: **17raízes/imports,exit0**, recorte estrito. Lint4paths:0erros/avisos; diff-check0. No d2e, tipos17raízes/lint6paths também0. Config8524291ca4fafc87d896aee955d084ebc6cd2daa. [Saídas integradas81a5ad1e](https://github.com/solrenning-llc/marktmorgen/blob/81a5ad1ea3fb27f16fdb14f5521684973302782a/docs/reviews/g-1947-7f1-output.txt); saída do d2e38310a19.

Cópias próprias /tmp/g1947-return-7f1, /tmp/g1947-return-d2e e /tmp/g1947-review-0861; produto rastreado intocado. Ramo próprio de evidências codex/g-review-1947-product-cleanup permanece baseado0861; os resultados do integrado vieram do checkout exato7f1, não dessa base antiga.

Sem Redis/Lua nativo, provedor/conta/pagamento real, browser/AT, CI global/build ou certificação geral de margem. Scripts Lua foram lidos, MemoryRedis foi o transporte de teste. Nenhum produto/preço/limite/flag/trava/reserva/ref ou CI alheio/merge alterado. C4 única coordenação; C1 desligado. MÉDIO anterior fechado; novo caso aguarda correção pelo dono e novo head. Parecer independente adicional, sem substituir cruzado fixo por inferência.
