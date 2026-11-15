# Trava 3 — Marktmorgen como fornecedor para fins de imposto: opções por jurisdição

Preparado em 14/11/2026 pelo Claude 1 cloud A, só como documento, para o dono decidir. **Não liga nada**: `DEEMED_SUPPLIER_RECORDS` continua vazio, `deemedSupplierReady()` continua `false`, e `PLANS_ON_SALE`, `OPENING_REQUESTED`, o tax gate, o art. 9a, a revisão comercial, os preços, os limites e a comissão ficam como estão. Nenhum agente se registra em nenhum regime, cria conta, aceita termos, paga ou contata autoridade fiscal.

## 0. Estado das fontes (leia antes das tabelas)

A rede desta sessão recusou, em 14/11/2026, todos os sites oficiais tentados: os departamentos de receita dos estados americanos, a CRA (Canadá), a ATO (Austrália), o IRD (Nova Zelândia), a Skatteetaten (Noruega), a ESTV (Suíça) e o Stripe. Por isso:

- **Nenhuma linha das tabelas dos EUA (seção 4) nem de "other" (seção 5) foi conferida hoje em fonte oficial.** Os valores são o conhecimento do agente até junho de 2026 e estão marcados **"a conferir na fonte oficial (URL), data de leitura pendente"**. Não são prova. Não podem entrar em `lib/` antes da conferência, nem em `lib/us-sales-tax-nexus.ts`, cujos valores continuam `null`.
- As linhas da UE e do Reino Unido remetem a fontes **já lidas em 13/11/2026** por outra sessão, com a data de cada uma (seção 3).
- **Atualização de 15/11/2026.** Depois de o dono liberar domínios no ambiente, foram lidas as páginas da OFAC (seção 6) e as do Stripe ([stripe-platform.md](stripe-platform.md)). A página da CRA sobre economia digital (www.canada.ca) devolveu resposta vazia em duas tentativas em 15/11/2026, então o Canadá continua a conferir. Os sites dos estados americanos e dos outros países não foram liberados.
- A seção 8 lista as URLs a ler. O coordenador lê essas páginas, publica os trechos com data no PR, e então este documento é completado e os valores errados são corrigidos.

Pela política TX (AGENTS.md), vale a interpretação juridicamente correta conferida na fonte, não a que dá mais imposto. Custo desconhecido reprova e nunca vale zero. Todo custo fixo de cadastro e de declaração pertence 100% ao Marktmorgen (FX275).

## 1. O que o código exige (lido em `lib/deemed-supplier.ts`, main `3e71d00a`, 14/11/2026)

`deemedSupplierReady()` só fica verdadeira com **exatamente um registro por jurisdição**: `EU`, `UK`, `US` e `other`. Cada registro (`DeemedSupplierRecord`) tem:

| Campo | Exigência |
| --- | --- |
| `jurisdiction` | `"EU"`, `"UK"`, `"US"` ou `"other"` |
| `treatment` | `"collect"`: o imposto é cobrado por fora do preço do comprador ou descontado do repasse ao criador, nunca da comissão. `"refuse-consumers"`: os consumidores daquela jurisdição não podem comprar. |
| `implementedIn` | Os arquivos que implementam o tratamento, que precisa estar **construído e testado** |
| `recordedOn` | Dia real `AAAA-MM-DD` |
| `registration` | **Obrigatório quando `collect`**: onde a LLC está registrada, a data e o número (na UE, o Estado-membro de identificação do OSS não União) |
| `evidence` | Como foi testado e onde se lê o teste |

Hoje nada disso está construído. A regra pura de recusa por país do comprador existe no PR [solrenning-llc/marktmorgen#3681](https://github.com/solrenning-llc/marktmorgen/pull/3681), aberto, ramo `claude1/abertura-jurisdiction-refusal`, ainda não ligada a nenhum checkout. O contador de vendas por estado existe no ramo `claude2/tx-us-sales-tax-nexus` (`lib/us-sales-tax-nexus.ts`, sem PR em 14/11/2026), com todos os números `null`.

## 2. A meta do dono e o que ela pede (14/11/2026, 16h Fortaleza, recebida pelo coordenador)

> No 1º dia de vendas, vender para EUA, Canadá, UE, Reino Unido e qualquer país que os EUA não proíbam. Exclua só os países sancionados pelos EUA, segundo a lista oficial da OFAC. Nos EUA, vender para TODOS os 50 estados e DC no dia 1, sem excluir nenhum.

Consequências para esta trava:

1. **`refuse-consumers` deixa de servir como tratamento de jurisdição inteira** para `EU`, `UK`, `US` e `other`, porque recusaria compradores que o dono quer atender. Ele continua necessário **por país**, dentro de `other`, para os países sancionados (seção 6) e, enquanto o cadastro não existir, para os países sem limite (seção 5).
2. **`collect` em todas as jurisdições.** Isso exige, antes do 1º dia: o cadastro do OSS não União e o do IVA britânico prontos, porque não há limite para quem não é estabelecido; nos EUA e nos países com limite, o contador por estado e por país ligado, com o registro feito **antes** de cada limite (TX, pontos 9, 10, 11 e 17).
3. **Dependência escondida no Stripe.** Numa cobrança direta, o dinheiro cai na conta do criador. Para o Marktmorgen recolher o imposto que deve como fornecedor, precisa receber esse valor, e o desenho registrado (docs/eu-vat-article-9a.md, "The margin consequence", item 1) usa a taxa de aplicação (`application_fee_amount` = imposto + custos do dinheiro do imposto). A leitura de 13/11/2026 (seção 6.1 do documento do ramo `claude2/eu-vat-official-sources`) **não confirmou** que uma plataforma dos EUA possa cobrar taxa de aplicação em cobranças diretas de contas Standard no Canadá, no Reino Unido e no EEE. E o Stripe Tax **não calcula** o imposto da plataforma em cobrança direta (mesmo documento, seção 6.2). Logo, `collect` depende de mais uma prova escrita do Stripe, que entra na lista de [stripe-platform.md](stripe-platform.md), e de um cálculo de imposto feito pelo próprio código.

## 3. Visão por jurisdição (a tabela pedida)

| Jurisdição | Regra que faz o Marktmorgen ser o fornecedor | `collect`: com qual cadastro | `refuse-consumers` | Custo e prazo de cada opção | Recomendação |
| --- | --- | --- | --- | --- | --- |
| **EU** | Reg. de Execução 282/2011, art. 9a: o checkout do Marktmorgen autoriza a cobrança, a entrega e fixa os termos, então ele é o fornecedor presumido dos serviços eletrônicos vendidos a consumidores da UE (docs/eu-vat-article-9a.md; texto consolidado lido em 19/10/2026; releitura em 13/11/2026 no ramo `claude2/art9a-sources`). Bens físicos: Diretiva, art. 14a. | **OSS não União** num Estado-membro de identificação à escolha. O dono indicou a Irlanda (Revenue). IVA à taxa do país do consumidor desde a 1ª venda, sem limite. | Recusar consumidores da UE. Compradores empresariais com número de IVA válido no VIES continuam podendo comprar, por inversão do sujeito passivo. | **Collect:** custo do registro NÃO CONFERIDO (nunca zero); vale desde a 1ª venda se o Estado for informado até o dia 10 do mês seguinte; declaração trimestral até o fim do mês seguinte; guarda dos registros por 10 anos (conferido em 13/11/2026, ramo `claude2/eu-vat-official-sources`, seção 2). Construção: provas do lugar, IVA por fora, registro do art. 63c, devolução no reembolso (docs/eu-vat-article-9a.md, "The code that would be needed"). **Refuse:** só a regra de recusa (#3681) ligada ao checkout; perde as vendas da UE. | **Collect**, pela meta do dono. Registrar no OSS não União antes do 1º dia. Recusar **bens físicos** para endereços da UE até o art. 14a ser construído. |
| **UK** | Texto britânico do art. 9a (lido em 13/11/2026; vigência depois da Retained EU Law Act 2023 NÃO CONFERIDA). Bens: VAT Act 1994, seção 5A (marketplace, remessas até £135). | **Registro no IVA britânico (HMRC)** como pessoa não estabelecida (NETP). Sem limite: "there is no registration threshold" (VAT Notice 741A, 2.6, lida em 13/11/2026). 20% por fora. | Recusar consumidores do Reino Unido. | **Collect:** custo do registro NÃO CONFERIDO; o HMRC pede contato se não houver resposta em **40 dias úteis** (Notice 700/1, 4.5, lida em 13/11/2026), então o pedido deve sair semanas antes do 1º dia; declaração em geral trimestral, prazo de 1 mês e 7 dias; o HMRC pode exigir representante fiscal ou garantia. **Refuse:** como na UE. | **Collect**, com o registro pedido o quanto antes, pelo prazo de 40 dias úteis. Até o número chegar, recusar consumidores britânicos (só a recusa já preparada em #3681). Recusar bens físicos para o Reino Unido até a regra de marketplace ser construída. |
| **US** | Leis estaduais de *marketplace facilitator* (MPF): o Marktmorgen recolhe o imposto das vendas dos criadores onde a lei do estado o enquadra e depois do limite daquele estado. Os limites somam as vendas próprias e as facilitadas de todos os criadores. Tabela por estado na seção 4. | **Permissão de sales tax em cada estado** que (a) tem MPF e (b) tributa o que é vendido, registrada **antes** do limite daquele estado. No 1º dia, abaixo de todos os limites, nenhum registro estadual é exigido. | Recusar consumidores dos EUA (contraria a meta do dono). | **Collect:** taxa de registro na maioria dos estados é gratuita ou baixa, mas **a conferir estado por estado**; prazo em geral de dias a poucas semanas (a conferir); declarações mensais, trimestrais ou anuais por estado; cálculo próprio de alíquota estadual e local (o Stripe Tax não serve para imposto da plataforma em cobrança direta). **Refuse:** recusa já preparada, perde o mercado. | **Collect com contador**: vender nos 50 estados e no DC desde o 1º dia, contando as vendas por estado (`lib/us-sales-tax-nexus.ts`) e cadastrando cada estado ao chegar ao aviso de aproximação, antes do limite. Atenção aos estados com limite de **200 transações**: com produtos baratos, chegam antes do limite em dólares. |
| **other** | Regras de plataforma de cada país: o Canadá (federal e províncias), a Austrália, a Nova Zelândia, a Noruega, a Suíça, Singapura, a Coreia do Sul, a Índia e outros (seção 5). | Cadastro em cada país com regra de plataforma, **antes da 1ª venda** onde não há limite e **antes do limite** onde há. | Recusar consumidores **por país**, com a regra de #3681. | Varia por país: vários exigem representante local, custo NÃO CONFERIDO, nunca zero (seção 5). | **Misto**: `collect` nos países com limite (vender e contar desde o 1º dia), cadastro antes do 1º dia nos países sem limite que o dono escolher, `refuse-consumers` nos outros países sem limite até o cadastro existir, e sempre nos sancionados (seção 6). Ver a decisão pendente da seção 7. |

**O que este documento não repete.** A sessão "IVA da UE e do Reino Unido" está no ramo `claude2/eu-vat-official-sources`, arquivo `docs/eu-vat-official-sources-2026-11-13.md` (13/11/2026, ainda sem PR): taxas por Estado-membro na TEDB, passo a passo do OSS não União, provas do lugar do consumidor, inversão do sujeito passivo e VIES, registro britânico e Stripe Tax. O ramo `claude2/art9a-sources`, arquivo `docs/art9a-sources-and-build-spec-2026-11-13.md`, traz a releitura do art. 9a e a especificação por caminho de compra. Para a UE e o Reino Unido, valem esses dois arquivos.

## 4. Estados Unidos: os 50 estados e o DC

**Tudo nesta tabela está a conferir na fonte oficial (URL do departamento de receita do estado na última coluna), data de leitura pendente.** Os valores são o conhecimento do agente até junho de 2026; limites e regras sobre produtos digitais mudaram várias vezes de 2023 a 2026 e podem ter mudado de novo.

Legenda:

- **MPF:** o estado tem lei de *marketplace facilitator*.
- **Digital:** o estado tributa produtos digitais (e-book, áudio, vídeo baixado ou por streaming), que é o que os criadores mais vendem. **SaaS:** tributa assinatura de software, que importa para os planos do próprio Marktmorgen (TX, ponto 10).
- **Limite:** vendas no estado que obrigam o registro, em geral no ano civil anterior ou no atual, contando as vendas próprias e as facilitadas.
- **Cadastro:** a permissão estadual de sales tax (ou de imposto equivalente) pedida antes do limite.

Mesmo onde o produto digital não é tributado, a MPF cobre os **bens físicos** vendidos pelas lojas, e alguns estados exigem registro ao passar do limite mesmo com vendas isentas.

| Estado | MPF | Digital / SaaS | Limite | Cadastro ao atingir | Tratamento recomendado | Fonte oficial a ler |
| --- | --- | --- | --- | --- | --- | --- |
| Alabama | Sim | Tributa / tributa | US$ 250 mil, ano anterior | Simplified Sellers Use Tax (SSUT) ou permissão de sales tax | Contar; cadastrar antes do limite | https://www.revenue.alabama.gov |
| Alasca | Sem imposto estadual; imposto local pelo código da ARSSTC, com MPF | Varia por cidade | US$ 100 mil (o teste de 200 transações teria saído em 2025) | Registro na ARSSTC | Contar; cadastrar na ARSSTC antes do limite | https://arsstc.org |
| Arizona | Sim | Parcial (TPT) / parcial | US$ 100 mil, ano atual ou anterior | Licença de TPT | Contar; cadastrar antes do limite | https://azdor.gov |
| Arkansas | Sim | Tributa / isento | US$ 100 mil **ou 200 transações** | Permissão de sales tax | Contar; atenção às 200 transações | https://www.dfa.arkansas.gov |
| Califórnia | Sim | **Isento** (só bens) / isento | US$ 500 mil de bens | Permissão de seller (CDTFA) | Vender; contar só os bens físicos; cadastrar se os bens se aproximarem do limite | https://www.cdtfa.ca.gov |
| Colorado | Sim | Tributa / isento no estadual; cidades com regra própria | US$ 100 mil | Licença de sales tax | Contar; cadastrar antes do limite | https://tax.colorado.gov |
| Connecticut | Sim | Tributa / tributa (1%) | US$ 100 mil **e** 200 transações (período até 30/09) | Permissão de sales tax (com taxa de registro, a conferir) | Contar; cadastrar antes do limite | https://portal.ct.gov/drs |
| Delaware | Sem sales tax | — | — | Sem cadastro de sales tax; conferir se o *gross receipts tax* alcança a LLC sem atividade em Delaware | Vender sem cobrar | https://revenue.delaware.gov |
| Distrito de Colúmbia | Sim | Tributa / tributa | US$ 100 mil **ou 200 transações** | Registro de sales tax (OTR) | Contar; atenção às 200 transações | https://otr.cfo.dc.gov |
| Flórida | Sim | **Isento** / isento | US$ 100 mil de vendas tributáveis, ano anterior | Registro de sales tax | Vender; contar os bens físicos | https://floridarevenue.com |
| Geórgia | Sim | **Isento** / isento | US$ 100 mil **ou 200 transações** | Registro de sales tax | Vender; contar os bens físicos | https://dor.georgia.gov |
| Havaí | Sim (GET) | Tributa / tributa (o GET alcança quase tudo) | US$ 100 mil **ou 200 transações** | Licença de GET | Contar; atenção às 200 transações | https://tax.hawaii.gov |
| Idaho | Sim | Parcial (download permanente tributa; streaming não) / isento | US$ 100 mil | Permissão de seller | Contar; cadastrar antes do limite | https://tax.idaho.gov |
| Illinois | Sim | Parcial / parcial (Chicago tributa streaming e SaaS com imposto próprio) | US$ 100 mil (o teste de 200 transações teria saído em 2026) | Registro no IDOR (e em Chicago, se aplicável) | Contar; conferir Chicago | https://tax.illinois.gov |
| Indiana | Sim | Tributa / isento | US$ 100 mil (o teste de 200 transações saiu em 2024) | Registro de sales tax | Contar; cadastrar antes do limite | https://www.in.gov/dor |
| Iowa | Sim | Tributa / tributa (com exceções para empresas) | US$ 100 mil | Permissão de sales tax | Contar; cadastrar antes do limite | https://revenue.iowa.gov |
| Kansas | Sim | Parcial / parcial | US$ 100 mil, ano civil | Registro de sales tax | Contar; cadastrar antes do limite | https://www.ksrevenue.gov |
| Kentucky | Sim | Tributa / tributa (desde 2023) | US$ 100 mil **ou 200 transações** | Permissão de sales tax | Contar; atenção às 200 transações | https://revenue.ky.gov |
| Luisiana | Sim | Tributa (desde 2025) / a conferir | US$ 100 mil | Registro na comissão de vendedores remotos | Contar; cadastrar antes do limite | https://revenue.louisiana.gov |
| Maine | Sim | Tributa / isento | US$ 100 mil | Registro de sales tax | Contar; cadastrar antes do limite | https://www.maine.gov/revenue |
| Maryland | Sim | Tributa / tributa | US$ 100 mil **ou 200 transações** | Licença de sales tax | Contar; atenção às 200 transações | https://www.marylandtaxes.gov |
| Massachusetts | Sim | Parcial (software tributa; e-book e música não) / tributa | US$ 100 mil | Registro de sales tax | Contar; cadastrar antes do limite | https://www.mass.gov/orgs/massachusetts-department-of-revenue |
| Michigan | Sim | **Isento** / isento | US$ 100 mil **ou 200 transações** | Licença de sales tax | Vender; contar os bens físicos | https://www.michigan.gov/taxes |
| Minnesota | Sim | Tributa / isento | US$ 100 mil **ou 200 transações** | Permissão de sales tax | Contar; atenção às 200 transações | https://www.revenue.state.mn.us |
| Mississippi | Sim | Tributa / tributa | US$ 250 mil | Permissão de sales tax | Contar; cadastrar antes do limite | https://www.dor.ms.gov |
| Missouri | Sim (desde 2023) | **Isento** / isento | US$ 100 mil | Registro de sales/use tax | Vender; contar os bens físicos | https://dor.mo.gov |
| Montana | Sem sales tax | — | — | — | Vender sem cobrar | https://mtrevenue.gov |
| Nebraska | Sim | Tributa / a conferir | US$ 100 mil **ou 200 transações** | Permissão de sales tax | Contar; atenção às 200 transações | https://revenue.nebraska.gov |
| Nevada | Sim | **Isento** / isento | US$ 100 mil **ou 200 transações** | Permissão de seller | Vender; contar os bens físicos | https://tax.nv.gov |
| New Hampshire | Sem sales tax | — | — | — | Vender sem cobrar | https://www.revenue.nh.gov |
| Nova Jersey | Sim | Tributa / isento | US$ 100 mil **ou 200 transações** | Registro de sales tax | Contar; atenção às 200 transações | https://www.nj.gov/treasury/taxation |
| Novo México | Sim (GRT) | Tributa / tributa (o GRT alcança serviços) | US$ 100 mil de receita tributável | Registro de GRT | Contar; cadastrar antes do limite | https://www.tax.newmexico.gov |
| Nova York | Sim | Parcial (e-book e música isentos; software tributa) / tributa | US$ 500 mil **e** 100 transações, quatro trimestres anteriores | Certificate of Authority | Contar; cadastrar antes do limite | https://www.tax.ny.gov |
| Carolina do Norte | Sim | Tributa / isento | US$ 100 mil (o teste de 200 transações saiu em 2024) | Registro de sales tax | Contar; cadastrar antes do limite | https://www.ncdor.gov |
| Dakota do Norte | Sim | A conferir / a conferir | US$ 100 mil | Permissão de sales tax | Contar; cadastrar antes do limite | https://www.tax.nd.gov |
| Ohio | Sim | Tributa / tributa só uso empresarial | US$ 100 mil **ou 200 transações** | Licença de vendor | Contar; atenção às 200 transações | https://tax.ohio.gov |
| Oklahoma | Sim | **Isento** / isento | US$ 100 mil | Permissão de sales tax | Vender; contar os bens físicos | https://oklahoma.gov/tax |
| Oregon | Sem sales tax | — | — | — | Vender sem cobrar | https://www.oregon.gov/dor |
| Pensilvânia | Sim | Tributa / tributa | US$ 100 mil | Licença de sales tax | Contar; cadastrar antes do limite | https://www.revenue.pa.gov |
| Rhode Island | Sim | Tributa / tributa | US$ 100 mil **ou 200 transações** | Permissão de sales tax | Contar; atenção às 200 transações | https://tax.ri.gov |
| Carolina do Sul | Sim | A conferir / a conferir | US$ 100 mil | Licença de retail | Contar; cadastrar antes do limite | https://dor.sc.gov |
| Dakota do Sul | Sim | Tributa / tributa | US$ 100 mil (o teste de 200 transações saiu em 2023) | Licença de sales tax | Contar; cadastrar antes do limite | https://dor.sd.gov |
| Tennessee | Sim | Tributa / tributa | US$ 100 mil, 12 meses | Registro de sales tax | Contar; cadastrar antes do limite | https://www.tn.gov/revenue |
| Texas | Sim | Tributa / tributa (80% do valor) | US$ 500 mil, 12 meses anteriores | Permissão de sales and use tax | Contar; cadastrar antes do limite | https://comptroller.texas.gov |
| Utah | Sim | Tributa / a conferir | US$ 100 mil (o teste de 200 transações teria saído em 2025) | Licença de sales tax | Contar; cadastrar antes do limite | https://tax.utah.gov |
| Vermont | Sim | Tributa / a conferir | US$ 100 mil **ou 200 transações** | Licença de sales tax | Contar; atenção às 200 transações | https://tax.vermont.gov |
| Virgínia | Sim | **Isento** / isento | US$ 100 mil **ou 200 transações** | Registro de sales tax | Vender; contar os bens físicos | https://www.tax.virginia.gov |
| Washington | Sim | Tributa / tributa (serviços digitais automatizados; ampliação de serviços tributados em 2025 a conferir) | US$ 100 mil | Business license com endosso de sales tax (com taxa, a conferir) | Contar; cadastrar antes do limite | https://dor.wa.gov |
| Virgínia Ocidental | Sim | A conferir / a conferir | US$ 100 mil **ou 200 transações** | Permissão de sales tax | Contar; atenção às 200 transações | https://tax.wv.gov |
| Wisconsin | Sim | Tributa / isento | US$ 100 mil | Permissão de seller | Contar; cadastrar antes do limite | https://www.revenue.wi.gov |
| Wyoming | Sim | A conferir / isento | US$ 100 mil (o teste de 200 transações saiu em 2024) | Licença de sales tax | Contar; cadastrar antes do limite | https://revenue.wyo.gov |

Contagem desta tabela (51 linhas, conferida linha a linha em 15/11/2026): 45 estados e o DC com sales tax estadual ou imposto equivalente (GET no Havaí, GRT no Novo México) e MPF; o Alasca, sem imposto estadual, com imposto local pelo código da ARSSTC e MPF, o que dá 46 estados e o DC onde há imposto a cobrar; 4 estados sem imposto geral sobre vendas (Delaware, Montana, New Hampshire e Oregon). Total: 50 estados e o DC.

**Custos do `collect` nos EUA, a conferir antes de qualquer número:**

- taxa de registro por estado;
- tempo de preparação de cada declaração (mensal, trimestral ou anual);
- fonte e manutenção das alíquotas estaduais e locais;
- câmbio e transferência do imposto recebido pela taxa de aplicação até o recolhimento.

Todos pertencem 100% ao Marktmorgen (FX275), entram na base mínima e **nunca valem zero**. O preço público do Stripe Tax (registrado em 13/11/2026: Basic 0,5% por transação ou 50¢ por chamada; Complete a partir de US$ 90 por mês, contrato de 1 ano) não serve de teto, porque ele não calcula imposto da plataforma em cobrança direta.

## 5. Jurisdição "other": países com regra que faz a plataforma digital ser a fornecedora

**Tudo nesta seção está a conferir na fonte oficial, data de leitura pendente.** Só entram países onde o agente conhece uma regra de plataforma, isto é, um *marketplace* ou plataforma eletrônica que passa a ser o fornecedor, ou o responsável, pelo imposto sobre consumo das vendas de terceiros a consumidores locais. Onde a lei alcança só o fornecedor estrangeiro, e não a plataforma, o criador é quem responde, e o Marktmorgen não; isso também precisa ser conferido país a país. A lista não é exaustiva: país fora dela não é país sem regra.

### 5.1 Canadá (obrigatório na meta do dono)

| Imposto | Regra de plataforma (a conferir) | Limite (a conferir) | Cadastro | Tratamento recomendado | Fonte oficial a ler |
| --- | --- | --- | --- | --- | --- |
| **GST/HST federal** | Desde 01/07/2021, o operador de plataforma de distribuição (*distribution platform operator*) é considerado o fornecedor dos produtos e serviços digitais vendidos por vendedores não residentes e não registrados a consumidores canadenses | CAD 30 mil em 12 meses de fornecimentos tributáveis a consumidores canadenses, contando os feitos pela plataforma | Registro simplificado de GST/HST (sem taxa, a conferir); declarações trimestrais ou anuais | Vender desde o 1º dia; contar; registrar antes de CAD 30 mil | https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/digital-economy-gst-hst.html |
| **QST (Quebec)** | Sistema de registro especificado da Revenu Québec; plataformas digitais são responsáveis pelas vendas de terceiros a consumidores de Quebec | CAD 30 mil em 12 meses a consumidores de Quebec | Registro especificado de QST | Vender; contar Quebec à parte; registrar antes do limite | https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/ |
| **BC PST (Colúmbia Britânica)** | Facilitador de marketplace online registra e cobra PST das vendas tributáveis feitas pela plataforma (software e serviços de telecomunicação; conferir e-book, cursos e streaming) | CAD 10 mil de receita na Colúmbia Britânica nos 12 meses anteriores | Registro de PST | Vender; contar a província à parte; registrar antes do limite | https://www2.gov.bc.ca/gov/content/taxes/sales-taxes/pst |
| **SK PST (Saskatchewan)** | Facilitador de marketplace online licenciado para cobrar PST das vendas pela plataforma (data e alcance a conferir) | A conferir (pode não haver limite para vendedor de fora da província) | Licença de vendor de PST | Se não houver limite: licença antes do 1º dia ou recusar consumidores de Saskatchewan até ela existir | https://www.saskatchewan.ca/business/taxes-licensing-and-reporting/provincial-taxes-policies-and-bulletins/provincial-sales-tax |
| **MB RST (Manitoba)** | Desde 01/12/2021, operador de marketplace online cobra RST das vendas de terceiros; streaming e serviços online tributados | CAD 10 mil em 12 meses (a conferir) | Registro de RST | Vender; contar a província à parte; registrar antes do limite | https://www.gov.mb.ca/finance/taxation/taxes/retail.html |
| Províncias com HST (Ontário, Nova Escócia, Nova Brunswick, Terra Nova e Labrador, Ilha do Príncipe Eduardo) | Cobertas pelo GST/HST federal | Mesmo limite federal | Mesmo registro federal | Como o federal | Mesma fonte federal |

Ponto a conferir: o código precisa saber a **província** do comprador, além do país, para aplicar QST, PST e RST. As duas provas de lugar de #3681 tratam só do país.

### 5.2 Outros países com regra de plataforma conhecida

| País | Regra de plataforma (a conferir) | Limite (a conferir) | Cadastro de não residente | Tratamento recomendado | Fonte oficial a ler |
| --- | --- | --- | --- | --- | --- |
| Austrália | Operador de plataforma de distribuição eletrônica é o fornecedor de serviços digitais de terceiros (GST, 10%) | AUD 75 mil de faturamento de GST em 12 meses | Registro simplificado de GST, sem representante | Vender; contar; registrar antes do limite | https://www.ato.gov.au/businesses-and-organisations/international-tax-for-business/gst-for-non-resident-businesses |
| Nova Zelândia | Operador de marketplace eletrônico é o fornecedor de serviços remotos de terceiros (GST, 15%) | NZD 60 mil em 12 meses | Registro simplificado | Vender; contar; registrar antes do limite | https://www.ird.govt.nz/gst/gst-for-overseas-businesses |
| Noruega | Intermediário de marketplace eletrônico é o fornecedor de serviços eletrônicos de terceiros (VOES) | NOK 50 mil em 12 meses | Registro simplificado VOES | Vender; contar; registrar antes do limite | https://www.skatteetaten.no/en/business-and-organisation/vat-and-duties/vat/foreign/e-commerce-voes/ |
| Suíça e Liechtenstein | Desde 01/01/2025, plataforma eletrônica é a fornecedora de **bens** vendidos por terceiros; para serviços eletrônicos, conferir se a regra também alcança a plataforma | CHF 100 mil de faturamento **mundial** (não só suíço) | Registro de IVA com **representante fiscal suíço obrigatório** (PR [solrenning-llc/marktmorgen#2445](https://github.com/solrenning-llc/marktmorgen/pull/2445) tem evidência condicional) | Se a regra alcançar serviços: o limite mundial chega cedo, então registrar antes do 1º dia ou recusar consumidores suíços até lá; bens físicos: recusar até ser construído | https://www.estv.admin.ch |
| Islândia | Fornecedor estrangeiro de serviços eletrônicos; regra de plataforma a conferir | ISK 2 milhões em 12 meses | Registro simplificado | Vender; contar; registrar antes do limite, se a regra alcançar a plataforma | https://www.skatturinn.is/english |
| Japão | Desde 01/04/2025, só a plataforma **designada** pela NTA (vendas de serviços digitais de estrangeiros acima de JPY 5 bilhões por ano) é a fornecedora | JPY 5 bilhões para a designação | Não se aplica abaixo da designação | Vender; o Marktmorgen fica muito abaixo; conferir a regra do fornecedor estrangeiro | https://www.nta.go.jp/english/taxes/consumption_tax/ |
| Singapura | Operador de marketplace eletrônico é o fornecedor de serviços remotos de terceiros (GST, 9%) | SGD 1 milhão mundial **e** SGD 100 mil a Singapura em 12 meses | Registro simplificado (*pay-only*) | Vender; contar; registrar antes do limite | https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/gst-and-digital-economy |
| Coreia do Sul | Plataforma (*open market*) é a responsável pelos serviços eletrônicos de estrangeiros vendidos por ela | **Sem limite** | Registro simplificado de empresa | Registrar antes do 1º dia ou recusar consumidores coreanos até lá (docs/tx4-korea-vat-evidence.md tem evidência anterior) | https://www.nts.go.kr/english/main.do |
| Índia | Operador de comércio eletrônico responde pelos serviços OIDAR de fornecedores no exterior vendidos por ele (IGST, 18%) | **Sem limite** | Registro simplificado de OIDAR (formulário próprio; conferir representante) | Recusar consumidores indianos até o registro (o Stripe só abre conta na Índia por convite; vendas a compradores indianos a conferir) | https://www.cbic.gov.in |
| Malásia | Operador de plataforma online é o fornecedor dos serviços digitais de terceiros (imposto sobre serviços, 8%) | MYR 500 mil em 12 meses | Registro de fornecedor estrangeiro de serviço digital | Vender; contar; registrar antes do limite | https://mysst.customs.gov.my |
| Tailândia | Plataforma eletrônica é a responsável pelo IVA de serviços eletrônicos de terceiros (7%) | THB 1,8 milhão por ano | Registro simplificado de *e-service* | Vender; contar; registrar antes do limite | https://www.rd.go.th |
| Filipinas | Desde 2025, operador de marketplace digital responde pelo IVA de serviços digitais de terceiros (12%) | PHP 3 milhões por ano | Registro de fornecedor não residente | Vender; contar; registrar antes do limite | https://www.bir.gov.ph |
| Indonésia | Plataforma estrangeira designada recolhe o IVA de produtos digitais (designação pelo DGT) | Designação por faturamento ou acessos (a conferir) | Designação pelo governo, não pedido | Vender; conferir os limites da designação | https://www.pajak.go.id |
| Vietnã | Plataforma estrangeira responde pelos serviços digitais de terceiros | **Sem limite** (a conferir) | Portal eletrônico para fornecedores estrangeiros | Registrar antes do 1º dia ou recusar até lá | https://www.gdt.gov.vn |
| Taiwan | Fornecedor estrangeiro de serviços eletrônicos; regra de plataforma a conferir | TWD 480 mil por ano | Registro simplificado | Vender; contar; conferir a regra de plataforma (docs/tx4-taiwan-vat-evidence.md tem evidência anterior) | https://www.etax.nat.gov.tw |
| Arábia Saudita | Interface eletrônica é considerada fornecedora de serviços eletrônicos de terceiros (IVA, 15%) | **Sem limite** para não residente | Registro de não residente (representante a conferir) | Registrar antes do 1º dia ou recusar até lá | https://zatca.gov.sa |
| Emirados Árabes Unidos | Fornecedor não residente de serviços eletrônicos; regra de plataforma a conferir (IVA, 5%) | **Sem limite** para não residente | Registro de não residente (representante a conferir) | Registrar antes do 1º dia ou recusar até lá | https://tax.gov.ae |
| Bahrein, Omã | Regras de plataforma para serviços eletrônicos a conferir | A conferir | A conferir | Recusar até conferir e registrar | https://www.nbr.gov.bh e https://tms.taxoman.gov.om |
| Turquia | Fornecedor estrangeiro de serviços eletrônicos (IVA, 20%); regra de plataforma a conferir | **Sem limite** | Registro simplificado (*special VAT*) | Registrar antes do 1º dia ou recusar até lá | https://www.gib.gov.tr |
| África do Sul | Intermediário de serviços eletrônicos pode ser o fornecedor (IVA, 15%) | ZAR 1 milhão em 12 meses | Registro de fornecedor de serviço eletrônico | Vender; contar; registrar antes do limite (PR [solrenning-llc/marktmorgen#2596](https://github.com/solrenning-llc/marktmorgen/pull/2596) tem evidência condicional) | https://www.sars.gov.za |
| Quênia | Operador de marketplace digital responde pelo IVA de serviços digitais (16%) | **Sem limite** (a conferir) | Registro simplificado | Registrar antes do 1º dia ou recusar até lá | https://www.kra.go.ke |
| Nigéria, Egito, Gana, Tanzânia, Uganda, Zâmbia, Zimbábue, Camarões, Marrocos | Regras sobre serviços digitais de não residentes, algumas com responsabilidade da plataforma, a conferir uma a uma | A conferir | A conferir | Recusar até conferir e registrar | Sites das autoridades fiscais de cada país |
| México | Plataforma intermediária retém IVA e imposto de renda dos vendedores; fornecedor estrangeiro de serviços digitais registra no RFC (IVA, 16%) | **Sem limite** | Registro no RFC, com obrigações mensais | Registrar antes do 1º dia ou recusar até lá | https://www.sat.gob.mx |
| Chile | Fornecedor estrangeiro de serviços digitais e plataforma de bens (IVA, 19%); regra de plataforma para serviços a conferir | **Sem limite** | Regime simplificado do SII | Registrar antes do 1º dia ou recusar até lá (docs/tx4-chile-vat-evidence.md tem evidência anterior) | https://www.sii.cl |
| Colômbia, Peru, Costa Rica, Equador, Uruguai, Paraguai | IVA sobre serviços digitais de não residentes, com responsabilidade da plataforma em alguns, a conferir um a um | A conferir (Colômbia tem limite em UVT) | A conferir | Recusar até conferir e registrar | Sites das autoridades fiscais de cada país |
| Argentina | O IVA de serviços digitais do exterior é retido pelo emissor do cartão, não pelo fornecedor | — | Sem cadastro do fornecedor (a conferir) | Vender; conferir se o Stripe aceita os cartões | https://www.afip.gob.ar |
| Brasil | LC 214/2025 (IBS/CBS) prevê responsabilidade de plataforma digital nas operações com fornecedor estrangeiro, com transição desde 2026 (a conferir, e relevante pela residência do dono) | A conferir | A conferir | Recusar consumidores brasileiros até conferir; a TX (ponto 2) já trata o tema | https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp214.htm |
| Ucrânia, Moldávia, Geórgia, Armênia, Azerbaijão, Cazaquistão, Uzbequistão, Sérvia, Albânia, Macedônia do Norte, Montenegro, Bósnia | IVA sobre serviços eletrônicos de não residentes, várias sem limite, regra de plataforma a conferir | A conferir | A conferir | Recusar até conferir e registrar | Sites das autoridades fiscais de cada país |
| Israel | Regra de plataforma para fornecedores estrangeiros a conferir (proposta antiga, vigência não conhecida) | A conferir | A conferir | Vender só depois de conferir; se houver regra sem limite, recusar até registrar | https://www.gov.il/en/departments/israel_tax_authority |

### 5.3 Como fica o registro "other" (rascunho para o dono decidir)

O código aceita **um único** registro `other` com **um único** tratamento. O que a meta do dono pede é uma mistura por país: contar e vender abaixo do limite, cadastrar onde não há limite, recusar os sancionados. Isso não cabe hoje no tipo `DeemedSupplierRecord` sem decisão (seção 7). Enquanto isso, o caminho seguro é o que não trava nada e não finge registro: **nenhum registro `other` é gravado** até o tratamento por país estar construído e testado.

## 6. Países sancionados pelos EUA (OFAC): recusar compradores

A meta do dono exclui só os países sancionados pelos EUA, pela lista oficial da OFAC.

**Fonte lida em 15/11/2026:** [OFAC, Sanctions Programs and Country Information](https://ofac.treasury.gov/sanctions-programs-and-country-information), sem data editorial na página, e a página de cada programa abaixo. A página geral diz: "The sanctions can be either comprehensive or selective". Ela lista 37 programas. Programas de país ou região: Afeganistão, Bálcãs, Belarus, Birmânia, Cuba, Hong Kong, Iraque, Irã, Líbano, Líbia, Mali, Nicarágua, Coreia do Norte, Rússia (dois programas), República Centro-Africana, República Democrática do Congo, Somália, Sudão do Sul, Sudão e Darfur, Ucrânia/Rússia, Venezuela, Iêmen, e o PAARSS, ligado a Assad. Os demais programas são temáticos (terrorismo, narcóticos, cibernético, Magnitsky e outros) e funcionam **por lista de pessoas**, não por país. **Não há mais programa "Syria Sanctions" na lista.**

O que as páginas dos programas **não** dizem, nas partes extraídas: se cada programa proíbe vender produtos digitais a consumidores comuns no país. Isso está nos regulamentos do 31 CFR que cada página lista, ainda **a conferir**.

| País ou região | O que a página da OFAC mostra (15/11/2026) | Tratamento recomendado |
| --- | --- | --- |
| Cuba | Página do programa cita o Cuban Assets Control Regulations e também "Cuba Sanctions Regulations". Ordem nova: "14404 - Imposing Sanctions on Those Responsible for Repression in Cuba and for Threats to United States National Security and Foreign Policy (May 01, 2026)", com determinação para setores da economia cubana "(Effective November 05, 2026)" | Recusar (embargo; texto do 31 CFR 515 a conferir) |
| Irã | Página do programa cita o Iranian Transactions and Sanctions Regulations, com determinação "Automotive and Rail Sectors of the Iranian Economy (Effective October 01, 2026)" | Recusar (31 CFR 560 a conferir) |
| Coreia do Norte | Página do programa cita o North Korea Sanctions Regulations | Recusar (31 CFR 510 a conferir) |
| Crimeia e as chamadas DNR e LNR (Ucrânia) | Página Ukraine-/Russia-related cita a EO 14065 ("Blocking Property Of Certain Persons And Prohibiting Certain Transactions With Respect To Continued Russian Efforts To Undermine The Sovereignty And Territorial Integrity Of Ukraine", 21/02/2022) e um aviso sobre a "Crimea Region of Ukraine" | Recusar compradores dessas regiões. Como o país do IP e o de cobrança dizem "Ucrânia", a recusa por região precisa de prova de lugar mais fina que a do #3681 (a conferir) |
| Síria | [PAARSS](https://ofac.treasury.gov/sanctions-programs-and-country-information/paarss): "CHANGES TO OFAC'S SYRIA SANCTIONS PROGRAM AS OF JUNE 30, 2025 and AUGUST 24, 2026 OFAC no longer maintains comprehensive sanctions on Syria or blocking sanctions on the Government of Syria." "Effective July 1, 2025, E.O. 14312 revoked the following six Executive Orders that formed the foundation of the Syria sanctions program". Restam sanções por lista sobre Assad, associados e outros | **Vender**, pela meta do dono, porque não há mais sanção ampla; triagem da lista SDN como em todo país |
| Rússia | Programas Russian Harmful Foreign Activities e Russia-related, com a EO 14024 e determinações da EO 14071 (por exemplo, "Prohibition on Petroleum Services", vigente desde 27/02/2025). Não é embargo amplo de país | Recomendação segura: recusar, até conferir se as determinações da EO 14071 alcançam o serviço vendido; o dono decide |
| Belarus | Página cita o Belarus Sanctions Regulations, por lista e setorial | Vender, com triagem; o dono decide se prefere recusar |
| Venezuela | Página cita o Venezuela Sanctions Regulations; licença geral "Venezuela General License 25 - Exportation of Certain Services, Software, Hardware, and Technology Incident to the Exchange of Communications over the Internet Authorized (August 05, 2019)" | Vender a consumidores, com triagem; recusar órgãos do governo da Venezuela (conferir no regulamento) |
| Demais programas de país (Afeganistão, Bálcãs, Birmânia, Hong Kong, Iraque, Líbano, Líbia, Mali, Nicarágua, República Centro-Africana, RD do Congo, Somália, Sudão do Sul, Sudão, Iêmen) | Sanções por lista ou setoriais, pelo título de cada programa; não foram abertas em 15/11/2026 | Vender, com triagem; abrir cada página antes da abertura |
| Pessoas listadas (lista SDN), em qualquer país | Listas da OFAC | O Stripe faz triagem; conferir o que a triagem do Stripe cobre e se o Marktmorgen precisa de triagem própria |

Isso usa a regra de recusa por país de #3681 (`refuse-consumers` por país, dentro de `other`) e as duas provas de lugar (país do IP e país de cobrança). A recusa é sempre antes de qualquer cobrança.

## 7. Decisões que dependem do dono

1. **Granularidade do registro `other`** (seção 5.3). Opções:
   - (a) manter um registro `other` único e só gravá-lo quando **todo** país de `other` estiver tratado (cadastro ou recusa), o que pode atrasar a abertura;
   - (b) pedir a um agente que mude o tipo, com revisão, para aceitar tratamento por país dentro de `other`, sem afrouxar a trava: país desconhecido continua recusado;
   - (c) gravar `other` como `refuse-consumers` no 1º dia e liberar país por país depois, o que contraria a meta de vender a todos os países não sancionados.

   O caminho seguro enquanto não houver decisão é (a), porque não trava nada que já não esteja travado.
2. **Registro com contador abaixo do limite.** Nos EUA, no Canadá e nos países com limite, o 1º dia não tem registro estadual ou nacional, porque as vendas ainda estão abaixo do limite. O tipo exige `registration` não vazio quando `collect`. Escrever ali um registro que não existe seria fingir. O dono precisa decidir se o texto "abaixo do limite, contador X ligado, registro antes do aviso" basta para `collect`, ou se o tipo deve ganhar um estado próprio. **Nenhum agente grava texto de registro inexistente.**
3. **Taxa de aplicação em cobrança direta** no Canadá, no Reino Unido e no EEE (seção 2, item 3): sem ela, `collect` não tem como receber o imposto. Prova escrita do Stripe depois de a conta da LLC existir.
4. **Países sem limite** (Coreia do Sul, Índia, Arábia Saudita, Emirados, Turquia, México, Chile, Quênia, Vietnã e outros): em quais o dono se registra antes do 1º dia (custo e representante local desconhecidos, nunca zero, 100% FX275) e quais ficam recusados até o registro.
5. **Rússia, Belarus e Venezuela** (seção 6): recusar ou vender, depois de conferir os regulamentos da OFAC. A Síria saiu da lista de sanções amplas (PAARSS, lido em 15/11/2026).
6. **Contas Standard para plataforma nova:** o Stripe marca Standard como tipo legado ([stripe-platform.md](stripe-platform.md), seção 3.1, releitura de 15/11/2026). Se a conta americana precisar de Accounts v2, os caminhos de cobrança de imposto desta trava mudam com ela.

## 8. URLs que precisam ser lidas (pedido ao coordenador, 14/11/2026)

Para cada uma: o trecho exato, a data editorial da página, se houver, e a data de leitura.

**EUA:** a página de *marketplace facilitator* ou de vendedor remoto de cada departamento de receita da tabela da seção 4 (última coluna), com a regra sobre produtos digitais e SaaS do mesmo estado; https://arsstc.org para o Alasca. Opcional, para os 24 estados do acordo: a matriz de tributação em https://www.streamlinedsalestax.org.

**Canadá:** as cinco URLs da seção 5.1.

**Outros países:** as URLs da última coluna da seção 5.2, começando pelos países sem limite (Coreia do Sul, Índia, Arábia Saudita, Emirados, Turquia, México, Chile, Quênia, Vietnã), porque decidem o 1º dia.

**OFAC:** páginas dos programas lidas em 15/11/2026 (seção 6). Faltam os textos dos regulamentos que dizem se a venda de produtos digitais a consumidores é proibida: 31 CFR partes 515 (Cuba), 560 (Irã), 510 (Coreia do Norte) e 589 (Ucrânia/Rússia), em https://www.ecfr.gov, mais as determinações da EO 14071 e a licença geral D-2 do Irã, se existir. Também falta a página de cada programa de país ainda não aberto.

**Canadá:** www.canada.ca devolveu resposta vazia em 15/11/2026, mesmo liberado; tentar de novo ou ler de outra sessão. Os sites de Quebec, da Colúmbia Britânica, de Saskatchewan e de Manitoba (revenuquebec.ca, gov.bc.ca, saskatchewan.ca, gov.mb.ca) não estão liberados.

**Stripe:** as URLs da seção 6 de [stripe-platform.md](stripe-platform.md), mais a regra de taxa de aplicação por país da conta conectada (https://docs.stripe.com/connect/direct-charges e https://docs.stripe.com/connect/platform-pricing-tools).

## Limites

Documento de preparação. Não registra, não decide rota, não grava `DEEMED_SUPPLIER_RECORDS`, não certifica imposto zero nem margem e não abre vendas. Os valores marcados "a conferir" não podem ser usados em código, cálculo ou texto ao cliente antes da conferência. Custos de cadastro, declaração, representante, câmbio, guarda de registros e cálculo de alíquota são desconhecidos, nunca zero, e pertencem 100% ao Marktmorgen (FX275). Acessibilidade: Markdown com títulos em ordem, tabelas com cabeçalho e links com texto próprio; nenhuma tela muda (0 → 0 passos e decisões); sem teste humano nem certificação. Estado VR: só documento; nada passa a funcionar para o cliente.
