# TX4 — Evidência condicional do OSS não União

Conferência: **04/11/2026**, horário de Fortaleza. Item 474 [TX4], ligado a 275 [FX1]. Estado: evidência documental em revisão; nenhum cadastro, declaração ou cálculo fiscal foi implementado por este documento.

A conferência não comprova o enquadramento da LLC, a identidade do fornecedor de cada operação, o local da prestação, a condição tributária do comprador ou uma inscrição efetiva. É preciso separar a assinatura do Marktmorgen das vendas de cada criador; este recorte não decide o art. 9a, a inversão do sujeito passivo nem o tratamento de uma operação concreta.

## Fontes oficiais e limites da leitura

| Fonte | Data e conteúdo efetivamente conferidos | Limite |
| --- | --- | --- |
| Comissão Europeia, [Register to OSS](https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/register-oss_en) | Lida em 04/11/2026: regime não União para prestador sem sede nem estabelecimento fixo na UE; escolha de um Estado de identificação; separação dos regimes. | Orientação oficial; não autentica os fatos da LLC nem escolhe um Estado para ela. |
| Comissão Europeia, [Declare and pay in OSS](https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/declare-and-pay-oss_en) | Lida em 04/11/2026: período, declarações sem movimento, prazo, pagamento e referência da declaração. | Não fornece orçamento completo de conformidade ou tarifa de uma conta. |
| Irish Revenue, [Non-Union scheme](https://www.revenue.ie/en/vat/vat-ecommerce/non-union-scheme/index.aspx) | Página publicada em **19 de junho de 2026**, lida em 04/11/2026: regime opcional e inclusão das prestações abrangidas após a inscrição. | Exemplo de autoridade de um Estado; não é decisão de registrar a LLC na Irlanda. |
| Irish Revenue, [Tax and Duty Manual — Non-Union Scheme](https://www.revenue.ie/en/tax-professionals/tdm/value-added-tax/part10-special-schemes/vat-ecommerce-rules/non-union-scheme-one-stop-shop-oss.pdf) | PDF, última revisão em **junho de 2025**, lido em 04/11/2026: seções 2, 4, 4.2 e 4.3, sobre escopo, declarações, registros e câmbio. | O manual se apresenta como orientação, não como resposta jurídica definitiva para todos os casos. |

EUR-Lex: a abertura direta da [consolidação de 01/01/2024 da Diretiva 2006/112/CE](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A02006L0112-20240101) retornou uma barreira anti-bot. A busca oficial indexada expôs os arts. 364–369, mas não foi possível conferir integralmente, nessa rota, o texto consolidado atual. Não se registra leitura integral nem atualização legislativa completa. As conclusões limitadas abaixo se apoiam nas orientações oficiais efetivamente abertas; essa lacuna normativa permanece explícita.

## Quando o mecanismo pode ser pertinente

O OSS não União é um mecanismo declaratório para serviços B2C cujo local de tributação esteja na UE, prestados por sujeito passivo sem sede nem estabelecimento fixo nela. O mecanismo é opcional; isso não dispensa o IVA que seja devido. Uma vez escolhido e efetivo, devem entrar nele todas as prestações de serviços abrangidas, inclusive no Estado de identificação. Outras operações podem exigir obrigações diferentes.

Não se confundem OSS não União, Union OSS e IOSS: bens físicos, importação de mercadorias e serviços não recebem automaticamente o mesmo tratamento. Um número de IVA, um checkout com cobrança direta ou a residência do sócio não comprovam sozinhos qual regime se aplica. A evidência não demonstra cobrança de IVA implementada, identificação validada do comprador ou ausência de outras obrigações locais.

## Trabalho recorrente confirmado, se inscrito nesse regime

A declaração eletrônica corresponde ao **trimestre civil**, inclusive quando não houver operações: nesse caso há declaração **sem movimento**. Declaração e pagamento do IVA devido vencem no fim do mês seguinte ao período. O prazo não é prorrogado porque a data cai em **fim de semana** ou feriado.

| Período | Prazo informado pela Comissão |
| --- | --- |
| Janeiro a março | 30 de abril |
| Abril a junho | 31 de julho |
| Julho a setembro | 31 de outubro |
| Outubro a dezembro | 31 de janeiro do ano seguinte |

A preparação requer reconciliação por Estado de consumo e alíquota, incluindo base e imposto devido. A referência individual da declaração acompanha seu pagamento; guardar o comprovante não substitui conferir a efetiva recepção. Nenhuma declaração ou pagamento foi preparado ou enviado aqui.

Os registros das operações abrangidas devem permitir a conferência fiscal e ser disponibilizados eletronicamente quando exigidos. O manual da Revenue indica **dez anos contados do fim do ano** em que ocorreu a operação. Para valores em outra moeda, ele indica a taxa publicada pelo **Banco Central Europeu** no **último dia** do trimestre; sem publicação nesse dia, usa-se a próxima publicação. Isso não é uma cotação atual nem o custo de conversão/remessa da LLC.

## Custo e financiamento ainda desconhecidos

A linha existente **vat-oss-and-local-compliance**, em lib/llc-fixed-costs.ts, conserva teto mensal **desconhecido**, teto anual **desconhecido** e reserva não revisada. Uma fonte pública sobre obrigações não é orçamento, contrato, custo integral ou prova de que qualquer componente custa zero.

Inferências para dimensionamento, a confirmar antes de qualquer operação:

- Preparação e revisão das declarações trimestrais, incluindo períodos sem movimento, reconciliação e correções.
- Ferramentas, autenticação, traduções ou apoio profissional que o caminho efetivo exigir; nenhuma contratação é presumida obrigatória nem dispensada sem prova.
- Transferência do imposto, tarifas bancárias, câmbio, tributos aplicáveis e cronograma de caixa; o IVA a repassar não é receita disponível do Marktmorgen.
- Armazenamento, integridade, recuperação e exportação dos registros durante o prazo aplicável, inclusive **após o encerramento**. Cópias, restauração e acesso fiscal também precisam de custeio e fundamento próprios.

Não há preço completo verificado, teto de câmbio, política de apropriação mensal ou reserva que financie todo esse trabalho. O custo pertence **100% ao Marktmorgen** (FX275); não se divide com Hazelsong, não se desconta uma suposta gratuidade e não se calcula base mínima finita com essa lacuna. Este documento não altera a retenção no código, não certifica que os dados atuais bastem para dez anos e não cria armazenamento produtivo.

## Depende do dono

Confirmar os fatos reais da empresa e das operações, o Estado de identificação apropriado se esse caminho for aplicável, o acesso efetivo, os custos completos e o orçamento/reserva necessários. Isso é uma lista de evidências pendentes, não autorização para agir: **nenhum cadastro, submissão, pagamento ou contato** foi feito ou preparado. Não há escolha de fornecedor ou aceite de termos.

O 474 [TX4] continua parcial. Preços, limites, comissões, sinalizadores, travas, CURRENT_COMMERCIAL_TERMS e registros fiscais reais permanecem intactos. Sem nova interface: 0 → 0 ações e decisões; sem teste humano ou certificação de acessibilidade. CI e pesquisa têm custo não aferido, nunca presumido zero. Não se declara abertura, publicação funcional, lucro ou conformidade fiscal da LLC.
