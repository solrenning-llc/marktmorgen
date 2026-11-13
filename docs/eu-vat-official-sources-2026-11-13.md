# IVA UE/Reino Unido e Stripe: fontes oficiais datadas para a cobrança (13/11/2026)

Conferência feita em **13/11/2026** pelo Claude (subagente do Claude 2), a partir do ambiente de nuvem desta sessão. Documento de fontes para a equipe que vai construir a cobrança de IVA pelo art. 9a e pelo OSS não União (decisão do dono de vender a consumidores europeus desde o primeiro dia). **Não é parecer jurídico, não cria registro, não muda código, preço, limite, comissão, trava ou flag.** Aplica-se a política TX de [AGENTS.md](../AGENTS.md): nada vira fato sem fonte oficial conferida, com data.

**Legenda.** **CONFERIDO**: texto lido hoje, nesta sessão, na fonte oficial indicada, com o trecho resumido ou citado. **NÃO CONFERIDO**: não lido hoje; quando houver, indica-se a leitura anterior registrada no repositório (com data e agente) e a pista de busca, que **não** substituem a conferência. Uma pista de busca é só o endereço a abrir; o resumo gerado pela ferramenta de busca não foi usado como fonte.

## 0. Hosts bloqueados nesta sessão

A rede desta sessão só deixou ler `docs.stripe.com` e `stripe.com`. Todos os demais hosts oficiais foram recusados; nada abaixo foi inventado para preencher essas lacunas.

| Host | Resultado em 13/11/2026 |
| --- | --- |
| host bloqueado: taxation-customs.ec.europa.eu (TEDB, páginas do IVA) | WebFetch: nome não resolvido (fora da lista de rede); curl: proxy recusou o CONNECT (403). |
| host bloqueado: vat-one-stop-shop.ec.europa.eu (portal OSS) | curl: proxy recusou o CONNECT (403). |
| host bloqueado: ec.europa.eu (VIES) | curl: proxy recusou o CONNECT. |
| host bloqueado: europa.eu, commission.europa.eu, op.europa.eu, data.europa.eu | curl: proxy recusou o CONNECT. |
| host bloqueado: eur-lex.europa.eu | WebFetch: nome não resolvido. curl: conexão aceita, mas resposta HTTP 202 sem corpo (verificação anti-robô por JavaScript). **Não se tentou contornar a verificação.** O mesmo bloqueio já constava em [tx4-oss-evidence.md](tx4-oss-evidence.md) (04/11/2026) e em [tx-legal-source-review-2026-10-27.md](tx-legal-source-review-2026-10-27.md). |
| host bloqueado: www.gov.uk, www.legislation.gov.uk (HMRC) | WebFetch: nome não resolvido; curl: proxy recusou o CONNECT. |
| host bloqueado: autoridades nacionais (revenue.ie, bzst.de, skat.dk, mtca.gov.mt, impots.gouv.fr, agenziaentrate.gov.it, sede.agenciatributaria.gob.es, info.portaldasfinancas.gov.pt, bmf.gv.at, finances.belgium.be, skatteverket.se, emta.ee, vid.gov.lv, vmi.lt, podatki.gov.pl, financnasprava.sk, financnisprava.cz, nav.gov.hu, anaf.ro, nap.bg, porezna-uprava.hr, fu.gov.si, mof.gov.cy, aade.gr, impotsdirects.public.lu, vero.fi, belastingdienst.nl) | curl: proxy recusou o CONNECT. |

Para conferir os itens 1 a 5, alguém precisa ler essas fontes num ambiente que as alcance (o Claude 1 já leu EUR-Lex em 02/11/2026, ver [official-texts-eu-2026-11-02.md](official-texts-eu-2026-11-02.md)), ou o dono precisa liberar esses hosts na rede do ambiente.

## 1. Taxas de IVA por Estado-membro

**Estado: NÃO CONFERIDO** (TEDB e EUR-Lex bloqueados). Nenhuma alíquota foi preenchida de memória: a equipe não deve usar nenhuma taxa até a linha estar conferida na TEDB, com data.

Fonte a abrir: Comissão Europeia, base de dados TEDB, <https://taxation-customs.ec.europa.eu/tedb/> (pesquisa por país, categoria "electronically supplied services" e "e-books / electronic publications").

Regra que permite taxa reduzida em publicações eletrônicas: Diretiva 2006/112/CE, art. 98 (n.º 2, segundo parágrafo, que exclui os serviços eletrônicos das taxas reduzidas, salvo o anexo III, ponto 6) e anexo III, ponto 6, na redação da **Diretiva (UE) 2018/1713, de 6/11/2018** (pista: <https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32018L1713>), e alterações posteriores do art. 98 e do anexo III pela Diretiva (UE) 2022/542 (05/04/2022). **NÃO CONFERIDO** hoje: inteiro teor e consolidação atual não lidos. Pontos que a equipe precisa conferir no texto: (a) se a exclusão de publicações "inteira ou predominantemente" de música ou vídeo continua; (b) se áudio (audiolivro) entra no ponto 6; (c) se um **curso gravado** é "publicação" (anexo III, ponto 6) ou serviço eletrônico à taxa padrão. Até essa conferência, o curso gravado fica na taxa padrão.

| País | Código | Taxa padrão (serviço eletrônico) | Taxa reduzida para e-book/áudio, se houver | Curso gravado | Estado |
| --- | --- | --- | --- | --- | --- |
| Alemanha | DE | — | — | — | NÃO CONFERIDO |
| Áustria | AT | — | — | — | NÃO CONFERIDO |
| Bélgica | BE | — | — | — | NÃO CONFERIDO |
| Bulgária | BG | — | — | — | NÃO CONFERIDO |
| Chipre | CY | — | — | — | NÃO CONFERIDO |
| Croácia | HR | — | — | — | NÃO CONFERIDO |
| Dinamarca | DK | — | — | — | NÃO CONFERIDO |
| Eslováquia | SK | — | — | — | NÃO CONFERIDO |
| Eslovênia | SI | — | — | — | NÃO CONFERIDO |
| Espanha | ES | — | — | — | NÃO CONFERIDO |
| Estônia | EE | — | — | — | NÃO CONFERIDO |
| Finlândia | FI | — | — | — | NÃO CONFERIDO |
| França | FR | — | — | — | NÃO CONFERIDO |
| Grécia | EL (GR) | — | — | — | NÃO CONFERIDO |
| Hungria | HU | — | — | — | NÃO CONFERIDO |
| Irlanda | IE | — | — | — | NÃO CONFERIDO |
| Itália | IT | — | — | — | NÃO CONFERIDO |
| Letônia | LV | — | — | — | NÃO CONFERIDO |
| Lituânia | LT | — | — | — | NÃO CONFERIDO |
| Luxemburgo | LU | — | — | — | NÃO CONFERIDO |
| Malta | MT | — | — | — | NÃO CONFERIDO |
| Países Baixos | NL | — | — | — | NÃO CONFERIDO |
| Polônia | PL | — | — | — | NÃO CONFERIDO |
| Portugal | PT | — | — | — | NÃO CONFERIDO |
| República Tcheca | CZ | — | — | — | NÃO CONFERIDO |
| Romênia | RO | — | — | — | NÃO CONFERIDO |
| Suécia | SE | — | — | — | NÃO CONFERIDO |

Observações para a construção, sem valor de fonte tributária: o leitor de alíquotas do código não pode ter uma taxa digitada sem a linha desta tabela conferida; regiões com regra própria (por exemplo, territórios fora do território fiscal da UE, como Canárias, Açores/Madeira com taxas próprias, Monte Athos, Büsingen, Campione d'Italia) também precisam de conferência própria na TEDB e na Diretiva (arts. 6 e 7) antes de qualquer tratamento; e o Stripe Tax calcula com as taxas dele, o que não substitui esta tabela (seção 6).

## 2. Regime OSS não União

**Estado: NÃO CONFERIDO hoje** (portal OSS, EUR-Lex e autoridades nacionais bloqueados). Leitura anterior no repositório: [tx4-oss-evidence.md](tx4-oss-evidence.md), conferência de **04/11/2026** (páginas da Comissão "Register to OSS" e "Declare and pay in OSS"; Revenue da Irlanda, página de 19/06/2026 e manual TDM de junho de 2025). Essa leitura não foi repetida hoje e vale com a data dela.

| Ponto | Base legal a conferir | O que a leitura de 04/11/2026 registrou | Estado hoje |
| --- | --- | --- | --- |
| Quem pode usar | Diretiva, arts. 358a (definição de "sujeito passivo não estabelecido na Comunidade") e 359 | Prestador de serviços B2C sem sede nem estabelecimento fixo na UE. Regime opcional; uma vez escolhido, todas as prestações de serviços B2C abrangidas entram nele. | NÃO CONFERIDO |
| Onde registrar | Diretiva, arts. 358a, n.º 2, e 360 | Escolha de um Estado-membro de identificação, à escolha do prestador. | NÃO CONFERIDO |
| Custo de registro | Nenhuma fonte lida | Nenhuma fonte oficial lida afirma custo ou gratuidade. Custo desconhecido, não zero. | NÃO CONFERIDO |
| Prazo das declarações | Diretiva, arts. 364 e 367 | Trimestre civil; declaração e pagamento até o fim do mês seguinte (30/04, 31/07, 31/10, 31/01); declaração sem movimento obrigatória; sem prorrogação por fim de semana ou feriado. | NÃO CONFERIDO |
| Dados da declaração | Diretiva, art. 365; Regulamento 282/2011, art. 59a; Regulamento de Execução (UE) 2020/194 (conteúdo da declaração) | Por Estado-membro de consumo e por taxa: base tributável, taxa e IVA devido; referência da declaração no pagamento. | NÃO CONFERIDO |
| Câmbio para euro | Diretiva, art. 366 | Manual da Revenue: taxa do Banco Central Europeu do último dia do trimestre; sem publicação nesse dia, a próxima publicada. | NÃO CONFERIDO |
| Guarda por 10 anos | Diretiva, art. 369; Regulamento 282/2011, art. 63c | Manual da Revenue: 10 anos contados do fim do ano da operação; registros disponíveis eletronicamente quando pedidos. | NÃO CONFERIDO |
| Conteúdo do registro (art. 63c) | Regulamento 282/2011, art. 63c, n.º 1 | Não lido no inteiro teor. Lista a conferir: Estado-membro de consumo; tipo de serviço; data da prestação; base tributável e moeda; aumentos ou reduções posteriores; taxa aplicada; IVA devido e moeda; data e valor dos pagamentos recebidos; adiantamentos; dados da fatura, se emitida; informações usadas para determinar o local do cliente. | NÃO CONFERIDO |
| Representante fiscal | Diretiva, arts. 358a–369 | Documentação do Stripe (não oficial tributária), lida hoje: "You don't need to appoint a tax representative to use the OSS non-Union scheme" ([Stripe, EU](https://docs.stripe.com/tax/supported-countries/european-union)). | NÃO CONFERIDO (fonte oficial) |

Pista de busca (não lida): orientação da Comissão "Guide to the VAT One Stop Shop", <https://vat-one-stop-shop.ec.europa.eu/system/files/2021-07/OSS_guidelines_en.pdf> (março de 2021, já citada em [eu-vat-article-9a.md](eu-vat-article-9a.md)); páginas de autoridades como BZSt (Alemanha), Skat (Dinamarca), MTCA (Malta) e Revenue (Irlanda) sobre o "non-Union scheme".

## 3. Provas do lugar do consumidor

**Estado: NÃO CONFERIDO hoje** (EUR-Lex bloqueado). Leitura anterior: [eu-vat-article-9a.md](eu-vat-article-9a.md) registra, em 18/10/2026, leitura do Regulamento 282/2011 pela cópia do Reino Unido em legislation.gov.uk (texto como estava em 31/12/2020), não pela consolidação atual da EUR-Lex.

A conferir no texto consolidado atual do Regulamento de Execução (UE) 282/2011 (pista: <https://eur-lex.europa.eu/eli/reg_impl/2011/282/oj/eng>):

- **Art. 24a**: presunções de lugar para serviços prestados em locais físicos (cabine telefônica, ponto de Wi-Fi, cibercafé, restaurante, saguão de hotel; meios de transporte). **NÃO CONFERIDO.**
- **Art. 24b**: presunções por meio de prestação (linha fixa, rede móvel, decodificador) e, na alínea d), a regra geral para os demais casos, inclusive serviços eletrônicos pela internet: lugar identificado por **dois elementos de prova não contraditórios** do art. 24f; e a exceção, na redação do Regulamento de Execução (UE) 2017/2459, para o prestador cujo total de serviços de telecomunicações, radiodifusão e eletrônicos para fora do seu Estado não passa de **100 000 euros** no ano civil corrente e no anterior, que pode usar **um** elemento de prova emitido por pessoa independente. **NÃO CONFERIDO.** Atenção: o pressuposto desse limite (prestador estabelecido num único Estado-membro e as regras ligadas ao art. 58, n.º 2, da Diretiva) precisa ser conferido; até lá a construção usa **duas provas** desde a primeira venda.
- **Art. 24d**: refutação das presunções pelo prestador (até três elementos de prova não contraditórios) e pela autoridade fiscal. **NÃO CONFERIDO.**
- **Art. 24f**: lista exemplificativa de provas: endereço de cobrança; endereço IP do aparelho ou geolocalização; dados bancários (lugar da conta usada no pagamento e endereço de cobrança mantido pelo banco); código de país do SIM (MCC); lugar da linha fixa; outras informações comercialmente relevantes. **NÃO CONFERIDO.**

Comportamento do Stripe Tax, lido hoje (**CONFERIDO** como texto do Stripe, não como fonte tributária), [Stripe, EU](https://docs.stripe.com/tax/supported-countries/european-union): "For cross-border sales of digital services within the EU, Stripe Tax prioritizes a single address as the customer's location when calculating tax instead of comparing two pieces of non-conflicting evidence. However, we store and retain all location evidence used in the transaction on the Customer object." Consequência para a construção: **o Stripe Tax sozinho não aplica a regra de duas provas**; a conferência de duas provas não contraditórias e o registro delas por 10 anos precisam ser do código do Marktmorgen.

## 4. B2B: inversão do sujeito passivo e VIES

**Art. 196 da Diretiva e art. 44 (lugar B2B): NÃO CONFERIDO hoje** (EUR-Lex bloqueado). Leitura anterior em [tx-legal-source-review-2026-10-27.md](tx-legal-source-review-2026-10-27.md), complemento de 27/10/2026, 16h38: página da DG TAXUD "persons liable for VAT" (seção 1.2) sobre os arts. 44 e 196 (cliente sujeito passivo agindo nessa qualidade, ou pessoa jurídica não sujeito passivo identificada para IVA; prestador não estabelecido no país do cliente); "um número de IVA isolado não comprova todas as condições". A conferir também: Regulamento 282/2011, art. 18 (como o prestador verifica a condição de sujeito passivo do cliente, inclusive o número de IVA confirmado pelo VIES, e o que fazer quando o cliente ainda não tem número) e art. 18, n.º 2 (falta de número: presunção de não sujeito passivo).

**VIES, como consultar e indisponibilidade: NÃO CONFERIDO na fonte oficial** (host bloqueado: ec.europa.eu). Pista: <https://ec.europa.eu/taxation_customs/vies/> (consulta web e serviço de verificação).

Texto do Stripe, lido hoje (**CONFERIDO** como comportamento do Stripe):

- [Stripe, tax IDs em faturas](https://docs.stripe.com/tax/invoicing/tax-ids): "Stripe automatically validates all EU VAT numbers with the European Commission's VAT Information Exchange System (VIES). This process only verifies the validity of the tax ID, and not whether the customer's name and address match"; "VIES validation usually takes only a few seconds, but might take longer, depending on the availability of the external tax authority system. Stripe automatically handles VIES downtime and attempts retries for you." O mesmo vale para números do Reino Unido junto ao HMRC.
- [Stripe, tax IDs no Checkout](https://docs.stripe.com/tax/checkout/tax-ids): no Checkout só o formato é conferido na hora; a validação é assíncrona, com estados `pending`, `verified`, `unverified` e `unavailable`; "When automatic validation is `unavailable`, you must manually verify the tax ID"; e **"If you use Stripe Tax, Stripe Tax applies the reverse charge or zero rate according to applicable laws when the tax ID has the required number format, regardless of the government verification result."** Para clientes convidados (guest), não há resultado de verificação nem evento.
- [Stripe, EU](https://docs.stripe.com/tax/supported-countries/european-union): "Stripe assumes that all services sold to customers with a business tax ID are eligible for reverse charge" e não aplica a inversão doméstica.

Consequência para a construção: o Stripe Tax aplica a inversão **pelo formato do número, antes do VIES**. Pela política de desconhecido reprova, o código do Marktmorgen não pode aceitar a inversão sem `verified`; com `pending`, `unverified` ou `unavailable`, a regra do que fazer (cobrar o IVA de consumidor e corrigir depois, ou segurar a venda) depende do art. 18 do Regulamento e de orientação oficial ainda **NÃO CONFERIDOS**.

## 5. Reino Unido

**Estado: NÃO CONFERIDO hoje** (host bloqueado: www.gov.uk e www.legislation.gov.uk). Leituras anteriores no repositório, válidas com as datas delas:

| Ponto | Leitura anterior | Estado hoje |
| --- | --- | --- |
| Registro sem limite para não estabelecido | [HMRC, VAT Notice 741A](https://www.gov.uk/guidance/vat-place-of-supply-of-services-notice-741a), seção 2.6, atualizada em 29/09/2022, conferida em 27/10/2026 ([tx-legal-source-review-2026-10-27.md](tx-legal-source-review-2026-10-27.md), ponto 14): fornecedor não estabelecido com serviço tributável no Reino Unido e sem inversão deve registrar sem limite. | NÃO CONFERIDO |
| Taxa padrão | 20% é a leitura usada em [eu-vat-article-9a.md](eu-vat-article-9a.md) e em [tax-uncertainty.md](tax-uncertainty.md), questão 26; não há conferência datada da taxa no repositório. Pista: <https://www.gov.uk/vat-rates>. | NÃO CONFERIDO |
| Regra de plataforma (equivalente ao art. 9a) | Art. 9a na cópia britânica do Regulamento 282/2011, sem emenda do Reino Unido (legislation.gov.uk, lido em 18/10/2026). Pistas de busca de hoje, não lidas: [HMRC, VAT rules for supplies of digital services to consumers](https://www.gov.uk/guidance/the-vat-rules-if-you-supply-digital-services-to-private-consumers) e o manual interno [VATREG37210](https://www.gov.uk/hmrc-internal-manuals/vat-registration-manual/vatreg37210). | NÃO CONFERIDO |
| Prazo das declarações | [tx4-uk-vat-evidence.md](tx4-uk-vat-evidence.md), 04/11/2026: período normalmente trimestral; prazo eletrônico normalmente de um mês civil e sete dias após o fim do período; declaração mesmo sem imposto; Making Tax Digital quando aplicável. | NÃO CONFERIDO |
| Guarda dos registros | [tx4-uk-vat-evidence.md](tx4-uk-vat-evidence.md), 04/11/2026: pelo menos seis anos pela orientação geral (VAT Notice 700/21). | NÃO CONFERIDO |

## 6. Stripe: taxa de aplicação em cobrança direta e Stripe Tax

Todas as páginas abaixo foram lidas hoje, **13/11/2026**, na versão Markdown oficial (`.md`) de docs.stripe.com, e não mostram data editorial. São documentação pública do Stripe, não resposta individual à conta do dono nem aprovação de conta (SR5 continua valendo).

### 6.1 `application_fee_amount` em cobrança direta para contas Standard nos EUA, Canadá, Reino Unido e Europa

- **CONFERIDO, regra geral.** [Create direct charges](https://docs.stripe.com/connect/direct-charges?platform=web&ui=stripe-hosted): `payment_intent_data[application_fee_amount]` é "the amount your platform deducts from the transaction as an application fee"; deve ser positivo e menor que o valor da cobrança; "There are no additional Stripe fees on the application fee itself"; a moeda da taxa depende de fatores de [múltiplas moedas](https://docs.stripe.com/connect/currencies); a taxa não é reembolsada automaticamente (`refund_application_fee`).
- **CONFERIDO, única restrição por país encontrada:** "In line with Brazilian regulatory and compliance requirements, platforms based outside of Brazil with Brazilian connected accounts can't collect application fees through Stripe." Nenhuma outra restrição de país para a taxa em cobrança direta aparece nessa página.
- **CONFERIDO.** [Charge types](https://docs.stripe.com/connect/charges): na cobrança direta "Funds always settle in the country of the connected account"; as restrições de região de [cross-border payouts](https://docs.stripe.com/connect/cross-border-payouts) ("Platforms based in the US, UK, EEA, Canada, or Switzerland can transfer funds to connected accounts in any of those regions") se aplicam às cobranças de destino e às cobranças e transferências separadas, não à cobrança direta. Na mesma página: "Direct charges aren't recommended for legacy v1 Express and Custom accounts".
- **CONFERIDO.** [Platform pricing tool](https://docs.stripe.com/connect/platform-pricing-tools), requisitos: "Your platform is permitted to charge app fees in the connected account's country." Ou seja, o Stripe trata a permissão de cobrar taxa de aplicação **por país da conta conectada**, mas nenhuma página lida lista os países permitidos para uma plataforma dos EUA.
- **CONFERIDO.** [Using Standard connected accounts](https://docs.stripe.com/connect/standard-accounts): Standard é marcado como tipo v1 legado ("Deprecated feature"); para integração nova o Stripe indica Accounts v2.
- **Resposta à pergunta: NÃO CONFERIDO.** A documentação não diz, de forma afirmativa, que uma plataforma Connect dos EUA pode cobrar `application_fee_amount` em cobrança direta nas contas Standard de criadores no Canadá, no Reino Unido e no EEE. Ela só exclui o Brasil e condiciona a permissão ao país da conta. A confirmação depende de uma conta real ou de resposta escrita do Stripe. Lembrete: pelo desenho registrado em SR5 e em [stablecoin-payments-study.md](stablecoin-payments-study.md), as cobranças das lojas são diretas **sem** taxa de aplicação.

### 6.2 O Stripe Tax calcula o IVA nesse cenário?

- **CONFERIDO, plataforma responsável pelo imposto: não suportado na cobrança direta.** [Tax for marketplaces](https://docs.stripe.com/tax/tax-for-marketplaces), em Payment Links, Checkout e Subscriptions: "Direct charges — This charge type isn't supported for use cases involving a connected account where the platform is liable for tax." A página só oferece cobrança de destino e cobranças e transferências separadas com `automatic_tax[liability][type]=self`, e diz que o cálculo usa "your platform's head office location, preset tax code, and tax registrations".
- **CONFERIDO, conta conectada responsável: suportado.** [Tax for software platforms](https://docs.stripe.com/tax/tax-for-platforms): com cobrança direta, a chamada vai com o cabeçalho `Stripe-Account` e o imposto é do criador, pelas configurações e registros **do criador**; a configuração pelo painel só existe para contas com acesso ao painel, como Standard.
- **CONFERIDO.** [Standalone Tax APIs](https://docs.stripe.com/tax/standalone-tax-api): "Stripe only calculates tax in jurisdictions where you have an active tax registration. Without a registration in the customer's location, the calculation returns zero tax."
- **CONFERIDO.** [Use Stripe Tax with Connect](https://docs.stripe.com/tax/connect): o primeiro passo é determinar quem tem a obrigação; a distinção do Connect entre SaaS e marketplace "doesn't strictly correspond to the tax definition of marketplaces".
- **Consequência para a construção (inferência a validar, não fonte):** pelo art. 9a o responsável é o Marktmorgen, ou seja, a plataforma. O Stripe Tax **não calcula o IVA da plataforma em cobrança direta**. Com a responsabilidade do criador, ele calcularia pelo registro do criador, não pelo OSS não União do Marktmorgen. **NÃO CONFERIDO:** se o cálculo avulso (Tax Calculations API) feito na conta da plataforma, com o registro `oss_non_union` dela, pode ser aplicado a uma cobrança direta feita na conta do criador. A documentação lida não responde. Se não puder, restam o cálculo pelo código do Marktmorgen ou a mudança do tipo de cobrança, que é decisão do dono e esbarra em SR5.
- **CONFERIDO.** [Register for tax](https://docs.stripe.com/tax/registering): o tipo de registro `oss_non_union` existe ("for businesses that provide digital services across the European Union but aren't established within it"). [Stripe Tax pricing](https://stripe.com/tax/pricing), página servida hoje em dólares: "Stripe provides registration services in Canada (federal simplified), the EU (non-Union OSS), and the US", dentro do Tax Complete.

### 6.3 Quem paga a taxa do Stripe Tax

- **CONFERIDO.** [Fee behavior on connected accounts](https://docs.stripe.com/connect/direct-charges-fee-payer-behavior), tabela "List of fee behaviors for payer values": linha **Stripe Tax**: pagador `account` → **Connected Account**; `application`, `application_custom` e `application_express` → **Platform**. Na mesma página: "Accounts created with `type=standard` also have this value" (`account`), e "Any activity occurring at the platform account level is billed to your platform regardless of the entity responsible for fee collection".
- Leitura: numa cobrança direta numa conta Standard, a taxa do Stripe Tax cobrada **nessa conta** é do criador. Um cálculo feito **na conta da plataforma** (6.2) seria cobrado da plataforma. Isso responde, pela documentação pública, à pergunta pendente em SR5 (Stripe Tax em cobrança direta de conta Standard). Não é resposta individual do Stripe; a pergunta de 20/10/2026 continua sem resposta, e `lib/receiving-costs.ts` não muda por este documento.
- **CONFERIDO, preços na página de hoje** ([Stripe Tax pricing](https://stripe.com/tax/pricing)): Tax Basic "0.5% per transaction, where you're registered to collect taxes" (integração sem código) ou "50¢ per transaction" pela API, com "10 calculation API calls" incluídas e "5¢ per calculation API call above 10"; Tax Complete "Starting at $90 per month", com faixas de US$ 90, US$ 430, US$ 1.000 e US$ 1.500 por mês, "1-year contract". Preço público não é teto verificado do pior caso (FX275).

## 7. O que este documento não faz

Não registra a LLC em nenhum regime, não prepara declaração, não cria conta, não aceita termos e não contata o Stripe nem autoridade fiscal. Não altera `lib/deemed-supplier.ts`, `DEEMED_SUPPLIER_RECORDS`, `PLANS_ON_SALE`, `OPENING_REQUESTED`, o tax gate, o art. 9a, a revisão comercial, preços, limites, comissão ou `lib/receiving-costs.ts`. Custos desconhecidos (registro, declarações, guarda por 10 anos, câmbio, Stripe Tax) continuam desconhecidos, nunca zero, e pertencem 100% ao Marktmorgen (FX275). Sem interface nova: 0 → 0 passos e decisões; sem teste humano nem certificação de acessibilidade.
