# Codex G — revisão independente adicional #1928

Head EXATO **1bc7ba7dade9564f6fec8dd1d2e8ab6330f622e4**. Anúncio canal **411c63c9913f8e2042b5987c18de45615fc0e23e** antes de diff/testes. Todo diff próprio **18caminhos** contra base1e8383de6c693545eae7dac8a64dcd71e0b4db83 lido: checkout/cartroute,shortlinkrules/route/UI,studiointegration,reader/admission,docs/tests. Corretivo próprio154be36cb31ec7846c0389a4daaf0d35858992f5..1bc lido. Revisão G adicional, sem substituir G2/cruzadofixo ou resolver reserva de outro agente.

## Resultado

Residual G2 de confirmação contraditória **FECHADO no helper conectado**: a MESMA permanente cart-link-contradictory-evidence, copiada sem mudar asserções para o pai, tem2testes/1passa/1falha no154 e2/2noatual. confirmedCartLink agora recusa error explícito ao lado deoktrue. HTTPstatus/okestrito/targetcompleto continuam conferidos pelos testes focais. O guard do snapshot/seleção foi lido no componente; não executei comportamento React/DOM/navegador neste retorno (limites abaixo).

**1 MÉDIO residual de admissão de leitura**, lib/cart-link-products.ts:59-64 e81-85. weigh desestrutura só o primeiro resultado de UMHMGET e valida apenas a lista interna; ignora resultado extra externo. A resposta `[["1",…24pesos],0]` não é envelope exato de um comando, mas vira peso conhecido baixo em vez do teto conservador. cartLinkProducts admite só2unidades adicionais e em seguida lê24registros existentes grandes. Mesmo concedendo TODASas4unidades do studio-page ao helper, a cobertura é300.000bytes e os24GETs efetivamente transferem446.390bytes. O teto por unidade da própria suíte/registro é50.000bytes; não é cálculo deUSDnem prova de prejuízo/invoice real.

Prova **tests/g1928-weight-envelope.proof.ts@7b689b889cb97aed31e01263485bf9b16a9b6aa8**, ramo **codex/g-review-1928-weight-envelope**:

- Fixture criada com claimHandle/ensureStatsId/setSubscription/addDraftProducts/setProductHidden/setProductFile reais noMemoryRedis. São30gratuitos e24pagos fora dohead; metadados de arquivoSINTÉTICOS comnome18.000caracteres, aceitos pelos escritores/leitor do catálogo e cada registro abaixo deMAX_PRODUCT_BYTES256.000. Não houve upload real, arquivo/blob real, chamada externa ou criação deconta real. Não alego que a rota pública de upload gere esses nomes: são registros existentes grandes aceitos na fronteira de armazenamento/leitura exercitada. Isso testa leitura segura sob resposta anômala do peso.
- Só o HMGET da pesagem é interceptado. GETs dos registros, bytes UTF8,admissõescountStudio e escrita dos registros são reais no stand-in. Retorno extra:`injected1,reads24,bytes446390,debits[4,2],paidBeforeFirst6,capacity300000,listed24`, **4verificações/2falhas**.
- **Mesma prova no pai154:4/2**, mesmos números. Blob do helper **243fefd34e1ac070afb88084df9e0a829db72627** idêntico em154e1bc. É residual herdado no último corretivo deUI, não nova regressão desse delta nem repetição do antigo caso200rascunhos.
- Controle HMGETexplicitamente desconhecido[null]:**4/4**,débitos[4,123],capacidade6.350.000,mesmos446.390bytes lidos. Os123sãoceil(24*256000/50000),antesdo primeiroGET.
- Controle respostarealíntegra:**3/3**,débitos[4,19],capacidade1.150.000,mesmosbytes. Não exijo que toda leitura use o teto quando o peso é conhecido; o erro é aceitar o envelope desconhecido como conhecido.

Reprodução: node tests/g-proof-run.mjs g1928-weight-envelope.proof.ts; controles G_WEIGHT_MODE=unknown eG_WEIGHT_MODE=healthy. Validar cardinalidade do envelope de um comando antes de aceitar seus pesos, ou conservar o teto/recusar antes dosGETs. Nenhum corretivo de produto foi implementado pelo G.

## Verificações e limites

6entradas focais cart-link-contradictory-evidence,cart-link-fixes,cart-link-evidence,cart-link-code-evidence,cart-link-code,short-link-cart:24verificaçõescustomizadas+11testesnode, todosaprovados. O draft-heavy antigopermanente agora lê dentro da admissão e os testes de recusa não fazemlistingGET; isso não fecha o novo envelope externo.

10entradas relacionadas cart,cart-offers,cart-physical,cart-reminder,cart-course,cart-shipping,cart-bundle,short-links,plan-cost-registry,store-data-registry:182custom+31node,0fail/skip. Totalcanônico **206custom+42node** aprovado. Não incluo nesse número as provasRED próprias.

- tsc --noEmit -p tsconfig.g1928.json@d6bbd9a761e75153310cdf526755d6029b32c893:exit0, módulos/rotas/comp/testes citados e prova própria, sem shim.
- ESLint nos9paths envolvidos (libs,componentes,rotas,contradictoryevidence eproof):exit0,nenhumdiagnóstico.
- gitdiff--checkbase1e8383de..HEAD:exit0.

**UI:** li o componente real inteiro e o driverDOMG2c9ad8d1b08ebbe2fcaa916b7cc6b995dd3ab4815; o runtimejsdom26.1 informado pelo G2 não existe aqui, nem jsdom nos módulos comuns/primários, e o executávelChromium esperado peloPlaywright está ausente. Não lancei navegador, não instalei runtime externo, não executei o driver nem inventei suas18verificações como minhas. O histórico G2 deReactDOM15/15fecha seus casos naquelehead, não é execução G atual. O caso success+error foi reproduzido diretamente nohelperreal e noREDdo pai; a associação de seleção/pedido foi analisada em fonte e seus testes estruturais, sem alegação deDOM/CSS/geometria/AT. Não certifico jornada de compra, Stripe real, margem global, CIglobal/build ou9checks.

Notas de execução: uma primeira fixture selecionou itens pelo campo depreço que o índice não tem e não acrescentou os metadadosgrandes; mostrava11.918bytes e só1falha de política. Foi descartada antes do parecer, corrigida paraKIND.paid com exigência explícita de24itens e TODOSosmodos/pai reexecutados. Somente logs `*-final.log` entram como prova financeira acima. Não alterei expectativas para fabricar falha.

Saídas **docs/reviews/g-1928-weight-output.txt** no mesmo ramo; runner4b980753948b2833c99b4f78678a8a089b3f446d. Comentário de resultado6686998310. Semproduto/reserva/ref/base/CIalheio/merge;C4única coordenadora,C1desligado.
