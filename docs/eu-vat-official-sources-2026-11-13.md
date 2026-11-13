# IVA UE/Reino Unido e Stripe: fontes oficiais datadas para a cobrança (13/11/2026)

Conferência feita em **13/11/2026** pelo Claude (subagente do Claude 2), a partir do ambiente de nuvem desta sessão. Documento de fontes para a equipe que vai construir a cobrança de IVA pelo art. 9a e pelo OSS não União (decisão do dono de vender a consumidores europeus desde o primeiro dia). **Não é parecer jurídico, não cria registro, não muda código, preço, limite, comissão, trava ou flag.** Aplica-se a política TX de [AGENTS.md](../AGENTS.md): nada vira fato sem fonte oficial conferida, com data.

**Legenda.** **CONFERIDO**: texto lido hoje (13/11/2026), nesta sessão, na fonte oficial indicada, com o trecho resumido ou citado. **NÃO CONFERIDO**: não lido hoje; quando houver, indica-se a leitura anterior registrada no repositório (com data e agente) e a pista de busca, que **não** substituem a conferência. Uma pista de busca é só o endereço a abrir; o resumo gerado pela ferramenta de busca não foi usado como fonte.

## 0. Acesso às fontes nesta sessão

**Segunda e terceira conferências, 13/11/2026 (tarde e noite).** O Claude 2 liberou na rede da sessão taxation-customs.ec.europa.eu, ec.europa.eu e www.gov.uk. Os pontos 1, 3, 4 e 5 foram então lidos nessas fontes. Na terceira passada, com vat-one-stop-shop.ec.europa.eu e www.legislation.gov.uk também liberados, foram lidos o ponto 2 (OSS não União) e a base legal britânica do registro. A primeira passada da manhã, com tudo bloqueado, foi substituída por estas.

| Host | Resultado em 13/11/2026 |
| --- | --- |
| ec.europa.eu (TEDB e VIES) | **Acessível.** A TEDB foi lida pelo serviço oficial de consulta da própria Comissão (SOAP `VatRetrievalService`, endereço `https://ec.europa.eu/taxation_customs/tedb/ws/`, publicado no WSDL `https://ec.europa.eu/taxation_customs/tedb/ws/VatRetrievalService.wsdl`). Consulta: 27 Estados-membros, `situationOn` = 2026-11-13, sem filtro de categoria. A resposta (1 566 283 bytes, SHA-256 `d4303410636fd5e7398c2f52fea3a573a1d4576a00e7b3d9f977d00032936b0c`) foi guardada só no rascunho da sessão. O VIES foi lido pela API pública do próprio aplicativo (`/taxation_customs/vies/rest-api/`). |
| taxation-customs.ec.europa.eu | **Acessível**, com limite de pedidos (HTTP 429 em algumas tentativas, superado com espera). Algumas páginas antigas do OSS mudaram de endereço (HTTP 404). |
| www.gov.uk | **Acessível.** Lido pela API de conteúdo oficial do GOV.UK (`https://www.gov.uk/api/content/<caminho>`), que devolve o mesmo texto da página com as datas `public_updated_at`. |
| vat-one-stop-shop.ec.europa.eu (portal e guias do OSS) | Bloqueado nas duas primeiras passadas; **acessível** na terceira (noite de 13/11/2026), depois de liberado pelo Claude 2. |
| host bloqueado: eur-lex.europa.eu | HTTP 202 sem corpo (verificação anti-robô por JavaScript). Não se tentou contornar. |
| www.legislation.gov.uk | Bloqueado nas duas primeiras passadas; **acessível** na terceira. |
| host bloqueado: autoridades fiscais nacionais (revenue.ie, bzst.de e as demais testadas de manhã) | O proxy recusou o CONNECT. |

Consequência: o texto da Diretiva 2006/112/CE e do Regulamento 282/2011 **não foi lido** em EUR-Lex. Onde abaixo aparece uma regra desses atos como CONFERIDO, ela foi lida numa página oficial da Comissão ou do HMRC que a descreve, e isso está dito na linha. A página da Comissão não substitui o inteiro teor.

## 1. Taxas de IVA por Estado-membro

### 1.1 A regra que permite taxa reduzida para publicações eletrônicas

- **CONFERIDO, página da Comissão.** [Comissão Europeia, VAT rates](https://taxation-customs.ec.europa.eu/taxation/vat/vat-directive/vat-rates_en), lida em 13/11/2026, sem data editorial visível: a taxa padrão "must be no less than 15%, but there is no maximum (Art.97 VAT Directive)". Desde a reforma em vigor em abril de 2022 (Diretiva (UE) 2022/542), os Estados podem aplicar "up to two reduced rates as low as 5%" a até 24 categorias do anexo III (art. 98, n.º 1) e, para até sete categorias de necessidades básicas, uma taxa super-reduzida abaixo de 5% e uma isenção com direito à dedução, a "taxa zero" (art. 98, n.º 2). A mesma página diz: "the information contained in TEDB is provided by EU Member States themselves".
- **CONFERIDO, descrição oficial da categoria na TEDB.** A categoria `LOAN_LIBRARIES`, que reproduz o anexo III, ponto 6, diz: "Supply, including on loan by libraries, of books, newspapers and periodicals either on physical means of support or supplied electronically or both (including brochures, leaflets and similar printed matter, children's picture, drawing or colouring books, music printed or in manuscript form, maps and hydrographic or similar charts), other than publications wholly or predominantly devoted to advertising and other than publications wholly or predominantly consisting of video content or audible music."
- **NÃO CONFERIDO:** o inteiro teor do art. 98 e do anexo III na consolidação atual (EUR-Lex bloqueado), e a Diretiva (UE) 2018/1713, de 06/11/2018, que abriu o ponto 6 ao fornecimento eletrônico.

### 1.2 Tabela por país (TEDB, situação em 13/11/2026)

Como ler a tabela:

- **Taxa padrão:** linha `STANDARD` da TEDB para o território principal. É a que vale para o serviço prestado por via eletrônica sem regra própria.
- **Publicações:** taxa reduzida listada pelo país nas categorias `LOAN_LIBRARIES` (anexo III, ponto 6), `BOOKS`, `NEWSPAPERS` ou `PERIODICALS`.
- **Formato eletrônico:** se o comentário do próprio país na TEDB diz expressamente que a taxa vale para e-book ou publicação eletrônica. "Não diz" significa que a TEDB não esclarece. Não significa que não vale.
- **Data na TEDB:** campo `situationOn` devolvido pela TEDB, ou seja, a data da situação registrada que vale para 13/11/2026.

Link de cada linha: a TEDB, <https://ec.europa.eu/taxation_customs/tedb/>, pelo serviço citado na seção 0, lida em 13/11/2026.

| País | Taxa padrão | Publicações (taxa reduzida) | Formato eletrônico na TEDB | Data na TEDB | Estado |
| --- | --- | --- | --- | --- | --- |
| Alemanha (DE) | 19% | 7% em livros, jornais e periódicos ("Annex 2 of the German VAT Act"; "For legal certainty please have a look at the German VAT Act") | Não diz; o comentário cita "printed books" | 2026-07-01 | Padrão CONFERIDO; e-book NÃO CONFERIDO |
| Áustria (AT) | 20% | 10% em `LOAN_LIBRARIES`, jornais e periódicos | Não diz (sem comentário) | 2026-07-01 | Padrão CONFERIDO; e-book NÃO CONFERIDO |
| Bélgica (BE) | 21% | 6% em jornais, periódicos e livros "(digital and on paper)", exceto propaganda, vídeo e "listenable music"; 0% para certos jornais e periódicos | Sim | 2026-07-01 | CONFERIDO |
| Bulgária (BG) | 20% | 9% em livros e periódicos "on a physical medium or by electronic means, or both" | Sim | 2026-07-01 | CONFERIDO |
| Chipre (CY) | 19% | 3% em livros, jornais e periódicos com códigos tarifários 49.01–49.05 (bens físicos); audiolivros só para pessoas com deficiência (85.23) | Não | 2026-01-01 | Padrão CONFERIDO; e-book NÃO CONFERIDO |
| Croácia (HR) | 25% | 5% em livros de conteúdo profissional, científico, artístico, cultural ou educativo e livros didáticos; 5% ou 13% em jornais e periódicos | Não diz | 2026-07-01 | Padrão CONFERIDO; e-book NÃO CONFERIDO |
| Dinamarca (DK) | 25% | A TEDB não lista taxa reduzida para publicações | — | 2026-07-01 | Padrão CONFERIDO |
| Eslováquia (SK) | 23% | 5% em "printed books, brochures, leaflets" (anexo 7 da Lei 222/2004) | Não ("printed") | 2026-07-01 | Padrão CONFERIDO; e-book NÃO CONFERIDO |
| Eslovênia (SI) | 22% | 5%, que "Includes also: electronic provision of services via the Internet or an electronic network to access electronic books, periodicals" | Sim | 2026-07-01 | CONFERIDO |
| Espanha (ES) | 21% | A TEDB não traz linha de publicações; há uma linha super-reduzida de 4% sem descrição | — | 2026-07-01 | Padrão CONFERIDO; publicações NÃO CONFERIDO |
| Estônia (EE) | 24% | 9% em livros e literatura educativa "both on a physical medium and electronically"; 9% na imprensa, também eletrônica | Sim | 2026-07-01 | CONFERIDO |
| Finlândia (FI) | 25,5% | 13,5% em livros; 10% em jornais e periódicos; "Electronically supplied products are taxed with the reduced rate from the beginning of July 2019" | Sim | 2026-07-01 | CONFERIDO |
| França (FR) | 20% | 5,5% em livros (art. 278-0 bis A 3° do CGI); 2,1% em jornais e periódicos de interesse geral | Não diz | 2026-07-01 | Padrão CONFERIDO; e-book NÃO CONFERIDO |
| Grécia (EL) | 24% | 6% em livros (posições 4901 e 4903 e edições em suporte 8523/8543) e "On line publications of audiovisual books" | Parcial | 2026-01-01 | Padrão CONFERIDO; e-book NÃO CONFERIDO (alcance a conferir no texto nacional) |
| Hungria (HU) | 27% | 5% em livros "reproduced on any form of physical support or medium" e em periódicos; 0% em jornais diários | Ambíguo | 2026-07-01 | Padrão CONFERIDO; e-book NÃO CONFERIDO |
| Irlanda (IE) | 23% | Um comentário diz que a taxa zero vale para "e-books, audiobooks"; outro diz que 9% vale para "electronically supplied books" | **Divergência dentro da própria TEDB** | 2026-07-01 | Padrão CONFERIDO; e-book e audiolivro NÃO CONFERIDO |
| Itália (IT) | 22% | 4% em jornais, livros e periódicos | Não diz | 2026-07-01 | Padrão CONFERIDO; e-book NÃO CONFERIDO |
| Letônia (LV) | 21% | 5% em livros, jornais e periódicos impressos ou eletrônicos, inclusive online e por download, se publicados nos idiomas listados (letão, latgaliano ou livônio, línguas oficiais da UE, do EEE, da Suíça, dos candidatos à UE e da OCDE) | Sim, com condição de idioma | 2026-07-01 | CONFERIDO |
| Lituânia (LT) | 21% | 5% em livros impressos e eletrônicos; 5% em jornais e periódicos impressos ou eletrônicos | Sim | 2026-07-01 | CONFERIDO |
| Luxemburgo (LU) | 17% | 3% em `LOAN_LIBRARIES`, "Excluding materials with predominately adult content" | Não diz | 2026-07-01 | Padrão CONFERIDO; e-book NÃO CONFERIDO |
| Malta (MT) | 18% | 5%; "This reduced rate has been extended to also include e-books", e-newspapers e periódicos eletrônicos | Sim | 2026-07-01 | CONFERIDO |
| Países Baixos (NL) | 21% | 9% em "digital or physical supplies" de livros e de periódicos publicados pelo menos três vezes ao ano | Sim | 2026-07-01 | CONFERIDO |
| Polônia (PL) | 23% | 5% em "Books, music scores, maps supplied electronically"; 8% em jornais e periódicos fornecidos eletronicamente | Sim | 2026-07-01 | CONFERIDO |
| Portugal (PT) | 23% | 6% em livros, jornais e periódicos (23% se forem principalmente propaganda ou conteúdo obsceno) | Não diz | 2026-01-01 | Padrão CONFERIDO; e-book NÃO CONFERIDO |
| República Tcheca (CZ) | 21% | 0% em livros, "including audio recordings of their content", e "electronic versions (e-books, etc.)"; 12% em jornais e periódicos, também eletrônicos | Sim, inclusive áudio | 2026-07-01 | CONFERIDO |
| Romênia (RO) | 21% | 11% em livros, jornais e revistas "on physical means of support and/or supplied electronically" (art. 291, n.º 2, g, do Código Fiscal) | Sim | 2026-07-01 | CONFERIDO |
| Suécia (SE) | 25% | 6% em livros e jornais, "both supplies on physical means and electronic supplies" (cap. 9, §§ 9 e 13 da lei de IVA) | Sim | 2026-07-01 | CONFERIDO |

Regiões com taxa própria listadas pela TEDB, que **não** entram na tabela e exigem conferência própria antes de qualquer tratamento:

- Espanha: linha de 7% "VAT - Canary Islands". As Canárias ficam fora do território de IVA da UE pelo art. 6 da Diretiva, o que não foi conferido hoje.
- Portugal: Açores 16% e Madeira 22%.
- Áustria: Jungholz e Mittelberg, 19%.
- França: Córsega e departamentos ultramarinos, com taxas específicas.

Regras para a construção, válidas pela leitura acima:

1. **Curso gravado.** Nenhuma categoria da TEDB descreve curso gravado. Como a categoria de publicações (anexo III, ponto 6) cobre livros, jornais e periódicos, o curso gravado fica na **taxa padrão** em todos os países, até uma fonte oficial dizer o contrário.
2. **Áudio.** A TEDB só menciona áudio, de forma expressa, na República Tcheca (gravações de áudio do conteúdo do livro), na Irlanda (com a divergência acima), em Chipre (só para pessoas com deficiência) e na Grécia (edições em suporte material). Nos demais países, o audiolivro fica na **taxa padrão** até conferência.
3. **E-book.** A taxa reduzida só se aplica onde a tabela diz "CONFERIDO" na coluna Estado. Nas linhas "e-book NÃO CONFERIDO" fica a **taxa padrão** (a leitura que não subestima o imposto) até a lei nacional ser lida.
4. **Data.** A TEDB é atualizada pelos Estados e cada linha traz `situationOn`. O código precisa guardar a data da tabela que usou e não pode seguir com uma tabela vencida sem nova consulta.

## 2. Regime OSS não União

**Terceira conferência, 13/11/2026 (noite).** Com vat-one-stop-shop.ec.europa.eu liberado, foram lidos em 13/11/2026:

- [Register to OSS](https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/register-oss_en), com página publicada em 21/06/2021 e alterada em 10/08/2021;
- [Declare and pay in OSS](https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/declare-and-pay-oss_en), com as mesmas datas;
- a página [Guides](https://vat-one-stop-shop.ec.europa.eu/guides_en), alterada em 10/11/2026;
- o **"Guide to the VAT One Stop Shop", revisado em julho de 2026** para as mudanças de 01/01/2027 ([PDF](https://vat-one-stop-shop.ec.europa.eu/document/download/55f4ec9d-83e6-4942-9e8d-11d44c243087_en?filename=OSS%20Guidelines_revised_1Jan2027_0.pdf)). O próprio guia avisa: "This guide is not legally binding and is only practical and informal guidance".

O inteiro teor da Diretiva (arts. 358a–369) e do Regulamento 282/2011 continua **não lido** (EUR-Lex bloqueado). Por isso, cada linha abaixo diz qual página oficial da Comissão a sustenta.

| Ponto | O que a Comissão diz (13/11/2026) | Estado |
| --- | --- | --- |
| Quem pode usar | "Any taxable person, not established in the EU, who supplies services to non-taxable persons taking place in the EU, can register in the non-Union scheme" (Register to OSS, FAQ). Pelo guia revisado (Topic 4, a partir de 01/01/2027), o regime cobre serviços a não sujeitos passivos "whether established in the EU or not". | CONFERIDO (página da Comissão) |
| Onde registrar: o Estado de identificação é livre? | **Sim.** "a taxable person (who has neither established his business nor has a fixed establishment in the EU) can choose any Member State to be the Member State of identification"; tabela: "Free choice of MSI". Só um Estado por regime. Troca: "may change his Member State of identification at any time. Such a change will take effect at the end of the calendar quarter". | CONFERIDO |
| Como registrar | "Member States are free to choose how they collect this information [...] but it must be provided electronically. In practice, Member States will provide a web portal". O Estado confere os dados, verifica no mínimo se já há registro no mesmo regime em outro Estado ou se há quarentena, e "may refuse registration"; da recusa cabe recurso pelas vias nacionais. A Comissão publica o portal nacional de cada um dos 27 Estados na página [contact-country](https://vat-one-stop-shop.ec.europa.eu/contact-country_en) (alterada em 02/09/2025). | CONFERIDO |
| Dados pedidos no registro | Guia revisado, anexo 2, coluna "non-Union scheme": | CONFERIDO (anexo do guia) |
| | número nacional de identificação fiscal ("National tax number"); | |
| | razão social e nomes comerciais; | |
| | endereço postal completo; | |
| | país do local do negócio; | |
| | e-mail; | |
| | site(s) "where available", que deixa de ser obrigatório a partir de 01/01/2027 (Topic 9); | |
| | nome e telefone de contato; | |
| | IBAN ou OBAN; BIC (opcional); | |
| | números de IVA já atribuídos como não estabelecido; | |
| | declaração eletrônica de que não é estabelecido na União; | |
| | datas de pedido, de início e de decisão. | |
| Custo do registro | Nenhuma das páginas e nenhum trecho do guia lidos menciona taxa, custo ou gratuidade. Custo desconhecido, nunca zero. | NÃO CONFERIDO |
| Prazo de aprovação | Não há prazo de decisão nas páginas lidas. O Estado "will confirm [...] the date of the registration decision by electronic means". Início dos efeitos: "from the first day of the calendar quarter following that in which the taxable person informs the Member State of identification", ou desde a primeira venda se o Estado for informado "by the tenth day of the month following that first supply". Fora desse prazo, a empresa tem de se registrar e pagar diretamente em cada Estado de consumo. | Início dos efeitos CONFERIDO; prazo de decisão NÃO CONFERIDO |
| O que se recebe | "That Member State will allocate an individual VAT identification number [...] (using the format EUxxxyyyyyz). This VAT identification number can only be used to declare supplies falling under the non-Union scheme." Anexo 2, nota 1: "xxx is the 3-digit ISO numeric code of the Member State of identification (MSI); yyyyy is the 5-digit number assigned by MSI; and z is a check digit." | CONFERIDO |
| Prazo das declarações | Trimestre civil; entrega eletrônica "by the end of the month following the end of the tax period": 1º tri até 30/04, 2º até 31/07, 3º até 31/10, 4º até 31/01. "There is no change to the deadline [...] if this date falls on the weekend or on a public holiday". Não se entrega antes do fim do período. Declaração sem movimento ("nil return") obrigatória. | CONFERIDO |
| Pagamento | Na entrega, ou até o mesmo prazo, sempre com o número de referência único da declaração (código do país, número de IVA e período). Atraso: lembrete no 10º dia após o prazo. Três trimestres seguidos de lembrete sem entrega, ou sem pagamento em 10 dias, levam à exclusão ("unless the amount unpaid for each return period is less than EUR 100", para o pagamento). Multas ficam com cada Estado de consumo. | CONFERIDO |
| Dados de cada declaração | "The precise details are laid out in Annex III of the Commission Implementing Regulation (EU) 2020/194." Por Estado de consumo: base tributável e IVA à taxa padrão e às reduzidas, com as taxas da TEDB. Partes: 1, dados gerais e referência; 2, operações por Estado de consumo; 3, correções de períodos anteriores (período, Estado e IVA total); 4, saldo por Estado; 5, total. Isentas e taxa zero não entram. A parte 2 não pode ser negativa. Correções vão numa declaração posterior, até 3 anos após o prazo da original. | CONFERIDO |
| Câmbio | "use the exchange rate as published by the European Central Bank on the last date of the tax period." Moeda: em geral o euro; Estados fora do euro podem exigir a moeda nacional. | CONFERIDO |
| Guarda por 10 anos e conteúdo | "These records must be kept for 10 years from the end of the year in which the transaction was made, regardless of whether the taxable person has stopped using the scheme or not". Conteúdo "laid out in Council Regulation 282/2011 (Article 63c)": Estado de consumo, tipo e data da operação, IVA devido, pagamentos antecipados e "information used to determine the place where the customer is established, has his permanent address or usually resides". Os registros têm de estar disponíveis eletronicamente, "without delay", ao Estado de identificação ou de consumo; não entregá-los em um mês após o lembrete leva à exclusão. | CONFERIDO (guia); lista completa do art. 63c NÃO CONFERIDO |
| Mudanças a partir de 01/01/2027 | Pelo guia revisado (Topics 1–10), o que toca o regime não União é: | Guia CONFERIDO |
| | Topic 3: esclarecimento do momento do fato gerador pelas regras gerais (arts. 66, 167a e 226, 7a); | |
| | Topic 4: o regime cobre serviços B2C a clientes estabelecidos ou não na UE (art. 359); | |
| | Topic 5: os Estados podem exigir representante fiscal só para **pedidos de restituição** pela 13.ª Diretiva; | |
| | Topic 9: o site deixa de ser dado obrigatório do registro (art. 361, n.º 1, c). | |
| | O guia anuncia "a completely new version" para as mudanças de 01/07/2028. Base: Diretiva (UE) 2025/516, Regulamento (UE) 2025/517 e Regulamento de Execução (UE) 2025/518, de 11/03/2025. | |
| Regulamento de Execução (UE) 2026/1869 | A página [VAT in the Digital Age](https://taxation-customs.ec.europa.eu/taxation-1/value-added-tax-vat/vat-digital-age_en) diz só: "The Regulation updates the detailed rules for the VAT special schemes and introduces the new transfer of own goods scheme under the Single VAT Registration (SVR) pillar". O guia revisado não o cita. O texto, inclusive a data de aplicação e a eventual alteração do formulário da declaração do Regulamento 2020/194, está na EUR-Lex, bloqueada. | NÃO CONFERIDO |

### Portais nacionais do OSS (Comissão, contact-country, lido em 13/11/2026)

Áustria finanzonline.bmf.gv.at; Bélgica finances.belgium.be (Intervat/OSS); Bulgária nra.bg; Croácia eusustavi.porezna-uprava.hr; Chipre gov.cy/mof-tax; República Tcheca financnisprava.gov.cz; Dinamarca skat.dk/onestopmoms; Estônia emta.ee; Finlândia vero.fi (MyTax); França impots.gouv.fr; Alemanha bzst.de (One-Stop-Shop EU); Grécia aade.gr/oss; Hungria moss.nav.gov.hu; Irlanda revenue.ie; Itália agenziaentrate.gov.it (One Stop Shop); Letônia vid.gov.lv; Lituânia vmi.lt/oss; Luxemburgo vatmoss.lu; Malta mtca.gov.mt; Países Baixos belastingdienst.nl; Polônia podatki.gov.pl; Portugal portaldasfinancas.gov.pt/oss; Romênia anaf.ro; Eslováquia financnasprava.sk; Eslovênia edavki.durs.si; Espanha sede.agenciatributaria.gob.es; Suécia skatteverket.se (one-stop-shop).

Nenhuma dessas páginas nacionais foi aberta: os hosts das autoridades seguem bloqueados. Idioma, autenticação exigida de quem não tem identificação fiscal local, prazo e custo de cada portal: **NÃO CONFERIDO**.

### Passos do dono, em ordem

Os passos seguem a leitura acima. Nenhum deles foi feito ou preparado por este documento.

1. **Ter a LLC constituída e o EIN em mãos.** O registro pede "National tax number", razão social, endereço postal completo, país do local do negócio, e-mail, contato, telefone e IBAN ou OBAN da empresa. Que o "National tax number" de uma LLC americana seja o EIN é inferência, **NÃO CONFERIDO**.
2. **Escolher um Estado-membro de identificação.** A escolha é livre, só um Estado é permitido, e a troca pode ser feita depois, com efeito no fim do trimestre. Critérios práticos (idioma, autenticação do portal para quem não tem identificação local, atendimento) não foram conferidos.
3. **Fazer o registro eletrônico no portal nacional desse Estado**, da lista acima, **antes da primeira venda** ou, no máximo, **até o dia 10 do mês seguinte à primeira venda**. Fora desse prazo, perde-se o regime para essas vendas e é preciso registrar e pagar em cada Estado de consumo.
4. **Esperar a decisão eletrônica do Estado.**
   - Prazo de decisão e custo: **NÃO CONFERIDOS**.
   - O Estado pode recusar o registro, com recurso pelas vias nacionais.
   - O dono recebe o número **EUxxxyyyyyz** (xxx é o código ISO numérico do Estado, yyyyy o número atribuído e z o dígito verificador), que só serve para o OSS não União, e a data da decisão.
5. **Comunicar ao Estado qualquer mudança nos dados de registro** até o dia 10 do mês seguinte à mudança.
6. **Todo trimestre:**
   - entregar a declaração eletrônica, mesmo sem movimento, até o fim do mês seguinte (30/04, 31/07, 31/10 e 31/01), com o câmbio do BCE do último dia do trimestre;
   - pagar até o mesmo prazo, com o número de referência da declaração.
7. **Guardar os registros por 10 anos** contados do fim do ano de cada operação, mesmo depois de sair do regime, e entregá-los eletronicamente quando pedidos.

## 3. Provas do lugar do consumidor

**Inteiro teor dos arts. 24a, 24b, 24d e 24f do Regulamento 282/2011: NÃO CONFERIDO** (EUR-Lex bloqueado).

**CONFERIDO, notas explicativas da Comissão.** [Explanatory notes on the EU VAT changes to the place of supply of telecommunications, broadcasting and electronic services that enter into force in 2015](https://taxation-customs.ec.europa.eu/system/files/2016-09/explanatory_notes_2015_en.pdf), publicadas em 03/04/2014 e lidas em 13/11/2026. O próprio documento diz "These explanatory notes are not legally binding". Seção 9.5.5:

- "Two items of evidence are needed in all the cases where none of the specific presumptions for telecommunications, broadcasting and electronic services (included in Articles 24a and 24b(a)-(c)) can be applied." Os demais casos do art. 58 caem no art. 24b(d), que "requires two items of non-contradictory evidence".
- Três provas só são necessárias para refutar uma das presunções específicas (art. 24d).
- "the items of evidence have to be different and should not duplicate each other". Exemplos de prova única: endereço de cobrança confirmado depois por autodeclaração; dados bancários confirmados pelo prestador de pagamento; IP e geolocalização que apontam para o mesmo lugar.
- Seção 9.5.6: com provas conflitantes, o prestador escolhe as mais relevantes comercialmente e segue o art. 24 (pessoa física: residência habitual).
- Seção 9.5.7: sem duas provas, "continue to seek further evidence"; "In cases of doubt priority should be given to the place that best ensures taxation at the place of actual consumption".
- Seção 6.5.2: o art. 24f traz uma lista não exaustiva de provas.

**CONFERIDO, orientação equivalente do HMRC.** [HMRC, VAT rules for supplies of digital services to consumers](https://www.gov.uk/guidance/the-vat-rules-if-you-supply-digital-services-to-private-consumers), atualizada em 28/03/2022 e lida em 13/11/2026. Exemplos de prova aceitos: endereço de cobrança, IP, dados bancários, código de país do SIM, linha fixa e "other commercially relevant information". A orientação exige "2 pieces of information". Para quem usa prestador de pagamento, sugere: país do endereço de cobrança ou do telefone, mais o código de país de residência informado pelo prestador; "If the information does not match, you must contact the consumer".

**Limite de 100 000 euros: NÃO CONFERIDO.** As notas de 2014 são anteriores ao Regulamento de Execução (UE) 2017/2459. A [página da Comissão sobre local de tributação](https://taxation-customs.ec.europa.eu/taxation/vat/vat-directive/place-taxation_en), lida em 13/11/2026, confirma o limite de **10 000 euros** do art. 59c **só** para "a supplier of such services [...] established in a different EU country to that of the customer". Isso não se aplica a uma LLC sem estabelecimento na UE. A construção usa **duas provas desde a primeira venda**.

Stripe (seção 6): o Stripe Tax prioriza um único endereço e não compara duas provas. A regra de duas provas tem de ficar no código do Marktmorgen.

## 4. B2B: inversão do sujeito passivo e VIES

**CONFERIDO, página da Comissão.** [Comissão, Persons liable for VAT](https://taxation-customs.ec.europa.eu/taxation/vat/vat-directive/persons-liable-vat_en), seção 1.2, lida em 13/11/2026, sem data editorial: "Under Article 196 VAT Directive, the person liable for VAT is the customer when:" (i) "that customer is a business acting as such or a non-taxable legal entity registered for VAT"; (ii) "the supply is one of services of which the place of supply is where the customer is established (this is the default rule for services supplied to taxable persons - see Article 44, VAT Directive)"; e (iii) "the supplier is a business not established in the EU country of the customer". A [página de local de tributação](https://taxation-customs.ec.europa.eu/taxation/vat/vat-directive/place-taxation_en) confirma: "B2C supplies of telecommunications, broadcasting and electronic services are taxed where the customer resides (Article 58 VAT Directive)". **NÃO CONFERIDO:** inteiro teor dos arts. 44, 58 e 196 e do art. 18 do Regulamento 282/2011.

**CONFERIDO, VIES.** [VIES](https://ec.europa.eu/taxation_customs/vies/), perguntas frequentes oficiais e mensagens do próprio serviço (API pública do aplicativo, idioma inglês), lidas em 13/11/2026:

- **Como consultar:** a verificação é "done against the national VAT database corresponding to the selected Member State / Northern Ireland. There is no VAT database at Community level". Há serviços SOAP e REST "offering the same functionality as the interactive service" (FAQ 18). A resposta do serviço tem um campo "Consultation Number" (`requesterId`). As condições para recebê-lo e seu valor de prova não foram conferidos.
- **Só vale para o dia:** "It is not possible to confirm the validity of a VAT number in the past. It is possible to do it only for the current day" (FAQ 6). Então o resultado tem de ser guardado no momento da venda.
- **Fora do ar:** "Some parts of the system may be unavailable at certain times due to the necessity to back-up the Member States' / Northern Ireland databases" (FAQ 14). Mensagens de erro do serviço: `MS_UNAVAILABLE` ("Member State / Northern Ireland service unavailable. Please re-submit your request later."), `SERVICE_UNAVAILABLE`, `TIMEOUT`, `MS_MAX_CONCURRENT_REQ` e `GLOBAL_MAX_CONCURRENT_REQ`. A disponibilidade por país é pública em `rest-api/check-status`; em 13/11/2026, todos os 27 e XI estavam "Available".
- **Sem confirmação:** "If you believe that your customer is not a taxable person, you should not exempt the supply but should charge VAT" (FAQ 20). E, para serviços eletrônicos: "If the customer does not have a valid VAT number, then the supplier will charge VAT" (FAQ 3).
- **Não confirma nome e endereço:** só a validade do número; alguns Estados mostram nome e endereço (FAQ 17). A Espanha exige que nome e endereço sejam informados junto (FAQ 22). Números austríacos começam com "U" depois de "AT" (FAQ 21).

Regra para a construção, pela leitura acima: inversão só com o número `valid` no VIES no momento da venda, guardando a data, a hora e a resposta. Com VIES indisponível ou número inválido, cobra-se o IVA do consumidor (FAQ 20). O Stripe Tax inverte só pelo formato (seção 6), então essa trava tem de ficar no nosso código.

## 5. Reino Unido

Todas as páginas foram lidas em 13/11/2026 pela API de conteúdo do GOV.UK. A data é o `public_updated_at` de cada uma.

| Ponto | Fonte e trecho | Estado |
| --- | --- | --- |
| Registro sem limite para não estabelecido | [VAT Notice 741A](https://www.gov.uk/guidance/vat-place-of-supply-of-services-notice-741a), seção 2.6, atualizada em 29/09/2022: "If you are not established in the UK, there is no registration threshold for taxable supplies of services"; quem faz qualquer prestação tributável no Reino Unido fora da inversão "must register for VAT here". | CONFERIDO |
| Quem é não estabelecido e quando registrar | [VAT Notice 700/1](https://www.gov.uk/government/publications/vat-notice-7001-should-i-be-registered-for-vat/vat-notice-7001-should-i-be-registered-for-vat), atualizada em 05/08/2026. Seção 9.1: o NETP "is any person who does not have a UK establishment". Seção 9.2: "A registered, serviced or virtual office alone is not enough to create a business establishment". Seção 9.3: "You must register if you make taxable sales in the UK or expect to do so in the next 30 days", e "you must tell HMRC within 30 days". | CONFERIDO |
| Como registrar | 700/1, seções 4.1 e 9.4: pelo "online VAT registration service" do HMRC. O registro é feito no endereço do "principal place of business", que "must be outside the UK and should not be a third-party address, such as mailing forwarding or registered office address". Representante fiscal é opcional, mas "HMRC can direct you to appoint a VAT representative or ask you to pay a security". | CONFERIDO |
| Prazo e o que se recebe | 700/1, seção 4.5: o HMRC confere os dados e informa o número; "If you have not heard from us after 40 working days, contact our VAT Registration Service". [Register for VAT](https://www.gov.uk/register-for-vat/how-register-for-vat), atualizada em 10/10/2024, "After you register": "a 9-digit VAT registration number", instruções da business tax account para o serviço online, a data da primeira declaração e a "effective date of registration", "by post". O HMRC inscreve a empresa no Making Tax Digital, salvo isenção. | CONFERIDO |
| Custo do registro | Nenhuma das páginas lidas menciona taxa de registro. Não se conclui que é gratuito. | NÃO CONFERIDO |
| Atraso | 700/1, seção 11.1: o HMRC pode registrar de ofício; multa de 5% (menos de 9 meses), 10% (9 a 18 meses) ou 15% (mais de 18 meses) do IVA líquido devido. | CONFERIDO |
| Taxa padrão | [VAT rates](https://www.gov.uk/vat-rates), `public_updated_at` 12/12/2014: "The standard VAT rate is 20%". | CONFERIDO |
| Regra de plataforma (equivalente ao art. 9a) | [VAT rules for supplies of digital services to consumers](https://www.gov.uk/guidance/the-vat-rules-if-you-supply-digital-services-to-private-consumers), atualizada em 28/03/2022, seção "Digital platforms and accounting for VAT". A plataforma responde pelo IVA das vendas de terceiros "unless you meet all of the following conditions": identificar o fornecedor nos contratos e nas faturas, e "must not: authorise the charge to the consumer; authorise the delivery; set the general terms and conditions of the sale". Caso contrário, "you must treat the sales of third-party e-services as if they were your own". Também: "the vast majority of digital platforms will be liable"; o mero processador de pagamentos não é plataforma; e "If you supply digital services to consumers via a third party platform or marketplace, the digital platform is responsible for accounting for VAT on the supply instead of you". | CONFERIDO |
| O que é serviço eletrônico (cursos) | Mesma página: "Education, training, or a similar service delivered by a person over the internet [...] (such as a webinar), is not considered to be an electronically supplied service"; "Automated learning does not have human involvement and is therefore a digital service". | CONFERIDO |
| Prazo das declarações | [Sending a VAT Return](https://www.gov.uk/submit-vat-return), atualizada em 26/11/2024: declaração "usually [...] every 3 months"; obrigatória mesmo sem imposto; prazo "usually one calendar month and 7 days after the end of an accounting period", que também é o prazo do pagamento, "even if it's on a weekend or bank holiday". O período efetivo aparece na conta online. | CONFERIDO |
| Bens por marketplace (questão 27, para comparação) | [HMRC, VATREG37210](https://www.gov.uk/hmrc-internal-manuals/vat-registration-manual/vatreg37210), atualizado em 29/04/2024: a seção 5A da VAT Act 1994 torna o marketplace o fornecedor presumido de bens fora do Reino Unido em remessas de até £135, desde 01/01/2021. | CONFERIDO |
| Base legal do registro de não estabelecido | [VAT Act 1994, Schedule 1A](https://www.legislation.gov.uk/ukpga/1994/23/schedule/1A), "Registration in respect of taxable supplies: non-UK establishment", inserida pela Finance Act 2012 (Sch. 28), lida em 13/11/2026 em legislation.gov.uk. Para 1: fica obrigado ao registro quem cumpre as condições A a D: (A) faz prestações tributáveis ou há "reasonable grounds for believing" que as fará "in the period of 30 days then beginning"; (B) no curso de um negócio; (C) "has no business establishment, or other fixed establishment, in the United Kingdom"; (D) não está registrado. Para 5 e 6: notificar o HMRC em 30 dias do início da obrigação (ou antes do fim do período de 30 dias, no caso de previsão), e o HMRC registra "whether or not the person so notifies them" desde o dia em que a obrigação surgiu. Para 7 e 8: comunicar o fim das prestações em 30 dias e pedir o cancelamento. A Schedule 1A não traz limite de faturamento. | CONFERIDO (texto da lei; a página não mostrou o aviso de "changes to legislation" pendentes, e isso não foi conferido) |
| Regra de plataforma na lei britânica | [Cópia britânica do art. 9a do Regulamento 282/2011](https://www.legislation.gov.uk/eur/2011/282/article/9a), lida em 13/11/2026: o mesmo texto do art. 9a, inclusive "a taxable person who [...] authorises the charge to the customer or the delivery of the services, or sets the general terms and conditions of the supply, shall not be permitted to explicitly indicate another person as the supplier", e o n.º 3 do mero processador de pagamentos. A vigência atual desse texto no direito britânico depois da Retained EU Law (Revocation and Reform) Act 2023 não foi conferida. | Texto CONFERIDO; vigência NÃO CONFERIDO |

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
