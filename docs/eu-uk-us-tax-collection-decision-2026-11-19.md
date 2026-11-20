# Impostos das vendas recebidos na própria cobrança: decisão do dono (19/11/2026)

Etiqueta: [IV1], item 789 de [docs/codex-queue.md](codex-queue.md). Regra resumida em [AGENTS.md](../AGENTS.md), seção "IV". Gravado pelo Claude 4 num PR só de documentação. Este registro não muda código, preço, limite, comissão, trava nem flag. Nada fica disponível ao cliente por ele (regra VR).

## Proveniência

Solicitação do dono (19/11/2026, por volta das 21h30, horário de Fortaleza), na sessão do Claude 4. Primeiro o dono escreveu: "eu quero desde o primeiro dia aceitar consumidores europeus e britânicos..". Depois respondeu a duas perguntas do Claude 4:

1. Como o Marktmorgen recebe do criador o IVA que deve pelo art. 9a. As opções eram o crédito pré-pago e a fatura depois. O dono escolheu "Outro".
2. O que fazer, no primeiro dia, com os produtos físicos enviados à UE e ao Reino Unido. As opções eram recusar ou construir. O dono escolheu construir, com texto próprio.

As duas respostas estão abaixo, na íntegra.

Pedidos repetidos: o Claude 4 conferiu o main (4dddd54f3), os 292 PRs abertos (pelos heads, com `git grep` e `git diff` só com git) e a fila. A busca foi pela data e hora, pela etiqueta [IV] (livre), pelos termos "IOSS", "intermediário de importação" e "pela taxa da plataforma" e pelo conteúdo. Não há registro equivalente.

Há partes relacionadas, que este item reaproveita sem duplicar:

- 7 [C-UE], 8 [C-UK], 9 [C-US] e 300–303 [9A-1 a 9A-4], com os rascunhos de `lib/deemed-supplier-drafts.ts`;
- 331 [RC1] (Stripe Tax nos planos do próprio Marktmorgen);
- 753 [IR1] (recibos e impostos do criador);
- o caminho de abertura do coordenador C2-20261113-1320-ABRIR-1, que recusa consumidores da UE e do Reino Unido;
- a menção, em [eu-vat-official-sources-2026-11-13.md](eu-vat-official-sources-2026-11-13.md), à "decisão do dono de vender a consumidores europeus desde o primeiro dia" (13/11/2026). Ela não estava gravada na fila; este registro a confirma e a detalha.

## Texto do dono, primeira resposta (literal)

> Escolho "Outro": o IVA é recebido na própria cobrança, pela taxa da plataforma (application fee), na conta de plataforma Stripe da Solrenning LLC. Sem crédito pré-pago e sem fatura depois.
>
> 1. Como funciona: o comprador da UE ou do Reino Unido vê o preço com o IVA antes de pagar e paga tudo numa única cobrança direta na conta Stripe do criador. Na mesma cobrança, application_fee_amount = parte do plano (hoje 0%) + IVA + custos de receber esse IVA. A Stripe manda essa parte direto para a conta da Solrenning LLC no momento do pagamento; o restante fica com o criador. O imposto automático do próprio criador fica desligado nessa venda, para o IVA não ser cobrado duas vezes. A Solrenning LLC recolhe o IVA da UE pelo OSS não UE e o do Reino Unido pelo HMRC.
>
> 2. Por que este caminho: pelo art. 9a do Regulamento de Execução 282/2011, quem deve o IVA dessas vendas é a Solrenning LLC, não o criador. Recebendo o imposto no mesmo pagamento em que a dívida nasce, a Solrenning LLC nunca paga IVA que não recebeu, nunca guarda dinheiro do criador antes da venda e nunca depende de o criador pagar depois. O IVA é somado por fora do preço e nunca sai da receita nem da comissão da Solrenning LLC.
>
> 3. Por que não o crédito pré-pago: a Solrenning LLC guardaria dinheiro do criador antes de qualquer venda, contra a decisão de 29/09/2026 de nunca movimentar dinheiro de terceiros. Também traria devolução de saldo, risco de câmbio (IVA em euro ou libra, saldo em dólar) e vendas paradas quando o saldo acabasse.
>
> 4. Por que não a fatura depois: a Solrenning LLC deveria o IVA aos governos mesmo se o criador não pagasse a fatura, o que pode gerar prejuízo, proibido pela regra de margem.
>
> 5. Por que a conta da Solrenning LLC: pela resposta da Stripe registrada em SR5, a conta de plataforma brasileira conecta criadores de fora do Brasil sem taxa da plataforma. O recebimento do imposto na própria cobrança só funciona na conta de plataforma da Solrenning LLC.
>
> 6. Reembolso e contestação: no reembolso, a parte do IVA da taxa da plataforma volta junto com o dinheiro do comprador, e a próxima declaração do OSS e do HMRC é corrigida. Na contestação perdida, a parte do IVA não volta ao criador, salvo se o país devolver o imposto (leitura usada: não devolve).
>
> 7. Planos do Marktmorgen: para criador da UE com número de IVA válido, sem IVA, por inversão do sujeito passivo; sem número válido, IVA do país dele pelo OSS, por fora do preço, na fatura da assinatura. No Reino Unido, pelas regras britânicas equivalentes.
>
> 8. Estados Unidos: o mesmo mecanismo vale para o sales tax das vendas das lojas, nos estados cuja lei trata a Solrenning LLC como "marketplace facilitator", acima do limite de cada estado. O sales tax dos planos entra na fatura da assinatura, nos estados que tributam software por assinatura e acima do limite de cada estado. O código soma as vendas por estado e liga cada registro e cada cobrança antes do limite. Registrar em todos os estados de uma vez não é exigido por lei.
>
> 9. Abertura: só abro as vendas quando tudo estiver pronto para todos os estados americanos, a UE e o Reino Unido: conta de plataforma Stripe da Solrenning LLC aprovada; Solrenning LLC registrada no OSS não UE e no IVA do Reino Unido desde a primeira venda; registro em cada estado americano quando a lei exigir; e código testado de ponta a ponta (imposto por fora do preço, duas provas de localização do comprador dos arts. 24b e 24f, registros do art. 63c guardados por 10 anos, devolução do imposto no reembolso e declarações). Até lá, PLANS_ON_SALE continua false e a trava que recusa vendas a consumidores da UE e do Reino Unido continua ligada.
>
> 10. Riscos que continuam: a Stripe ainda precisa aprovar a conta da Solrenning LLC, as leis e as alíquotas podem mudar até a abertura (conferir de novo nas fontes oficiais, com data, antes de abrir) e a leitura vem de fontes oficiais conferidas, sem parecer de advogado ou contador. É o caminho de menor risco, não de risco zero.
>
> Isto não muda nenhum preço, limite, comissão, trava ou flag.
>
> Sim: receber o IVA na própria cobrança, pela taxa da plataforma na conta de plataforma Stripe da Solrenning LLC, e só abrir as vendas com tudo pronto nos EUA, na UE e no Reino Unido é o caminho mais seguro e correto entre as opções, e o mecanismo está dentro da lei. Ficar dentro da lei depende de executar tudo: registros no OSS e no HMRC, registro em cada estado americano quando a lei exigir, provas de localização, registros guardados por 10 anos e declarações no prazo. As fontes oficiais devem ser conferidas de novo, com data, antes da abertura. Não é parecer de advogado ou contador.

## Texto do dono, segunda resposta (literal)

> Envio de produto físico para a UE e o Reino Unido desde o primeiro dia, e só abro as vendas quando isso estiver pronto e testado. IVA da UE (art. 14a): remessas importadas de até 150 euros, IVA cobrado por fora do preço no checkout e recolhido pela Solrenning LLC pelo IOSS, com intermediário de importação; bens que já estão na UE vendidos por criador não estabelecido na UE, IVA recolhido pela Solrenning LLC pelo Union OSS; remessas acima de 150 euros, o comprador é avisado antes de pagar dos impostos e taxas de importação. Reino Unido: remessas de até 135 libras e bens já no Reino Unido de vendedor estrangeiro, IVA recolhido pela Solrenning LLC pelo HMRC; acima de 135 libras, o comprador é avisado antes de pagar dos impostos e taxas de importação. O imposto é recebido na própria cobrança, pela taxa da plataforma na conta de plataforma Stripe da Solrenning LLC, nunca da receita nem da comissão. Na devolução, o imposto volta junto e a declaração é corrigida. Também prontos antes da abertura: as obrigações de marketplace de segurança de produtos da UE (GPSR) e do Reino Unido, e a conferência do registro de embalagens do vendedor onde a lei exigir (como Alemanha e França). O custo do intermediário de importação e de cada obrigação entra nos custos fixos e na base mínima de clientes, com valor real e fonte; custo desconhecido reprova. Nada é contratado por agente: o dono contrata na abertura. Isto não muda nenhum preço, limite, comissão, trava ou flag.

## O que esta decisão substitui (Pedidos repetidos, passo 3 (b): a instrução mais recente prevalece no ponto em que diverge)

1. **Recusar consumidores deixa de ser o tratamento da abertura.** O tratamento "refuse-consumers" da UE e do Reino Unido continua no código como trava até a abertura. Isso inclui `consumerGate` nos checkouts, os rascunhos de `lib/deemed-supplier-drafts.ts` e os caminhos de `REFUSE_CONSUMERS_OPEN`, que precisam ser fechados mesmo assim, porque hoje deixam passar o consumidor sem imposto. Na abertura, o registro da UE e o do Reino Unido em `DEEMED_SUPPLIER_RECORDS` passam a ser "collect", cada um com o seu registro fiscal. O caminho de abertura C2-20261113-1320-ABRIR-1, na parte em que só recusa, fica como etapa intermediária.
2. **Taxa da plataforma (application fee).** As frases "Proibido: [...] cobrar taxa do Marktmorgen como application fee", repetidas na fila (por exemplo, em 753 [IR1] e nos itens SA), deixam de valer só para a parte do imposto (e dos custos de recebê-lo) que a Solrenning LLC deve como fornecedora presumida ou "marketplace facilitator". A parte do plano continua a comissão já publicada, hoje 0% (`COMMISSION_LIVE` false), sem mudança. Fora desses impostos, a proibição continua.
3. **Decisão de 29/09/2026 (nunca receber, guardar ou transferir dinheiro de terceiros).** Continua. O dono registra que o imposto recebido na própria cobrança é dívida da própria Solrenning LLC e não dinheiro guardado do criador antes da venda. O crédito pré-pago e a fatura posterior foram recusados justamente por esse motivo.
4. **Desenho antigo de `docs/eu-vat-article-9a.md`, "The margin consequence", ponto 1.** A fórmula "application fee = a parte do plano + o IVA + os custos de receber esse dinheiro" volta a valer, na conta de plataforma da Solrenning LLC. A nota de 13/11 daquele documento ("until another collection path is built, refuse-consumers is the only EU treatment that could be recorded") fica como histórico.
5. **Bens físicos (questão 27 e passo 8 do "next build" de `docs/eu-vat-article-9a.md`).** Recusar o envio para endereços na UE e no Reino Unido deixa de ser o tratamento da abertura. Ele continua só como trava até a abertura. O tratamento passa a ser o da segunda resposta acima.

Continuam sem mudança:

- a política TX (interpretação juridicamente correta, conferida em fonte oficial datada);
- a regra MR (lucro maior que zero por unidade com 100% dos direitos no pior mês, com as taxas de recebimento mais caras e as reservas);
- a regra LC;
- FX275 (custos fixos 100% do Marktmorgen);
- SR5 e 495 [SR6] (a escolha entre a rota CPF e a rota LLC continua com o dono; esta decisão supõe a LLC);
- VR, AX274 e todas as travas: `PLANS_ON_SALE`, `OPENING_REQUESTED`, `EU_VAT_COLLECT_REVIEWED`, `UK_VAT_COLLECT_REVIEWED`, tax gate, art. 9a, revisão comercial e `stripePlatformEligibilityReady`, todas false ou fechadas.

## Lacunas conhecidas no dia do registro (não são decisão; ficam para conferir)

1. **Stripe, taxa da plataforma em cobrança direta fora dos EUA.** `docs/eu-vat-official-sources-2026-11-13.md`, seção 6, registra como NÃO CONFERIDO se uma plataforma Connect dos EUA pode cobrar `application_fee_amount` em cobrança direta nas contas Standard de criadores do Reino Unido, do EEE e do Canadá. Isso é condição técnica deste desenho. É conferido só em fonte oficial datada. Nenhum agente contata a Stripe; perguntar é decisão do dono.
2. **Câmbio.** A taxa da plataforma chega em dólar, e o IVA é pago em euro ou libra. "Custos de receber esse IVA" incluem a conversão, a variação do câmbio entre a venda e a declaração (com teto) e as tarifas de transferência, cada um com fonte. Desconhecido reprova.
3. **Taxa do Stripe Tax.** Continua sem resposta a pergunta de 20/10/2026 (SR5). Se o cálculo usar o Stripe Tax, vale a leitura menos favorável de `lib/receiving-costs.ts`.
4. **Bens físicos.** Faltam ler, com data:
   - na UE: o art. 14a da Diretiva, o art. 5b do Regulamento 282/2011, o IOSS e o intermediário (custo real), o Union OSS, o GPSR (Regulamento (UE) 2023/988) para marketplaces e os registros de embalagens (por exemplo, LUCID na Alemanha e o identificador único na França);
   - no Reino Unido: as regras de online marketplace para remessas de até £135 e para bens já no país, e a segurança de produtos.

   O que não estiver conferido continua recusado.
5. **Venda ao vivo (chamadas e pacotes).** O tratamento do IVA de serviço com intervenção humana, prestado a consumidor da UE e do Reino Unido, não está gravado. Fica recusado até ser conferido e gravado, para nunca vender sem o imposto devido.
6. **Termos.** A frase "You are the seller", a frase vista pelo comprador (`whoAnswers`, nos sete idiomas), a política de privacidade e a guarda por 10 anos dos registros do art. 63c, inclusive depois que a loja fecha, mudam juntas. É mudança legal para o dono aprovar.
7. **Empresa.** A LLC ainda não existe. Antes da abertura vêm, nesta ordem:
   - o EIN;
   - a conta de plataforma Stripe da LLC;
   - o registro no OSS não União (Irlanda, escolha do dono: `OSS_IDENTIFICATION_CODES` em `lib/vat-registrations.ts`);
   - o IOSS, com o intermediário;
   - o Union OSS;
   - o VAT britânico;
   - o registro em cada estado americano, quando a lei exigir.

   Tudo isso é do dono; nenhum agente cria conta nem contrata.

## Conferência na documentação oficial da Stripe (19/11/2026, 21h45 Fortaleza, Claude 4)

O dono pediu essa conferência. As páginas foram lidas por inteiro em docs.stripe.com nesta data. Nenhuma delas mostra data de atualização.

| Ponto | Texto oficial lido | Consequência para o desenho |
| --- | --- | --- |
| Restrição de país na taxa da plataforma em cobrança direta | [Create direct charges](https://docs.stripe.com/connect/direct-charges): "In line with Brazilian regulatory and compliance requirements, platforms based outside of Brazil with Brazilian connected accounts can't collect application fees through Stripe." É a única restrição de país sobre a taxa da plataforma nessa página. | Não há proibição escrita para plataforma dos EUA com contas do Reino Unido, do EEE ou do Canadá. **Falta de proibição não é permissão confirmada.** A confirmação expressa continua pendente (pergunta à Stripe, abaixo). |
| Exigência de mesma região | [How charges work](https://docs.stripe.com/connect/charges): a regra "the platform and connected account must be in the same region unless using on_behalf_of" está escrita só para destination charges e separate charges and transfers. Para cobrança direta: "Funds always settle in the country of the connected account." [Cross-border payouts](https://docs.stripe.com/connect/cross-border-payouts) lista como fluxos só "Separate charges and transfers without on_behalf_of", "Top-ups and transfers" e "Destination charges without on_behalf_of". | A exigência de mesma região não está escrita para cobrança direta. |
| Limites da taxa | direct-charges: "The value of application_fee_amount must be positive and less than the amount of the charge"; "There are no additional Stripe fees on the application fee itself." | A parte do plano + o imposto + os custos sempre ficam abaixo do valor cobrado; a Stripe não cobra tarifa sobre a própria taxa. |
| Moeda | [Collect application fees](https://docs.stripe.com/connect/marketplace/tasks/app-fees): "The application_fee_amount is always computed in the same currency as the transaction"; "The application fee settles in the same currency as the connected account's settlement currency". [Currencies](https://docs.stripe.com/connect/currencies): a conversão pode ocorrer nas taxas da plataforma e "is subject to fees". [Fee payer behavior](https://docs.stripe.com/connect/direct-charges-fee-payer-behavior): quem paga a tarifa de conversão depende da configuração da conta. | O imposto chega na moeda de liquidação do criador (euro ou libra, por exemplo). Falta saber se uma plataforma dos EUA guarda saldo em euro ou libra ou se converte para dólar, e com que tarifa: custo desconhecido, que reprova até a resposta. |
| Reembolso | direct-charges: "Application fees aren't automatically refunded when issuing a refund"; com refund_application_fee, no reembolso parcial "a proportional amount of the application fee is refunded". [Create an application fee refund](https://docs.stripe.com/api/fee_refunds/create): parâmetro "amount", "how much of this fee to refund". | A plataforma devolve a parte exata do imposto pelo reembolso da taxa com "amount". Não se usa o reembolso proporcional, que devolveria também a parte do plano e dos custos. |
| Contestação | [Disputes on Connect](https://docs.stripe.com/connect/disputes): "Regardless of a dispute's outcome, Stripe doesn't automatically refund the application fee to the connected account." | Bate com a decisão do dono: na contestação perdida, a parte do imposto não volta ao criador. |

Ainda sem resposta oficial; perguntar à Stripe é decisão do dono, e nenhum agente envia nada:

1. Uma plataforma dos EUA (LLC de Delaware com sócio único residente no Brasil) pode conectar contas Standard (contrato completo, painel da Stripe) no Reino Unido, no EEE e no Canadá e cobrar `application_fee_amount` em cobranças diretas nelas?
2. Em que moeda a taxa fica no saldo da plataforma? A plataforma pode manter saldo e fazer saque em euro e libra? Qual é a tarifa de conversão?
3. Há restrição a usar a taxa da plataforma para receber o IVA ou o sales tax que a plataforma deve como fornecedora presumida ou "marketplace facilitator"? O Stripe Tax calcula o imposto da plataforma numa cobrança direta?
4. Continua sem resposta a pergunta de 20/10/2026 sobre quem paga a tarifa do Stripe Tax em cobranças diretas (SR5).
