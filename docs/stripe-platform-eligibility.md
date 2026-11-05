# SR — Resposta posterior do Stripe Support (03/11/2026, 13h09 Fortaleza)

Proveniência: e-mail de Stripe Support, assinado pela mesma equipe especializada, recebido em 03/11/2026 às 13h09 (Fortaleza) no fio "Re: Connect platform eligibility for international accounts" do Gmail do dono (conta 090), lido pelo Claude 1 em 03/11/2026 às 17h40, só leitura: nada foi respondido, encaminhado, marcado ou apagado. Responde às quatro perguntas do dono de 02/11/2026, 19h29, e às quatro sobre a participação na receita de 03/11/2026, 00h39. Nenhum identificador de conta é copiado. O próprio Stripe diz que o e-mail não muda nenhuma conta, que não é aconselhamento jurídico e que encerrou o caso (reabre se o dono responder). Não é aprovação de conta, país, endereço ou abertura.

Decisão do dono (03/11/2026, ao pedir este registro): **no ponto do endereço, esta resposta prevalece sobre SR5**; e **a participação na receita do Stripe conta como zero em toda margem**. O restante de SR5, SD1 e SC1 abaixo continua valendo onde esta resposta não diverge; o texto anterior fica como histórico.

## Resumo fiel

**Participação na receita (revenue share) em contas Standard com cobrança direta**

1. A conta brasileira atual da plataforma **não se qualifica**: o programa não existe para contas de plataforma registradas no Brasil. A futura conta americana da LLC poderá ser considerada depois de existir e cumprir todos os requisitos; o Stripe não confirma elegibilidade nem promete aceite.
2. Requisitos informados: Connect com contas Standard; Checkout ou Payment Element; todo o volume dos países e meios de pagamento suportados processado pelo Stripe; pelo menos US$ 1 milhão de volume anualizado; status de Stripe Partner completo (não provisório) e aprovação na Verification Assessment; conta de plataforma registrada em país suportado. Nenhum número mínimo de contas conectadas. Inscrição por e-mail a partner-support@stripe.com, com análise de cerca de 3 a 4 semanas.
3. Percentual não publicado e não informado pelo suporte; pagamento mensal, acumulado a partir do mês seguinte ao aceite dos termos do programa; valem os termos escritos do programa, não o e-mail.
4. A documentação não descreve mudança nas taxas, no painel ou no contrato dos criadores; é uma remuneração paga à plataforma, sem promessa de efeitos além disso.

**As quatro perguntas de 02/11/2026**

1. **Responsabilidade:** na configuração padrão de contas Standard com cobrança direta, a conta conectada responde por reembolsos, contestações, taxas de contestação e saldo negativo; o Stripe tenta primeiro debitar o saldo do criador, não a conta da plataforma. Sem garantia para todos os casos, porque um acordo ou configuração separada pode mudar isso.
2. **Reembolso pela plataforma:** sim; a plataforma cria o reembolso pela API com a chave secreta da plataforma e o cabeçalho Stripe-Account com o ID da conta do criador, inclusive para cobrança duplicada por engano; o criador vê o reembolso no próprio painel (https://docs.stripe.com/connect/direct-charges).
3. **Aprovação do Connect:** a conta americana será outra conta Stripe; a expectativa é de configuração própria do Connect e nova análise do perfil da plataforma, sem garantia de que a aprovação de setembro passe para ela. Preparar: site funcionando, descrição do negócio e de como criadores e compradores usam a plataforma, termos de uso e o fluxo de abertura de conta.
4. **Endereço nos EUA:** o Stripe confere primeiro se o endereço existe e corresponde à empresa; se não corresponder, pede prova. Provas aceitas: contrato de locação assinado, conta de consumo (utility bill), declaração de imposto ou documento governamental da empresa, como os Articles of Incorporation, mostrando o endereço e o nome da empresa ou da pessoa. **Caixa postal e endereço de escritório virtual não são aceitos.** O Stripe não sabe dizer se um contrato de coworking seria aceito e pede para não contar com ele.

## Aplicação vigente

| Ponto | Aplicação a partir de 03/11/2026 |
| --- | --- |
| Endereço nos EUA (substitui a linha de SR5 neste ponto) | Endereço comercial real nos EUA, que exista e corresponda à LLC. **Caixa postal e escritório virtual não são aceitos** (antes: escritório virtual "sem aceitação antecipada garantida"). Coworking: não contar com ele. Endereço de registered agent continua não recomendado como endereço de operação. Prova possível: locação assinada, conta de consumo, declaração de imposto ou documento governamental da empresa, com o endereço e o nome. Banco nos EUA no nome exato da LLC continua. |
| Participação na receita do Stripe | **Conta como zero em toda margem, cálculo, base mínima e relatório** (decisão do dono). Conta brasileira não se qualifica; a americana só depois de existir, com US$ 1 milhão anualizado, status de parceiro e aceite de termos que não foram aceitos. Nenhum agente pede inscrição, aceita termos ou escreve a partner-support@stripe.com. |
| Reembolsos, contestações e saldo negativo | Responsabilidade da conta conectada na configuração padrão, **sem garantia**: as reservas de reembolso e de contestação de `lib/receiving-costs.ts` e as exposições financiadas continuam integralmente. |
| Reembolso pela API da plataforma | Possível tecnicamente na cobrança direta, com o cabeçalho Stripe-Account; não autoriza nenhum fluxo novo de reembolso por este registro. |
| Connect da conta americana | Nova configuração e nova análise esperadas; a aprovação de setembro da conta brasileira não vale como aprovação da americana. Os itens a preparar entram no roteiro 470 [SR4], em "Depende do dono". |

Pendências e limites: nenhuma resposta ao Stripe foi enviada e nenhuma deve ser enviada por agente. Não muda PLANS_ON_SALE, OPENING_REQUESTED, stripePlatformEligibilityReady, tax gate, art. 9a, revisão comercial, preços, limites, comissão nem qualquer trava, e nenhum coeficiente de `lib/receiving-costs.ts`. Os textos de SR5 em AGENTS.md e CLAUDE.md ainda trazem a redação anterior sobre escritório virtual; neste ponto prevalece esta seção.

VR: registro documental de resposta conferida no Gmail do dono; nada novo disponível ao cliente, nenhuma conta aprovada, nenhum lucro certificado.

---

# SR5 — Aplicação vigente da resposta completa relatada (28 October 2026)

Solicitação do dono (28/10/2026, 00h23, horário de Fortaleza),494[SR5], versão final. **Proveniência conferida pelo Claude em28/10/2026 Gmail do dono:** e-maildesupport@stripe.com de27/10/2026,16h47Fortaleza,assinadoGabriel/equipeespecializada,no fio"Re: Connect platform eligibility for international accounts",texto idêntico ao colado pelo dono. Mensagens anteriores da mesma equipe21/10/202619h41 e22/10/202614h15não a contradizem. Esta é a conferência doClaude informada na versão final do dono; não afirmar queCodex a repetiu. Conta não aprovada por este registro.

O dono determinou que esta resposta posterior, completa e sem contradição substitui a aplicação menos favorável dos quatro pontos de467[SR1]. A regra geral para futuras respostas contraditórias continua; as tabelas/respostas anteriores ficam **histórico**, sem prevalecer nos pontos substituídos aqui. As datas e correções de respostas antigas são as relatadas pelo dono.

| Ponto | Aplicação vigente — relato completo recebido em28/10/2026 00h23Fortaleza |
| --- | --- |
| Plataforma brasileira conta de plataforma brasileira do dono | **Sim:** conecta criadores nosEUA,Canadá,ReinoUnido eEEE,excetoIslândia, com **cobranças diretas sem taxa de aplicação**. Fora doBrasil não há application fees,destination charges nem separate charges and transfers; cobrar somente assinatura não precisa desses mecanismos. A resposta relatada de vendas19/10corrige suporte09/10 neste ponto. |
| LLC de sócio único deDelaware eITIN | **ITIN não obrigatório**, segundo a resposta relatada: criação com empresa/EIN; ativação comEIN,documento nãoamericano(passaporte preferido) eCPF; primeiro saque com conta bancária nosEUA,semITIN. Conta analisada individualmente,podem ser pedidos outros documentos; se cadastro pedirSSN/ITIN,o dono deve guardar a mensagem exata. Suporte11/10correto; vendas19/10não corresponde às orientações de verificação relatadas. |
| Representante legal | **Pode ser o próprio dono morando noBrasil**, sem residência nosEUA,SSN ouITIN; passaporte brasileiro,CPF e dados doEIN,com possíveis pedidos adicionais de documentos. |
| Endereço nosEUA e banco | **Endereço comercial real nosEUA,nunca caixa postal.** A empresaAtlas pode ter endereço principal do dono emFortaleza,mas endereço residencialBRnão basta para contaStripeUS. Registered agent não deve ser endereço de operação; não recomendado. Escritório virtual sem aceitação antecipada garantida; se falhar verificação automática,revisão manual. ParceirosAtlas oferecem endereçoUScomdesconto,sem cotação/aceite presumido. BancoUSno **nome exato daLLC**. Segundo mensagem22/10/202614h15,Mercuryfora vantagensAtlasdesdesetembro2026;StripeTreasuryindicado apenas a quemforelegível,não contratação/garantia. |

**Stripe Tax pendente:** pergunta de20/10/2026,cobrada21/10,sobre quem arca com taxaStripeTax em cobrançasdiretas de contasStandard doscriadores(plataformaouconectada) continua **sem resposta**. Até resposta aplicável,manter a leitura menos favorável já usada emlib/receiving-costs.ts;nenhum coeficiente/código alterado.

**Não é aprovação de conta.** Pontos2e3 são resultados esperados, não aprovações; documentos adicionais/revisão individual continuam possíveis. Não confundir representante legal com endereço comercial/registeredagent ou representantesGDPR/DSA.

**468[SR2] continua integralmente até decisão do dono em495[SR6].** Não alterar PLANS_ON_SALE,OPENING_REQUESTED,stripePlatformEligibilityReady,taxgate,art9a,revisão comercial ou demais travas. Nenhuma conta/empresa/EIN/ITIN/aceite/contrato/pagamento/contatoStripeouterceiro. Não abrir vendas por causa da tabela. Nenhum código de imposto, preço, limite, comissão, permissão, conteúdo, idioma ou identificador alterado.

495[SR6] permanece somente estudo dos caminhosBRCPF eLLC, com fontes oficiais datadas/TX,mesmas premissas/preços,meses1/6/12/24/48,base mínima/prazo/inclusiveEINsemSSN,bancoUSnonomeLLC/riscos e impostos sobreconsumo nosdoiscaminhos. Recomendação única futura emDependedodono; não decidir rota nem alterar termos/conta/leitura tributária no código. As pesquisas/roteirosSR3/SR4 devem considerar esta resposta nova sem apagar seu histórico; não imporITIN ou representante residente como necessidade confirmada nem fingir preço zero de custo desconhecido. MR/TX/100%custosFX275/reservas continuam.

VR: aplicação documental concreta dos quatro pontos, sem recurso novo ao cliente, conta aprovada, pesquisa econômica concluída, abertura ou lucro certificado.0→0passos/decisões de interface; sem teste humano/AAA. Sem novoIOprodutivo/serviço/retenção; CI/tempo100%empresaFX275 desconhecidos,nãozero. Contador254,sem entrega255.

Proveniência da revisão: versãofinal da mesma solicitação aplicada porPedidosrepetidos3a,mesmos494/495/posição/estado; substitui somente proveniência,detalhesendereço/banco,pendênciaStripeTax eprazoEINsemSSN. Textosanteriorespreservadoscomohistórico,sem prevalecer sobre versãofinal.

## Versão final integral recebida do dono — mesma solicitação, sem novos itens

SR — Resposta completa do Stripe substitui a leitura menos favorável (28/10/2026) — versão final

Solicitação do dono (28/10/2026, 00h23, horário de Fortaleza).

NÃO PARE O QUE ESTÁ FAZENDO. COLOQUE NA FILA.

Pedidos repetidos: antes de gravar, aplique a regra permanente "Pedidos repetidos". Confira o main, os PRs abertos e os ramos codex/* recentes, e procure esta solicitação pela linha de data e hora, pelo nome da seção, pelas etiquetas [SR5] e [SR6] e pelo conteúdo. Esta é a versão final deste pedido. A versão anterior, com a mesma linha de data e hora, já está em gravação no PR #1139 como 494 [SR5] e 495 [SR6]: aplique somente a diferença (passo 3a), mantendo números, posição e estado, e registre na proveniência o que mudou. Não crie itens novos.

Contexto: a regra SR (467 [SR1]) diz que, quando respostas do Stripe se contradisserem, vale a menos favorável ao dono "até que resposta posterior, completa e sem contradição, a substitua". Essa resposta chegou. Proveniência conferida pelo Claude em 28/10/2026 no Gmail Gmail do dono: e-mail de support@stripe.com de 27/10/2026, 16h47 (Fortaleza), assinado por Gabriel, da equipe especializada do Stripe, no fio "Re: Connect platform eligibility for international accounts", texto idêntico ao colado pelo dono. As mensagens anteriores da mesma equipe (21/10/2026, 19h41, e 22/10/2026, 14h15) não a contradizem. Substitua, no texto gravado, "relato colado pelo dono; e-mail original não verificado de forma independente" por esta proveniência. Resumo fiel da resposta de 27/10:
1. A conta de plataforma brasileira conta de plataforma brasileira do dono pode conectar criadores nos EUA, no Canadá, no Reino Unido e no EEE (exceto Islândia) e usar cobranças diretas sem taxa de aplicação. Taxas de aplicação, destination charges e separate charges and transfers não estão disponíveis em contas conectadas fora do Brasil; a cobrança só da assinatura não precisa deles. Correta a resposta de vendas de 19/10/2026; errada a de suporte de 09/10/2026.
2. LLC de sócio único de Delaware: ITIN não é obrigatório. Criação da conta: dados da empresa e EIN. Ativação: EIN e documento de identidade não americano (passaporte preferido) e CPF como identificação fiscal local. Primeiro saque: sem ITIN, com conta bancária nos EUA. O Stripe analisa cada conta e pode pedir mais; se o cadastro pedir SSN ou ITIN, enviar a ele a mensagem exata. Correta a resposta de 11/10/2026; a de vendas de 19/10/2026 não corresponde às orientações de verificação.
3. Representante legal: não precisa morar nos EUA nem ter SSN ou ITIN; o dono pode ser o representante morando no Brasil. Documentos: passaporte brasileiro, CPF e dados do EIN; o Stripe pode pedir documentos durante o cadastro.
4. Endereço nos EUA: caixa postal nunca é aceita; endereço de registered agent não é recomendado; escritório virtual não pode ser garantido de antemão; se não passar na verificação automática, revisão manual. Detalhes da mensagem de 22/10/2026, 14h15: a empresa da Atlas pode ter o endereço do dono em Fortaleza como endereço principal; a conta Stripe dos EUA exige endereço comercial nos EUA (o endereço residencial no Brasil não basta); o endereço do registered agent não deve ser usado como endereço de operação; parceiros da Atlas oferecem endereço comercial nos EUA com desconto; conta bancária nos EUA no nome exato da LLC; desde setembro de 2026 o Mercury não está mais entre as vantagens da Atlas, que indica o Stripe Treasury a quem for elegível.
Ressalva do próprio Stripe: os pontos 2 e 3 são resultados esperados, não aprovações.
Pendente: a pergunta de 20/10/2026, cobrada em 21/10/2026, sobre quem paga a taxa do Stripe Tax nas cobranças diretas das contas Standard dos criadores (a plataforma ou a conta conectada) continua sem resposta do Stripe; até haver resposta, vale a leitura menos favorável já usada em lib/receiving-costs.ts.

[SR5] Gravar a resposta e substituir a aplicação.
Estado inicial: na fila.
Guarde a resposta e a proveniência acima em docs/stripe-platform-eligibility.md, e atualize a tabela da seção SR em AGENTS.md e CLAUDE.md: ponto 1, sim; ponto 2, ITIN não obrigatório; ponto 3, representante pode ser o dono morando no Brasil; ponto 4, endereço comercial real nos EUA, nunca caixa postal, com as observações sobre registered agent, escritório virtual e conta bancária. Preserve as respostas antigas como histórico. Registre a pergunta do Stripe Tax como pendente. Registre que nada disso é aprovação de conta. Não altere PLANS_ON_SALE, stripePlatformEligibilityReady nem nenhuma trava por este item: a condição 468 [SR2] continua até a decisão do dono no SR6.

[SR6] Estudo: abrir pela conta brasileira ou pela LLC.
Estado inicial: na fila.
Compare, com fontes oficiais datadas e a interpretação juridicamente mais correta (política TX), os dois caminhos:
(a) abrir as vendas pela conta Stripe brasileira existente, ativada em pessoa física (CPF): imposto de renda da pessoa física sobre o resultado (carnê-leão, livro-caixa e alíquotas vigentes), INSS de contribuinte individual, ISS na exportação de serviços (LC 116/2003, art. 2º, I e parágrafo único), IOF e câmbio na remessa, moedas que a conta brasileira aceita e em que moeda liquida, taxas do Stripe Brasil para cartões estrangeiros, e o que muda nos termos (operador hoje: "Vinicius Colares Sucupira, an individual trading as Solrenning");
(b) manter a LLC de Delaware (sem ITIN e com o dono como representante, conforme a resposta acima): custos fixos 275 [FX1], endereço comercial real nos EUA, conta bancária nos EUA no nome da LLC e prazo até abrir, inclusive o prazo do EIN sem SSN.
Para cada caminho, mostre o lucro líquido mensal com os preços atuais nos meses 1, 6, 12, 24 e 48 sob as mesmas premissas, a base mínima de clientes, o prazo até a primeira venda possível e os riscos. Impostos sobre consumo (IVA/OSS, sales tax) valem nos dois caminhos e devem aparecer. Termine com uma recomendação única em "Depende do dono". Somente estudo: não mude trava, termos, conta, nem leitura tributária no código.

Regra de margem: segue a REGRA DE MARGEM vigente (MR, 27/10/2026, 07h42): nenhum cliente pagante dá prejuízo no pior caso, com 100% dos direitos, no mensal e no anual, com teto automático e reserva antes de cada gasto; empresa sem prejuízo a partir da base mínima; 60% é meta mensal real, não trava. Custo desconhecido reprova, nunca é zero; taxas de recebimento mais caras de lib/receiving-costs.ts; custos fixos 100% do Marktmorgen.

Proibido: mudar preços, cortar limites visíveis, retirar recursos, alterar comissão, PLANS_ON_SALE, OPENING_REQUESTED, o tax gate, o art. 9a, a revisão comercial ou stripePlatformEligibilityReady; criar contas, abrir empresa, pedir EIN ou ITIN, aceitar termos, contratar, pagar ou contatar o Stripe ou terceiros; tratar a resposta como aprovação de conta; apagar conteúdo ou qualquer coisa da Hazelsong. Somente testes sintéticos.

Aplicar a regra VR.

## Histórico da versão anterior recebida — proveniência sucedida pela conferência Claude acima

SR — Resposta completa do Stripe substitui a leitura menos favorável (28/10/2026)

Solicitação do dono (28/10/2026, 00h23, horário de Fortaleza).

NÃO PARE O QUE ESTÁ FAZENDO. COLOQUE NA FILA.

Pedidos repetidos: antes de gravar, aplique a regra permanente "Pedidos repetidos". Confira o main, os PRs abertos e os ramos codex/* recentes, e procure esta solicitação pela linha de data e hora, pelo nome da seção, pelas etiquetas [SR5] e [SR6] e pelo conteúdo. Se já estiver gravada, não crie nada novo. Grave depois dos itens já existentes, na ordem de chegada, com os próximos números livres, sem alterar a ordem dos itens existentes.

Contexto: a regra SR (467 [SR1]) diz que, quando respostas do Stripe se contradisserem, vale a menos favorável ao dono "até que resposta posterior, completa e sem contradição, a substitua". O dono recebeu e colou em 28/10/2026, 00h23, a resposta de Gabriel, da equipe especializada do Stripe, conferida, segundo ele, com as orientações internas do Stripe e a disponibilidade por país da conta conta de plataforma brasileira do dono. Ela responde os quatro pontos, diz quais respostas anteriores estavam erradas e não se contradiz. Resumo fiel:
1. A conta de plataforma brasileira conta de plataforma brasileira do dono pode conectar criadores nos EUA, no Canadá, no Reino Unido e no EEE (exceto Islândia) e usar cobranças diretas sem taxa de aplicação. Taxas de aplicação, destination charges e separate charges and transfers não estão disponíveis em contas conectadas fora do Brasil; a cobrança só da assinatura não precisa deles. Correta a resposta de vendas de 19/10/2026; errada a de 09/10/2026.
2. LLC de sócio único de Delaware: ITIN não é obrigatório. Criação da conta: dados da empresa e EIN. Ativação: EIN e documento de identidade não americano (passaporte preferido) e CPF como identificação fiscal local. Primeiro saque: sem ITIN, com conta bancária nos EUA. O Stripe analisa cada conta e pode pedir mais; se o cadastro pedir SSN ou ITIN, enviar a ele a mensagem exata. Correta a resposta de 11/10/2026; a de vendas de 19/10/2026 não corresponde às orientações de verificação.
3. Representante legal: não precisa morar nos EUA nem ter SSN ou ITIN; o dono pode ser o representante morando no Brasil. Documentos: passaporte brasileiro, CPF e dados do EIN; o Stripe pode pedir documentos durante o cadastro.
4. Endereço nos EUA: caixa postal nunca é aceita; endereço de registered agent não é recomendado; escritório virtual não pode ser garantido de antemão; se não passar na verificação automática, revisão manual.
Ressalva do próprio Stripe: os pontos 2 e 3 são resultados esperados, não aprovações.

[SR5] Gravar a resposta e substituir a aplicação.
Estado inicial: na fila.
Guarde a resposta, com data e proveniência (relato colado pelo dono; e-mail original não verificado de forma independente), em docs/stripe-platform-eligibility.md, e atualize a tabela da seção SR em AGENTS.md e CLAUDE.md: ponto 1, sim; ponto 2, ITIN não obrigatório; ponto 3, representante pode ser o dono morando no Brasil; ponto 4, inalterado (endereço comercial real, nunca caixa postal), com as observações sobre registered agent e escritório virtual. Preserve as respostas antigas como histórico. Registre que nada disso é aprovação de conta. Não altere PLANS_ON_SALE, stripePlatformEligibilityReady nem nenhuma trava por este item: a condição 468 [SR2] continua até a decisão do dono no SR6.

[SR6] Estudo: abrir pela conta brasileira ou pela LLC.
Estado inicial: na fila.
Compare, com fontes oficiais datadas e a interpretação juridicamente mais correta (política TX), os dois caminhos:
(a) abrir as vendas pela conta Stripe brasileira existente, ativada em pessoa física (CPF): imposto de renda da pessoa física sobre o resultado (carnê-leão, livro-caixa e alíquotas vigentes), INSS de contribuinte individual, ISS na exportação de serviços (LC 116/2003, art. 2º, I e parágrafo único), IOF e câmbio na remessa, moedas que a conta brasileira aceita e em que moeda liquida, taxas do Stripe Brasil para cartões estrangeiros, e o que muda nos termos (operador hoje: "Vinicius Colares Sucupira, an individual trading as Solrenning");
(b) manter a LLC de Delaware (sem ITIN e com o dono como representante, conforme a resposta acima): custos fixos 275 [FX1], conta bancária nos EUA, endereço comercial real e prazo até abrir.
Para cada caminho, mostre o lucro líquido mensal com os preços atuais nos meses 1, 6, 12, 24 e 48 sob as mesmas premissas, a base mínima de clientes, o prazo até a primeira venda possível e os riscos. Impostos sobre consumo (IVA/OSS, sales tax) valem nos dois caminhos e devem aparecer. Termine com uma recomendação única em "Depende do dono". Somente estudo: não mude trava, termos, conta, nem leitura tributária no código.

Regra de margem: segue a REGRA DE MARGEM vigente (MR, 27/10/2026, 07h42): nenhum cliente pagante dá prejuízo no pior caso, com 100% dos direitos, no mensal e no anual, com teto automático e reserva antes de cada gasto; empresa sem prejuízo a partir da base mínima; 60% é meta mensal real, não trava. Custo desconhecido reprova, nunca é zero; taxas de recebimento mais caras de lib/receiving-costs.ts; custos fixos 100% do Marktmorgen.

Proibido: mudar preços, cortar limites visíveis, retirar recursos, alterar comissão, PLANS_ON_SALE, OPENING_REQUESTED, o tax gate, o art. 9a, a revisão comercial ou stripePlatformEligibilityReady; criar contas, abrir empresa, pedir EIN ou ITIN, aceitar termos, contratar, pagar ou contatar o Stripe ou terceiros; tratar a resposta como aprovação de conta; apagar conteúdo ou qualquer coisa da Hazelsong. Somente testes sintéticos.

Aplicar a regra VR.

---

## Histórico integral anterior — aplicação substituída nos quatro pontos porSR5 acima

# Stripe platform eligibility — SR (27 October 2026)

> **TX vigente — dono, 27/10/2026, 12h34 Fortaleza.** As referências anteriores deste documento à regra 19, à leitura que dá mais imposto, ao ISS de 5% como certo ou a consultas tributárias ficam preservadas como histórico e são substituídas, nos pontos conflitantes, pela política TX de [AGENTS.md](../AGENTS.md). Nenhuma consulta será feita ou preparada para envio. As taxas de recebimento mais caras, SR, desconhecido reprova, reservas, exposição e custeio continuam obrigatórios. A [matriz TX1](tx-legal-source-review-2026-10-27.md) distingue fontes conferidas e lacunas; não certifica incidência zero. O código e os números antigos ainda não adaptados não provam a nova leitura; revisão e regeneração pertencem a TX2/TX5. Flags continuam false.
>
> **SV vigente — dono, 27/10/2026, 13h19 Fortaleza.** EU1 e SV1–SV5 ficam depois da abertura, com trabalho e provas preservados, sem novos PRs desses itens até lá. EU_HOSTING_CONFIRMED permanece false e não é condição de abertura por decisão do dono; a retirada técnica da dependência está em TX2. A conferência de DPF/SCC dos fornecedores atuais segue no Bloco de abertura, sem aceitar termos ou contratar.


Solicitação do dono (27/10/2026, 08h00, horário de Fortaleza).467[SR1], regra permanente em vigor desde a solicitação.

## Regra vigente

Quando respostas do Stripe se contradisserem, vale a resposta **menos favorável ao dono**, até que uma resposta posterior, completa e sem contradição, a substitua. Não escolher somente uma frase favorável, um formulário, uma configuração de API ou um resultado sintético.

## Respostas relatadas pelo dono e aplicação

| Ponto | Resposta anterior relatada | Resposta posterior relatada | Leitura vinculante atual |
| --- | --- | --- | --- |
| Plataforma brasileira conecta criadores fora do Brasil? | Suporte09/10/2026: somente contas no Brasil | Vendas19/10/2026: pode conectar contas no exterior | **Não. Conta BR conecta somente criadores BR.** |
| Conta US de LLC de sócio único residente no Brasil exige SSN ou ITIN? | Suporte11/10/2026: passaporte/CPF bastam, ITIN em geral não necessário | Vendas19/10/2026: exige SSN ou ITIN | **Exige SSN ou ITIN.** |
| Representante legal nos EUA e residência | Vendas19/10/2026: exige representante legal nos EUA | Sem resposta sobre necessidade de residência | **Exige representante residente nos EUA**, por leitura menos favorável, não por resposta expressa sobre residência. |
| Endereço nos EUA | Vendas19/10/2026: real, sem caixa postal | Nenhuma resposta posterior completa fornecida | **Endereço comercial real nos EUA, sem caixa postal.** |

Em27/10/2026 o dono informou ter enviado novo e-mail ao Stripe pedindo resposta única e definitiva sobre os quatro pontos. A resposta ainda não foi fornecida nesta conversa. Só substitui a leitura acima se posterior, completa e sem contradição; guardar data, prova e avaliação por ponto. Não presumir aprovação pelo silêncio.

Proveniência: relato direto do dono recebido no anexo f7d707c3-e3bf-4b2b-9a12-9e73f93db20f/Texto colado.txt, reproduzido integralmente na fila467–470 peloPR1090. Não acessamos os e-mails/formulários originais, não consultamos a conta Stripe e não contatamos suporte/vendas. As datas são as relatadas pelo dono. Esta tabela é política operacional conservadora, não certificação de lei, termos, elegibilidade ou aceite real do Stripe.

## Limites da configuração existente

A configuração de lib/stripe-connect.ts com dashboard completo e responsabilidades de taxas/perdas atribuídas ao Stripe descreve o payload da API. A lista COUNTRIES descreve a oferta/validação histórica do formulário; **nenhuma delas prova que a plataforma atual pode conectar esses países**. Testes com respostas sintéticas provam a construção de pedidos, sem abrir conta ou estabelecer aceite de país/empresa.

Para o planejamento atual, conta BR não habilita criadores no exterior. Não tratar passaporte/CPF isolados como dispensa de SSN/ITIN para a contaUS. Um registered agent deDelaware não é automaticamente representante legal residente aceito peloStripe. Um mailbox ou endereço virtual cotado não é prova de endereço comercial real aceito. Os três representantes GDPR/DSA deFX275 não substituem esse representanteStripe sem evidência. Não reutilizar preço de serviço distinto como preço comprovado do requisito.

## Dependências que continuam fechadas

468[SR2] deve acrescentar condição de abertura com conta Stripe de plataforma **em nome da empresa americana**, com data/prova de aptidão para conectar criadores nosEUA,Canadá,ReinoUnido eEuropa com cobranças diretas. Este documento não implementa essa condição e não confirma conta, aptidão ou país. PLANS_ON_SALE continua false; nenhuma outra condição enfraquece.

469[SR3] pesquisa somente fontes oficiais datadas paraW-7/ITIN, agente de aceitação se aplicável, representante residente aceito, endereço real e demais custos; soma mensal/anual100%MarktmorgenFX275 e recalcula base mínima. Não há orçamento oficial ou preço aprovado neste documento. Custos/aceite/cobertura desconhecidos reprovam, nunca são zero. O registro não torna obrigatório contratar um serviço opcional sem analisar a fonte e a necessidade.

470[SR4] fica em Depende do dono como roteiro em português: LLC→EIN→ITIN→representante/endereço→contaStripe, com documentos, prazos oficiais e custos deSR3. Só roteiro; nenhuma etapa executada.

## Margem, autorizações e VR

Aplica-se a [REGRA DE MARGEM MR](../AGENTS.md#mr--regra-de-margem-vigente-27-de-outubro-de-2026), não o piso revogado de60%. Cliente isolado100%direitos mensal/anual/complementos com lucro líquido positivo e folga do spend floor; empresa sem prejuízo a partir da base mínima com100%custosFX275 e exposições;60%meta da margem real mensal. ISS5%, leitura tributária mais onerosa, recebimento mais caro, reservas e custeio continuam. Sem preço novo, corte de limite, comissão, conta, termo, contrato, pagamento, terceiro, exclusão ou mudança de gate.

VR: registro documental de467[SR1] em andamento;468–470na fila. Passa a existir tabela datada e limite explícito para interpretar configuração/testes; nada novo disponível ao cliente. Não funcionam por este registro a nova condição de abertura, pesquisa de custos, base mínima, roteiro ou relatório de margem. Não verificados e-mails originais, resposta futura, conta/aceite real, fontes/prazos/preços oficiais e funcionamento comercial. Sem alegação de lucro certificado.

Custos incrementais de produção desta documentação/comentário: nenhuma chamada, serviço, dado persistido ou retenção adicional;Store mensal/anual0/0,Studio0/0,Scale0/0. Isso não é custo total zero deCI, hospedagem,LLC ou requisitosSR3. Todos os desconhecidos permanecem reprovados. Acessibilidade: Markdown com títulos/tabela/links e texto explícito, nenhuma tela;0→0passos/decisões do cliente;sem auditoria humana ou certificação.


## SD — Decisão: abertura pela LLC americana e conta Stripe americana (28/10/2026) [SD1]

Solicitação direta do dono: 28/10/2026, 18h41, Fortaleza. Estado inicial: na fila, execução imediata. Esta decisão é posterior a 495 [SR6]/PR1175 e [AV1] e prevalece onde divergir, sem renumerar itens nem apagar histórico.

### Decisão vigente e ordem
- **495 [SR6], Depende do dono: decisão TOMADA.** O dono leu a recomendação brasileira do PR1175 e escolheu abertura pela LLC de Delaware, com conta Stripe de plataforma americana em nome dela. A conta brasileira não será usada na abertura. O estudo e a recomendação anterior ficam preservados como histórico. A quantificação restante de495 fica exclusivamente na rota LLC, em275 [FX1], passo6 deAV1; não quantificar a rota brasileira.
- **Novo passo1 de [AV1]: 470 [SR4].** Produzir somente documento: roteiro exato das ações exclusivas do dono, com fontes oficiais datadas, custos e nomes dos campos/botões, para abertura Delaware, agente registrado, EIN sem SSN, endereço comercial real nos EUA sem caixa postal, banco no nome exato da LLC, conta Stripe americana e prova exigida por stripePlatformEligibilityReady. Colocar as ações em “Depende do dono”; nenhum ato externo executado. Custos fixos em275FX1, 100%Marktmorgen.
- Passo2 deAV1: conferência da exigência americana abaixo, sem mudança de trava. Restante deAV1 eAV2 preservado na mesma ordem. PR1178 já em verificação continua; trabalho de Claude/PR1173 preservado.

### Resposta Stripe e pergunta pendente
Proveniência: relato direto do dono, resposta Stripe de28/10/2026 às13h55 Fortaleza no fio “Re: Connect platform eligibility for international accounts”, conferida pelo Claude no Gmail do dono. Codex não afirma nova leitura independente do Gmail. Nenhum identificador de conta é copiado.
(a) Conta brasileira cobra assinatura em dólar somente com Visa e Mastercard emitidos fora do Brasil.
(b) Repasse somente em reais, com conversão.
(c) Taxa publicada:3,99% +R$0,39, mais2% para cartão internacional.
(d) Stripe Tax em cobranças diretas de contas Standard conectadas é cobrado da conta conectada/do criador, não da plataforma; isso não pode ser mudado. Nas faturas próprias da plataforma, a taxa pertence à plataforma.
(e) Não é necessário registro comoISO/PayFac e aStripe não aprova negócios antecipadamente.
**494 [SR5]: pendência sobre quem paga Stripe Tax ENCERRADA por esta resposta**, preservado o registro anterior. Não equivale a aprovação de conta, país ou abertura.

**Pendente à Stripe:** em28/10/2026 às18h37 Fortaleza, no mesmo fio, o dono perguntou se plataforma americana pode conectar contas Standard do Brasil, Índia e de cada um dos43países deCOUNTRIES emlib/stripe-connect.ts, com cobrança direta, sem taxa de aplicação e painel completo. Aguardar resposta em pedido próprio. Não acrescentar/retirar países nem prometer países em texto novo.

### Conferência concreta no main6400f9492ba3e31537b71ca72c430de9f74b48e3
lib/stripe-platform-eligibility.ts exige platformCountry=US,companyCountry=US,accountInCompanyName=true,accountActive=true e prova datada vinculada à mesma conta/empresa; exige também provas de elegibilidade para cobranças diretas. A revisão real permanece null. tests/stripe-platform-eligibility.test.ts rejeita plataformaBR, empresaBR, conta pessoal/inativa, prova ausente/futura/inválida e divergência de conta/empresa. lib/opening.ts mantém a condição adicional e ambas as flagsfalse. **Sem alteração de código ou testes**: o requisito deSD1 já está presente; isto é inspeção dos testes existentes, não alegação de nova execução.

lib/receiving-costs.ts mantém taxBps=50 (0,5%) no recebimento das assinaturas próprias doMarktmorgen. tests/plan-cost-model.ts aplica receivingOf aos preços dos planos/complementos e lib/store-assistant-rules.ts à assinatura própria do assistente. lib/store-checkout.ts cria checkout de vendas dos criadores via onAccount; lib/tax.ts consulta/configura a própria conta conectada. components/tax-editor.tsx e lib/help-content.ts dizem expressamente que Stripe cobra Stripe Tax na conta do criador. Não identificado cálculo que transforme essa taxa das vendas dos criadores em custo doMarktmorgen na conferência dessas rotas/consumidores. **Sem alteração de cálculo, documento gerado ou regeneração desnecessária**; os0,5% das próprias assinaturas ficam preservados.


## SC1 — Resposta da Stripe sobre os países dos criadores (28/10/2026, 19h37 Fortaleza)

Proveniência: resposta da Stripe (Gabriel) no fio "Re: Connect platform eligibility for international accounts", recebida em 28/10/2026 às 19h37 (Fortaleza), conferida pelo Claude no Gmail do dono, com o texto igual ao relatado pelo dono às 23h50. Responde à pergunta pendente de 18h37. Nenhum identificador de conta é copiado. É a visão padrão da Stripe para uma plataforma americana; não é aprovação de conta, país ou abertura.

Configuração perguntada: plataforma americana; cada criador conecta a própria conta Standard (painel completo); toda venda é cobrança direta na conta do criador; nenhuma taxa de aplicação; a assinatura do Marktmorgen é cobrada na conta da plataforma. A Stripe disse que cobrar a assinatura não muda quais países podem conectar.

1. Disponível (42 países): Estados Unidos, Reino Unido, Canadá, Austrália, Irlanda, Nova Zelândia, Áustria, Bélgica, Bulgária, Croácia, Chipre, República Tcheca, Dinamarca, Estônia, Finlândia, França, Alemanha, Gibraltar, Grécia, Hong Kong, Hungria, Itália, Japão, Letônia, Liechtenstein, Lituânia, Luxemburgo, Malta, México, Países Baixos, Noruega, Polônia, Portugal, Romênia, Singapura, Eslováquia, Eslovênia, Espanha, Suécia, Suíça, Tailândia e Emirados Árabes Unidos.
2. Não disponível: Malásia (cobrança direta indisponível para plataforma americana). Retirada de COUNTRIES em lib/stripe-connect.ts; tests/connect-configuration.test.ts impede a volta.
3. Brasil: cobrança direta de contas brasileiras conectadas a plataforma americana está em beta público, não disponível de forma geral. Depois que a conta americana existir, o dono responde no mesmo fio para a Stripe conferir a liberação. Contas brasileiras têm restrições de pagamento internacional e conversão de moeda (exceto Visa e Mastercard emitidos fora do Brasil), que podem limitar recursos do Connect. Não oferecido.
4. Índia: cobrança direta disponível e taxa de aplicação indisponível para plataforma de fora da Índia; contas Stripe na Índia só por convite (https://stripe.com/in/contact/sales). Não oferecido.
5. Emirados Árabes Unidos: o criador pode ter de informar dados de registro fiscal no cadastro da Stripe.
6. Em todos os países: o criador só conecta se puder abrir conta Stripe no próprio país; a Stripe pode pedir documentos ou analisar a conta conforme o país e o tipo de negócio; a lista deve ser conferida contra a conta real da plataforma quando ela existir.

Passos do dono para depois da conta americana existir (a incluir no roteiro 470 [SR4], em "Depende do dono"): responder no mesmo fio pedindo a liberação do beta de cobrança direta para contas brasileiras; pedir a conferência da lista de países contra a conta real da plataforma. Nenhum contato é feito por agente.
