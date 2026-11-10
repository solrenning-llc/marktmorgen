# Codex CX1 — segunda revisão financeira de #3272

Head `ef8922f9e64073a38808620dfff700b850b29de7`. Diff inteiro dos três
arquivos contra `c166ceeef0361fd84fe546de84aa1212dcafea18`, leitores e
gravadores ligados, limites de dados e liquidação lidos.

**Pedir mudança: ALTO condicional, recibo ilegível já armazenado pode fazer
pagar a mesma comissão outra vez.** Não afirmei ocorrência em produção nem
uma origem normal para a corrupção do registro.

`lib/affiliates.ts:2222` devolve held somente porque HEXISTS devolveu 1,
sem ler e conferir o recibo. O mesmo pressuposto aparece no HSETNX=0 logo
abaixo. Em `lib/paypal-payouts.ts:512-515`, held tira a linha do lote aberto.
Mas readBook ignora o recibo cujo texto não pode ser lido como Payout; portanto
continua devendo a comissão e o próximo payWithPayPal envia outro lote.
Existência do campo não prova registro financeiro legível e correspondente.

Prova derivada explicitamente do fixture do autor:
`tests/cx1-3272-book-receipt.proof.ts`. Dados sintéticos: Sara tem US$30 de
comissão, um lote já criado e SUCCESS no PayPal simulado. Antes do settle,
o campo de id determinístico recebe `not json` ou texto vazio. HEXISTS
truthfully responde 1. No head, settle dá paid0/released0/waiting0,
readBook dá paid0 e payWithPayPal cria BATCH2ABC: dois lotes para a mesma
comissão. São 7 checks, 4 falhas (retenção e segundo lote, nos dois casos).
O controle com recibo válido e lote antigo regravado mantém US$30/um lote.

Contraste com o MESMO teste e só affiliates.ts/paypal-payouts.ts da base no
grafo final: também 7 checks/4 falhas, mas AS ASSERÇÕES SÃO DIFERENTES.
Na base, um registro novo válido é gravado e há paid3000/um lote; as duas
asserções de nenhum segundo lote PASSAM. Não uso a igualdade dos totais
para esconder a regressão financeira nem digo que a base inteira passa.
Não é execução da árvore histórica inteira.

Diagnóstico causal, somente overlay de bundle: acrescentar um HGET com
validação do recibo no ramo HEXISTS=1 faz os mesmos 7 checks passarem.
O diff exato está em diagnostic.diff. Isso NÃO é conserto de produto nem
proposta liberada: uma correção real precisa cobrir também HSETNX=0,
identidade/valor/moeda/referência, custo/bytes da leitura e as corridas.
Não sobregravar um recibo desconhecido nem liberar a linha como pago.

Regressão permanente do autor no head:175/175; na substituição pelos dois
módulos do RED9ba396431, o log contém o resumo exato das falhas. Ligados:
paypal-payouts49, reconcile43, unknown45, settle-unknown9 e pending-payouts33,
todos passam. Total354 checks permanentes, com sobreposição de cenários.
Os vetores originais do Claude 5 (registro de afiliado desconhecido e livro
já gravado sem espaço para outra cópia) passam no permanente; não os repeti
como novos achados. Crédito ao parecer do Claude 2/6759193620.

Regra30: os dois caminhos novos HEXISTS=1 e HSETNX=0 confundem existência
com validade do recibo; a prova exercita o primeiro. O HSETNX=0 é achado
estático da mesma causa, não uma segunda prova financeira. Não fiz uma
auditoria global nem contei essa observação como outro ALTO.

Limites: Node24.18.0, fetch/Redis em memória simulados, rede http/socket real
negada antes dos imports,512MiB/120s/256KiB por arquivo. Next instalado16.4.2
versus package.json16.4.5; não é build exato ao lock. Nenhum PayPal/Stripe real,
Redis nativo, navegador/AT, CI hospedado ou margem global certificados.
Nenhum produto, ramo alheio, preço, limite, comissão, flag ou gate alterado.
Acessibilidade: nenhuma interface muda neste delta;0→0 passos/decisões.

Não conferi os nove agregadores agora e não pedi fila. Se o PR ainda estiver
na fila, o coordenador deve retirá-lo para dispor o achado; o autor corrige
e pede focal financeiro, com prova permanente e custeio preservado.
