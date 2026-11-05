# TX3a — Contagem de receitas aplicáveis por lugar

Unidade de 473[TX3], 31/10/2026. Produto: `lib/tax-sales-counter.ts`, ligado a `assessTaxSalesThreshold` em `lib/tax-threshold.ts`. É um cálculo puro sobre um snapshot fornecido, sem leitura/gravação, cron, fornecedor, envio ou cobrança.

## O que funciona

O contador soma inteiros em unidades menores da moeda, separando receitas liquidadas, reservas pendentes e propostas. Uma seleção nacional inclui seus estados; uma seleção estadual inclui apenas aquele estado. IDs repetidos, inclusive entre categorias ou lugares, reprovam o snapshot inteiro. Nenhum total é convertido em moeda local implicitamente.

O intervalo de datas é explícito e inclusivo. Uma liquidação fora dele não entra na soma; uma reserva ou proposta fora dele reprova, para não desaparecer silenciosamente da projeção. `supplyOn` é a data da prestação aplicável, não a data de criação da reserva. A cobertura declarada deve alcançar todo o intervalo, com `complete=true`. Campos próprios de dados são lidos uma vez, sem executar getters. Os mapas internos que recebem esses dados não têm protótipo: setters herdados também não podem interceptar a cópia de um campo válido, substituir sua classificação ou diminuir seu valor. Moeda, local, classificação ou valor desconhecido, falha de leitura e lista incompleta não viram zero.

Somente um snapshot completo vazio produz zero conhecido. Valores negativos, fracionários, coercíveis ou cuja soma ultrapasse o inteiro seguro reprovam. O limite interno de 100 mil entradas é um teto de processamento de evidência: uma lista maior é recusada integralmente antes de enumerar, nunca truncada ou tratada como total parcial. Não altera direito, quantidade de vendas ou limite visível de plano.

O adaptador calcula os totais antes de chamar o avaliador existente de Canadá/Noruega. Exige o país correto, escopo nacional (nunca um estado isolado), moeda correta, data final do dia da avaliação e confirmação explícita de cobertura móvel completa e escopo jurídico revisto. Canadá conserva o comparador estritamente maior; Noruega conserva maior ou igual. Reservas e proposta entram antes do limite. O avaliador antigo de totais permanece compatível.

## Fontes primárias conferidas em 31/10/2026

- [CRA, Cross-border digital products and services threshold amounts](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/digital-economy-gsthst/find-out-need-register/cross-border-threshold-amounts.html), página datada de 16/10/2025, seções de cálculo e exemplo 3: receitas aplicáveis acima de CAD 30 mil em qualquer período de 12 meses; o operador agrega prestações próprias e de fornecedores abrangidos facilitadas na plataforma. Inclui receitas razoavelmente esperadas. Não equivale a toda receita ou a apenas comissão.
- [Skatteetaten, Registration in the VOEC Register](https://www.skatteetaten.no/en/business-and-organisation/vat-and-duties/vat/foreign/e-commerce-voec/register/), seções de limite e serviços: registro até alcançar NOK 50 mil ou mais em 12 meses. Serviços remotamente prestáveis abrangem mais que os eletrônicos automatizados. Classificação, isenções e papel da plataforma continuam exigindo enquadramento próprio.

Não se copiou limiar canadense para estados americanos ou outros países. Não se decidiu nexo, obrigação de renda/franquia, alíquota, isenção ou fornecedor presumido.

## Limites de implementação

O código confere consistência estrutural e aritmética. Não autentica a origem do ledger, o local do comprador, o enquadramento da prestação, o número fiscal, a moeda/conversão anteriormente comprovada, o tratamento de devoluções ou a completude de uma fonte externa. As confirmações de revisão são dados fornecidos, não aprovação produzida pelo contador.

O chamador ainda deve estabelecer a janela de 12 meses e o fuso/data fiscal legalmente aplicáveis, todos os períodos relevantes, projeções de receitas, agregação de vendedores e obrigações já desencadeadas por um limite anterior. O contador não deriva uma janela jurídica de 365 dias nem apaga obrigações quando uma venda envelhece. Valores de estorno não podem ser inseridos negativos para reduzir silenciosamente o total: requerem tratamento jurídico e contábil próprio ainda não implementado.

Não existe contador persistente ou reserva atômica nova. Nenhum checkout chama este adaptador ainda. Não há registro fiscal, coleta, declaração, integração automática antes do limite nem tratamento completo por país/estado. Os registros reais de fornecedor presumido continuam vazios; as travas de abertura permanecem fechadas. Resultado abaixo do limiar é somente resultado aritmético condicionado, nunca permissão de vender ou certificação de TX3.

## Testes e custos

Somente sintéticos: países/estados distintos, agregação nacional, duas fronteiras inclusivas de data, reservas/propostas, lacunas, classificação desconhecida, duplicidade, moeda estrangeira, overflow, getters, herança, arrays incompletos e excessivos; integração com os comparadores canadense e norueguês e gates reais ainda fechados. A suíte hospedada completa e Vercel no head exato são necessários antes de incorporar.

Nenhuma operação produtiva, persistência, serviço, envio, pagamento ou chamada de fornecedor foi acrescentada. Não se declarou custo zero: pesquisa, CI e revisão pertencem integralmente ao FX275 do Marktmorgen, com custo pago desconhecido reprovado. Futuro armazenamento/IO/registro/retentativa/cobrança exige dimensionamento mensal e anual por plano, preço pago mais caro e teto/reserva anterior; nada disso foi autorizado por um resultado do contador.

Preços, direitos, limites visíveis, comissão, opt-ins, permissões, conteúdo, idiomas, IDs, Hazelsong, `PLANS_ON_SALE=false` e `OPENING_REQUESTED=false` preservados. Sem interface nova: ações/decisões 0→0; nenhuma certificação de acessibilidade ou jurídica. Contador funcional de entregas permanece254.
