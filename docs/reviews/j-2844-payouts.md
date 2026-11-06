# Segunda revisão financeira de #2844 — Codex J

Head revisado: `7bd48a58638a80209c754b50317ac6b8f2384c30`, ramo `claude4/payouts-exact`. Base: `2bfa8ade8f59555b8d57aa03e554a99092a1285b`. RED permanente do autor: `26485e2b8c5b7967496fb5fc7c9b78ae943c3b89`.

Parecer: **não pode entrar**. Um GRAVE confirmado independentemente, com descoberta atribuída ao Revisor 1; um MÉDIO de regressão no payday; e um MÉDIO herdado no validador de metadados tocado pelo PR. Nenhuma alteração de produto, ramo do autor ou CI foi feita nesta revisão.

## GRAVE — claim de item não prova lançamento no livro (Revisor 1)

Local: `lib/paypal-payouts.ts:495–511`; dependência real: `lib/affiliates.ts:1260–1283`.

O SET NX de `nl:pp:item:<item>` acontece antes de addPayout, que gera um id aleatório e grava outro hash. Se o SET foi aplicado mas sua resposta se perdeu, o novo throw impede o lançamento. Também ocorre se o SET respondeu OK, mas o HSET do livro lança antes da gravação. Na nova tentativa, NX retorna null, que é tratado como livro já lançado; a linha não entra em still, e o lote é apagado. A dívida continua no livro e não há reserva pendente; outra chamada real a payWithPayPal envia novo lote para o mesmo destinatário.

Prova independente `tests/j-2844-settlement.proof.ts`, com Redis em memória, fetch sintético e helpers reais connectPayPal/payWithPayPal/settlePayPal/readBook/onTheirWay. Nos dois vetores: primeira chamada rejeita; retry `{paid:0,released:0,waiting:0}`; `paidInBook:0`, `away:[]`, `secondPay:true`, `batchesSent:2`. Quatro asserções de proteção falham. Não é pagamento observado nem ataque real. A descoberta original é do Revisor 1, já anunciada no mesmo head antes desta revisão.

Correção necessária: prova durável e idempotente da mesma operação de lançamento; um claim isolado nunca pode significar livro confirmado nem liberar quem já foi pago pelo fornecedor. Preservar reserva até resolver o estado. Não apagar o claim cegamente, pois uma gravação pode ter sido aplicada com ACK perdido.

## MÉDIO — leitura desconhecida consome o payday do mês

Local introduzido: `lib/paypal-payouts.ts:72–82`, chamador `lib/affiliate-payday.ts:187–190`.

readLink agora lança em resposta desconhecida, mas payday consome o claim mensal antes de paysAutomatically. Na falha, não há pagamento nem aviso enviado; o retry saudável encontra o mês tomado e não tenta mais. O estado automático continua configurado, mas aquele payday está perdido. Não basta validar apenas que paysAutomatically rejeita isoladamente.

Prova `tests/j-2844-payday.proof.ts`, chamando sendPaydayEmails real, storesAfter real e dados de loja com statsId válido. Controle saudável envia um batch sintético. Com apenas um GET do vínculo respondendo `[]`: primeira passagem `{seen:1,due:1,sent:0,failed:1,complete:true}`, claim mensal `["1"]`; nova passagem saudável `{seen:1,due:1,sent:0,failed:0,complete:true}`, batches=0. Duas asserções de recuperação falham.

Correção necessária: resolver a leitura que pode falhar antes de consumir a tentativa mensal ou dar recuperação durável vinculada à mesma operação; nenhuma liberação cega de claim alheio.

## MÉDIO herdado — metadado auto malformado autoriza pagamento

Local: `lib/paypal-payouts.ts:82–83,614–615`. A validação tocada continua conferindo só client/secret, sem validar auto/at. Não atribuído ao delta: a aceitação desses campos já existia no pai.

Com vínculo válido criado por connectPayPal e somente `auto` substituído pelo texto `"false"`, paysAutomatically retorna true. A prova do payday chega ao efeito: sendPaydayEmails envia um batch sintético, embora não haja booleano true como autorização armazenada. Também são aceitos como true `1`, `{}` e `[]`; null vira false conhecido. Isso viola a regra de que forma desconhecida não vira permissão ou estado conhecido. Validar integralmente o vínculo, inclusive consentimento booleano e instante, antes de usá-lo.

## Conferências executadas

- Diff integral dos três arquivos do PR, nos dois commits, no head exato.
- RED inteiro do autor no pai `26485e2b8`: **101 checks, 72 falhas**. Mesmo arquivo no head: **101/101**.
- Sete arquivos ligados no head: **295 verificações aprovadas**: paypal-payouts-exact 101, paypal-payouts 49, paypal-payouts-unknown 45, paypal-payouts-reconcile 43, pending-payouts 33, affiliate-payouts 22, affiliate-pending-payouts-render 2. Execução pelo runner próprio usando testAliases/testEnvironment canônicos.
- Provas adicionais: settlement **15 checks, 9 falhas** (4 de recuperação e 5 de metadados); payday **5 checks, 3 falhas** (1 de metadados e 2 de recuperação), com controle saudável aprovado.
- TypeScript strict/noEmit/incremental false, configuração herdada do tsconfig do repositório e imports reais de paypal-payouts, affiliate-payday, página, teste do autor e duas provas: zero diagnósticos.
- ESLint dos dois arquivos de produto, teste do autor, duas provas e runner: zero erros e zero avisos.
- scripts/check_public_data.py: **4109 arquivos tracked, zero ocorrências**, incluindo as evidências finais.
- git diff --check: aprovado.

Comandos principais: `TMPDIR=/dev/shm node scripts/j-review-2844-run.mjs` (RED adicional esperado); passar os sete nomes de teste ao mesmo runner para a suíte ligada. O RED do autor foi executado em checkout detached do pai e o checkout próprio foi restaurado depois. Os blobs de produto no ramo de provas permanecem idênticos ao head revisado.

Limitações: não rodei navegador real, Redis nativo, PayPal/Stripe reais, ponta a ponta de produção ou CI. Renderização ligada é server-side do componente existente, não validação integral da página autenticada. Todos os efeitos financeiros e de rede dos testes são sintéticos. Nenhuma conta, contato, pagamento, chave real, preço, limite, comissão, flag ou trava foi alterado.
