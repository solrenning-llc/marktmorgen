# MR3 — Resultado atual e histórico dos preços preservados

## Estado atual — 04/11/2026

Item 466 [MR3], passo 10 da AV1. Conferência documental do main `4c9d37faa755eaa9a4b95f114552c4736dfef37a`. Estado: em andamento; o lucro integral permanece desconhecido e a base mínima integral não estabelecida. Os relatórios anteriores estão preservados na seção histórica abaixo; seus resultados e descrições do código não são o resultado atual.

### Critério atual e evidência necessária

A regra LC e a política TX de [AGENTS.md](../AGENTS.md) prevalecem: considerar cada cliente usando 100% dos recursos e limites, no pior mês, inclusive as janelas mensais do anual, com a interpretação jurídica correta e as fontes oficiais aplicáveis. A regra LC registra IRPF sobre o lucro anual e IOF sobre o valor efetivamente remetido ao Brasil, com imposto do comprador por fora do preço; este relatório não repete uma conferência jurídica nem transforma esse registro em prova do enquadramento real. Qualquer cálculo ao dono deve ser feito fora do piso tributário histórico, sem apresentar dimensionamento antigo como lucro atual.

O código já usa `GATE_READING_ID=most-correct` e `gateReading()=most-correct` em [lib/tax-gate.ts](../lib/tax-gate.ts). O seletor identifica a política, não é prova de enquadramento ou de custo fiscal zero. A revisão exige livros anuais completos e vinculados, operações de câmbio, taxas máximas e componentes aplicáveis no modelo real de [lib/reviewed-receiving.ts](../lib/reviewed-receiving.ts) e [lib/customer-tax-review.ts](../lib/customer-tax-review.ts). Sem essa evidência, o calculador retorna desconhecido; não se reaproveitam os números dos modelos históricos em `tests/historical-receiving-model.ts` como resultado atual.

O e-mail segue a regra LC: preço real da Amazon SES com as proteções do 309 [EM1], reserva Resend limitada à cota paga e excedente aguardando na fila Amazon. Prova de envio real e cobertura dessas proteções ainda precisam estar incorporadas e verificadas antes de usar o preço menor no cálculo. Este documento não antecipa o resultado dos PRs em andamento nem muda PER_EMAIL.

### Preços preservados e resultado atual

Fonte dos preços: [lib/plan.ts](../lib/plan.ts), em centavos. A tabela informa o preço contratado, não uma receita livre de taxas nem uma estimativa de lucro. “Desconhecido” não significa zero nem prejuízo calculado.

| Contrato | Preço preservado | Lucro integral no pior caso | Base mínima integral |
| --- | --- | --- | --- |
| creator_month | US$ 69,00 | Desconhecido | Não estabelecida |
| creator_year | US$ 690,00 | Desconhecido | Não estabelecida |
| pro_month | US$ 449,00 | Desconhecido | Não estabelecida |
| pro_year | US$ 4.490,00 | Desconhecido | Não estabelecida |
| scale_month | US$ 999,00 | Desconhecido | Não estabelecida |
| scale_year | US$ 9.990,00 | Desconhecido | Não estabelecida |

`creator` corresponde ao Store; `pro`, ao Studio; `scale`, ao Scale. O assistente continua US$ 69 por mês e 700 respostas; não existe contrato anual do assistente nesta análise. Seu resultado integral também é desconhecido sem a evidência própria. Legendas e demais complementos continuam sujeitos ao cálculo individual completo, sem subsídio da comissão, de outro cliente ou da Hazelsong.

A regra MR exige lucro individual positivo com a folga existente; 60% é a meta do relatório mensal real da empresa, não um piso de venda por cliente. Todos os custos fixos da LLC pertencem integralmente ao Marktmorgen (FX275). A ausência de custos, câmbio, retenção ou exposições financiadas completos impede afirmar uma base mínima finita; custo desconhecido nunca é zero e cota grátis não é teto pago.

### Estado conferido e lacunas

| Parte | Estado nesta conferência |
| --- | --- |
| Abertura e venda | `OPENING_REQUESTED=false`; `PLANS_ON_SALE=false` e `ASSISTANT_ON_SALE=false`. Nenhuma compra de plano habilitada. |
| Revisão comercial | `CURRENT_COMMERCIAL_MARGIN_REVIEW=null`. Um relatório documental ou teste sintético não preenche essa revisão. |
| Custos fixos | `CURRENT_LLC_FIXED_COST_CEILINGS` contém custos desconhecidos; não há base mínima integral comprovada. |
| Plataforma Stripe | `CURRENT_STRIPE_PLATFORM_ELIGIBILITY_REVIEW=null`; `stripePlatformEligibilityReady` permanece condição da abertura. Conta e elegibilidade reais não comprovadas. |
| Tratamento por jurisdição | `DEEMED_SUPPLIER_RECORDS=[]`; o seletor tributário sozinho não constrói cobrança nem recusa por jurisdição. |
| Consultas e hospedagem | `CONSULTATION_ANSWERS=[]`; nem consulta tributária nem hospedagem europeia são condições adicionais de `taxGateValid`. A configuração válida não dispensa as demais provas. |
| Relatório mensal da empresa | `CURRENT_COMMERCIAL_PROFIT_MIX_INPUT=null`. A calculadora não representa contabilidade reconciliada; ingestão, agendamento e apresentação automática vêm após a abertura, pela AV1. |

Verificado: preços preservados, seletor tributário atual, evidência explícita exigida pelo calculador real e estados acima. Não verificado: livros/fatos fiscais reais, fatura integral, cobertura e reservas completas, conta Stripe elegível, lucro integral, base mínima ou relatório mensal real entregue. Não há cálculo novo de lucro nesta atualização. A engenharia restante segue a fila; ausência de dados não autoriza preencher custos com zero.

Benefício: o dono deixa de receber uma leitura substituída como resultado atual ao decidir sobre abertura e rentabilidade. Conferência: o teste de MR3 compara os seis preços e o seletor com os módulos reais, recusa lucro sem evidência e exige a separação do histórico. O retorno esperado é evitar decisões de receita baseadas em números antigos; nenhuma receita ou economia realizada é afirmada.

Nenhuma trava foi alterada; preços, limites, comissão, flags, reservas e revisões permanecem. Sem nova operação, chave, retenção, conta, termo, pagamento ou contato externo. Custos de CI e desenvolvimento são desconhecidos, nunca zero. Acessibilidade: títulos e tabelas com cabeçalhos, sem interface alterada, 0 → 0 passos e decisões; sem teste humano ou certificação. Não é entrega funcional nem incrementa o contador 254.

## Histórico integral — relatórios anteriores a 04/11/2026

O conteúdo abaixo permanece integralmente como registro das respectivas datas. As expressões “vigente”, “atual” e “vinculante” dentro desse histórico descrevem o entendimento registrado à época e são substituídas pelo estado acima onde houver conflito.


## Atualização vigente — 30/10/2026, 23:25:10 Fortaleza

Item 466 [MR3], passo 10 da AV1. Foto documental do main `9a67c82fd512f86a4296a247ca987052db7c766a`. Nenhum preço, limite, comissão, tarifa, tributo, revisão ou controle de abertura muda. O relatório de 27/10 está preservado abaixo como histórico: suas afirmações de que SR2 ainda não estava incorporado e sobre consultas/hospedagem europeia não descrevem mais o código atual.

### Números do modelo, não lucro integral comprovado

Fonte: [alinhamento canônico gerado](margin-alignment-2026-10-18.md), conferido pela suíte completa de 39 verificações e Vercel do head `8945e58edf83304405c01490cd744af8514e5372`, antes da incorporação do PR 1362. Os preços vêm de `lib/plan.ts`.

A leitura vinculante continua com VAT de 27% dentro do preço, imposto de 78,18% sobre o lucro e ISS de 5% sobre a receita. Recebimento, remessa e reservas do modelo único permanecem. O anual inclui 12 janelas mensais, sem multiplicar a ocupação simultânea do armazenamento. Comissão, Hazelsong, cota gratuita ou outro cliente não subsidiam o resultado.

| Contrato | Preço preservado | Líquido registrado antes da folga | Folga existente | Retenção conservadora depois da folga |
| --- | --- | --- | --- | --- |
| Store mensal | US$ 69 | US$ 6,57 | US$ 0,25 | US$ 6,32 |
| Store anual | US$ 690 | US$ 66,39 | US$ 1,00 | US$ 65,39 |
| Studio mensal | US$ 449 | US$ 42,92 | US$ 0,25 | US$ 42,67 |
| Studio anual | US$ 4.490 | US$ 424,97 | US$ 1,00 | US$ 423,97 |
| Scale mensal | US$ 999 | US$ 95,74 | US$ 0,25 | US$ 95,49 |
| Scale anual | US$ 9.990 | US$ 945,86 | US$ 1,00 | US$ 944,86 |
| Assistente mensal,700respostas | US$ 69 | US$ 6,59 | US$ 0,25 | US$ 6,34 |

A última coluna apenas subtrai a folga existente do líquido registrado, sem supor redução de impostos. É uma retenção conservadora, não outro cálculo fiscal. Corrige três diferenças de um centavo do relato de 27/10, antes da folga: Studio anual, 424,98 → 424,97; Scale mensal, 95,75 → 95,74; Scale anual, 945,87 → 945,86.

O assistente tem contrato mensal; não se inventa uma opção anual. Legendas continuam no alinhamento e no controle próprio: o exemplo de um idioma e seis minutos custa US$ 36 e tem líquido registrado de US$ 3,39, sem folga extra. Esse exemplo não aprova todas as configurações nem dispensa outros complementos.

**O lucro completo comprovado permanece desconhecido.** Números positivos no modelo registrado não incorporam automaticamente tarifas, configurações, retenção, custos fixos ou exposições ainda desconhecidos. Pela MR de 27/10, 60% é a meta líquida mensal real da empresa; lucro individual positivo com a folga existente não autoriza vender sem todas as outras condições.

### Base mínima: nenhuma quantidade comprovada

| Contrato ou composição | Base mínima integral comprovada |
| --- | --- |
| Store mensal | Não estabelecida |
| Store anual | Não estabelecida |
| Studio mensal | Não estabelecida |
| Studio anual | Não estabelecida |
| Scale mensal | Não estabelecida |
| Scale anual | Não estabelecida |
| Composição de contratos e assistente | Não estabelecida |

Todos os custos fixos da LLC pertencem ao Marktmorgen, conforme FX275. `CURRENT_LLC_FIXED_COST_CEILINGS` ainda não contém todas as provas e todos os tetos mensais e anuais. Contratos, exposições e reservas precisam estar integralmente financiados antes do gasto. A retenção de artefatos de implantação é explicitamente desconhecida, nunca zero.

SR3 também não comprova todos os custos e o aceite dos requisitos vinculantes da LLC/Stripe nos EUA. O cálculo matemático da base existe e tem testes sintéticos; sem custos completos e revistos, não há quantidade finita honesta a apresentar. Nenhuma quantidade de clientes corrige um cliente deficitário.

### Travas atuais e motivos

| Condição no código atual | Estado |
| --- | --- |
| Pedido de abertura, planos e assistente | `OPENING_REQUESTED`, `PLANS_ON_SALE` e `ASSISTANT_ON_SALE` permanecem false; nenhuma compra habilitada. |
| Revisão comercial | `CURRENT_COMMERCIAL_MARGIN_REVIEW=null`. Esta foto documental não preenche a revisão. |
| Plataforma Stripe nos EUA | `opening.ts` já exige `stripePlatformEligibilityReady`; `CURRENT_STRIPE_PLATFORM_ELIGIBILITY_REVIEW=null`. Conta, empresa, regiões de cobrança direta e provas datadas continuam obrigatórias. SR2 foi incorporado; a prova real não foi preenchida. |
| Regra fiscal | `taxGateValid` valida a política selecionada; `gateReading` mantém a leitura most-tax. Consultas e `EU_HOSTING_CONFIRMED` não são condições adicionais atuais dessa função. Isso não encerra dúvidas fiscais, autoriza uma leitura menor ou permite registrar tratamento sem prova. |
| Fornecedor considerado pela lei e jurisdições | `DEEMED_SUPPLIER_RECORDS=[]`; falta tratamento construído, testado e comprovado por jurisdição. IP, checkbox e cobrança direta não classificam esse tratamento por si mesmos. |
| Custos, base, custeio e exposição | Inventário real completo, revisões e financiamento ainda não aprovados. Desconhecido reprova; cota gratuita ou média entre clientes não substitui teto pago e reserva. |
| Relatório mensal 465 [MR2] | O critério foi incorporado e a calculadora pura existe; `CURRENT_COMMERCIAL_PROFIT_MIX_INPUT=null`. Ingestão, agendamento e apresentação automática continuam depois da abertura, pela AV1. O cron de estatísticas dos criadores não é contabilidade da empresa. |

### Dependências e continuação

O remanescente financeiro de 89 aguarda o dono, conforme PR 1371, após mais de uma hora sem prova completa de configuração, tarifas máximas, tetos e reservas. FX275 e a fonte contábil reconciliável também continuam dependentes. As guardas técnicas de 1351/1362 foram incorporadas, sem concluir 89. A engenharia autônoma restante segue a ordem autorizada; não exige nova autorização.

Verificado nesta atualização: linhas do alinhamento gerado, subtração inteira da folga, sete contratos solicitados, Scale anual na tabela da base e estado dos módulos de abertura, tributos, elegibilidade e contabilidade. Não verificado: tarifas reais completas, prova legal/contábil, conta Stripe elegível, base mínima integral ou relatório mensal real entregue.

Não há operação, chave ou retenção nova de produto nos seis casos mensais/anuais. Nenhuma conta, termo, pagamento, mensagem ou submissão externa. CI, compilação, retenção e revisão pertencem integralmente à LLC; custos pagos desconhecidos não são zero. Títulos e tabelas, sem passos novos para o cliente e sem certificação de acessibilidade. Esta atualização documental não é entrega funcional e não incrementa o contador 254.

---

## Histórico integral — relatório de 27/10/2026

O texto abaixo é a foto original daquela data. Onde divergir do estado atual, vale a atualização acima. Seus valores e sua proveniência ficam preservados para auditoria.

### MR3 — Resultado dos preços atuais, 27/10/2026

Item466[MR3], pedido do dono27/10/2026 07h42 Fortaleza. Estado: relatório documental com números do modelo registrado; **não é aprovação de abertura ou certificação de lucro real**. MR2 teve o critério financeiro incorporado no PR1094, mas o relatório mensal automático real ainda está incompleto. Sua dependência de dados reconciliados não pode ser preenchida com testes sintéticos.

## Preços preservados e pior leitura registrada

Fonte numérica: [alinhamento regenerado](margin-alignment-2026-10-18.md), código de15ceac3351087bbd9a0937193e4202ad7e7df5a4, verify122233986996:8/8 testes de alinhamento, incluindo igualdade do documento com o gerador. A suíte completa do novohead3fcbac teve31/31checks eVercel aprovados antes da incorporação.

Leitura vinculante: VAT27%dentro do preço, imposto sobre lucro78,18% eISS5%sobre receita; recebimento mais caro, remessa e reservas de reembolso/contestação do modelo único. Uso integral dos direitos registrados; anual inclui12janelas mensais completas. Nenhuma comissão subsidia o resultado. Isso não prova cobertura de fornecedor ainda desconhecida ou custos reais da LLC.

A última coluna é uma retenção **conservadora**: lucro em centavos mostrado pelo gerador menos a folga de custo já existente, sem reduzir os impostos mostrados. Não é novo imposto, preço ou limite. Não supõe benefício fiscal dessa folga.

| Contrato atual | Preço | Lucro líquido registrado antes da folga | Folga reservada | Lucro conservador depois da folga |
| --- | --- | --- | --- | --- |
| Store mensal | US$69 | US$6,57 | US$0,25 | US$6,32 |
| Store anual | US$690 | US$66,39 | US$1,00 | US$65,39 |
| Studio mensal | US$449 | US$42,92 | US$0,25 | US$42,67 |
| Studio anual | US$4.490 | US$424,98 | US$1,00 | US$423,98 |
| Scale mensal | US$999 | US$95,75 | US$0,25 | US$95,50 |
| Scale anual | US$9.990 | US$945,87 | US$1,00 | US$944,87 |
| Assistente da loja, mensal,700respostas | US$69 | US$6,59 | US$0,25 | US$6,34 |

O assistente tem contrato mensal nesta análise; não se inventa preço ou intervalo anual para ele. Seu custo próprio não é subsidiado pelo plano. Legendas e outros complementos não foram dispensados: suas linhas continuam no alinhamento gerado e sujeitos ao critério positivo, limites próprios, custeio e demaisgates.

**Os números são positivos no modelo registrado. O lucro líquido completo comprovado continua desconhecido enquanto custos, cobertura e revisões estiverem ausentes.** Não extrapolar esta tabela para uma garantia de margem real.

## Base mínima da empresa

| Contrato usado para financiar a base | Base mínima comprovada |
| --- | --- |
| Store mensal | Não estabelecida |
| Store anual | Não estabelecida |
| Studio mensal | Não estabelecida |
| Studio anual | Não estabelecida |
| Scale mensal | Não estabelecida |
| Composição de contratos e assistente | Não estabelecida |

Motivo: inventário integral FX275, câmbio máximo, apropriação/reserva de obrigações anuais e exposições financiadas ainda não têm revisão completa. [SR3](stripe-us-requirements-cost-evidence.md) também não comprovou teto e aceite deITIN/agente quando aplicável, representante residenteUS e endereço comercial real. Não substituir incógnitas por zero, preço inicial anunciado, cota grátis ou contribuição da Hazelsong.

O cálculo da base está implementado e testado com dados sintéticos completos, inclusive anual e composição mais fraca. Sem entradas reais/revistas, não há numerador completo; portanto não há número finito honesto para apresentar. Nenhuma quantidade de clientes conserta um cliente com lucro nulo ou prejuízo.

## Travas que continuam fechadas

| Condição | Estado e motivo |
| --- | --- |
| Pedido de abertura e venda | OPENING_REQUESTED=false ePLANS_ON_SALE=false; nenhum plano ou assistente pode ser comprado |
| Revisão comercial | Ausente; tabela positiva não preenche revisões nem prova cobertura integral |
| Custos fixos/base/exposições | Revisões completas ausentes; teste grátis, reembolso, inadimplência e retenção não são dispensados |
| Custeio e operações | Direitos, reservas, contratos e políticas continuam exigindo teto anterior a cada gasto; nenhuma cobertura desconhecida foi aprovada |
| Tax gate | Sem redução de leitura; EU_HOSTING_CONFIRMED=false e dúvidas continuam sujeitas à prova oficial/consulta registrada |
| Art.9a e demais jurisdições | Tratamentos completos ainda não registrados; cobrança direta no criador não elimina responsabilidade tributária |
| Plataforma StripeUS | Conta/empresa e elegibilidadeUS/CA/UK/Europa não comprovadas; SR2 no PR1095 tem9testes próprios aprovados, porém a falha móvel ainda impede incorporar a condição nova |
| Relatório mensal real | Calculador existe, mas dataset reconciliado, ingestão, agendamento e apresentação automática ainda não estão operacionais |

SR2 é requisito vigente do dono mesmo antes de sua condição técnica ser incorporada; não declarar que já está em lib/opening.ts no main desta revisão.

## Dependência dos dados reais e verificação

A ausência do dataset reconciliado já estava explícita no código testado do relatório às13:14:04UTC de27/10. Mais de uma hora depois, a consulta de faturamento Vercel do último mêsUTC completo, setembro2026, não permitiu reconciliação: o intervalo completo excedeu o limite4MiB do conector; a janela menor01/09inclusive–08/09exclusive retornou404costs_not_found. Isso não prova custo zero nem mês inteiro sem cobranças. Nenhum total parcial foi publicado.

Dependência externa de MR2: **aguardando o dono para disponibilizar fonte contábil completa e reconciliável**, sem dados pessoais no relatório. Não se pede criar conta, contratar, pagar ou contatar terceiros. A engenharia restante do relatório permanece em andamento; registrar esta dependência não a declara concluída. Enquanto isso, este MR3 informa os números condicionais e as travas, sem aguardar autorização repetida.

Verificado: código/gerador/testes remotos deMR2; preços e folgas preservados; aritmética conservadora da tabela. Não verificado: custo real integral, enquadramento tributário pessoal, conta Stripe/elegibilidade, dados reais e relatório automático entregue ao dono. Testes sintéticos não servem de fatura ou prova de aceite.

Nenhum preço proposto/aplicado, limite visível cortado, comissão ou trava afrouxada. Nenhuma conta, termo, contrato, pagamento ou mensagem. Sem nova operação produtiva, chave ou retenção; pesquisa/CI continuam custo fixo integral do Marktmorgen, nunca presumido grátis. Acessibilidade: títulos e tabelas,0→0passos/decisões de cliente, sem teste humano ou certificação. Documento não é publicação funcional; contador254.
