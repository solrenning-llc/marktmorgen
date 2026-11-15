# GD2(a) — Identificação de vendedores: fontes e enquadramento pendente

Conferência: 10/11/2026, Codex CX4. Estudo interno do 568 [GD2](a). Nenhuma coleta ou divulgação foi implementada. Não é aprovação jurídica nem conclusão sobre obrigação real da LLC. O teste conserva estas ressalvas; não certifica a lei.

## Estados das fontes oficiais

| Fonte | Versão lida e limite |
| --- | --- |
| [15 U.S.C. § 45f](https://uscode.house.gov/us/usc/119-120/t15/s45f/) | Texto do OLRC até Public Law 119-120, 07/10/2026; lidos (a), (b) e (f). A URL preliminar alternativa retornou 404; esta versão datada abriu. |
| [FTC, INFORMAct](https://www.ftc.gov/business-guidance/resources/INFORMAct) | Orientação de junho de 2023, com nota de edição de janeiro de 2025. Uma tentativa expirou; a leitura pela URL descritiva da FTC abriu o mesmo texto. Não se adota o valor de multa como parâmetro atual. |
| [Regulamento (UE) 2022/2065](https://eur-lex.europa.eu/eli/reg/2022/2065/oj/eng) | Ato de 19/10/2022, JO de 27/10/2022; lidos considerandos 7–15 e arts. 29–30 no texto oficial. Não é conferência de todas as normas europeias. |
| 16 CFR § 700.1 | O eCFR apresentou bloqueio automatizado. Inteiro teor não obtido; não se descreve como fonte lida. A remissão existe no § 45f(f)(2), e a explicação abaixo sobre bens tangíveis vem da FTC. |

## EUA: condições antes da obrigação

O § 45f(f)(3) exige 200 transações E US$ 5.000 de receita bruta, em 12 meses contínuos nos 24 meses anteriores, de produtos novos ou não usados. Contam vendas da plataforma com pagamento processado por ela ou por seu processador. Não é limite anual de calendário. A definição de marketplace também exige as condições cumulativas de (f)(4), inclusive relação contratual ou semelhante com consumidores; (f)(6) contém exclusões de vendedores. [Fonte: § 45f(f)](https://uscode.house.gov/us/usc/119-120/t15/s45f/).

A FTC explica o alcance de consumer products como bens tangíveis de uso pessoal, familiar ou doméstico. Inferência para este estudo: não se deve contar automaticamente todo curso digital como produto físico nem presumir exclusão de toda a plataforma porque ela oferece digitais. A oferta de físicos exige exame próprio. [Fonte: FTC, definição de marketplace](https://www.ftc.gov/business-guidance/resources/INFORMAct).

Se aplicável, § 45f(a) distingue coleta e verificação em dez dias, atualização anual e suspensão após aviso e oportunidade de regularização em dez dias. § 45f(b)(1) distingue divulgação para vendedor de alto volume com US$ 20.000 anuais, sujeita às exceções de (b)(2). Há canal eletrônico e telefônico de denúncia em (b)(3), limitação de finalidade e segurança em (a)(3)–(4). Não publicar indiscriminadamente documentos de identidade. [Fonte: § 45f(a)–(b)](https://uscode.house.gov/us/usc/119-120/t15/s45f/).

## UE: art. 29 antes do art. 30

O art. 29 exclui micro e pequenas empresas da seção 4, com regra de transição e exceção para plataformas designadas de muito grande dimensão. Não confundir com o art. 19. O porte real não foi comprovado; não há exclusão certificada para a LLC.

Se a seção for aplicável, o art. 30 exige informações do comerciante antes da oferta a consumidores na União: contato, identificação, conta de pagamento, registro quando existente e autodeclaração. Exige esforços de conferência de completude e confiabilidade. Correção precede suspensão nos casos do n.º 3; o n.º 4 prevê reclamação. O n.º 5 exige guarda segura até seis meses após o fim da relação e posterior exclusão; o n.º 7 torna públicos apenas os grupos (a), (d) e (e), sem transformar identificação e conta bancária em dados públicos.

O enquadramento territorial e funcional também depende dos fatos: os considerandos 7–15 distinguem direcionamento à União, acesso meramente técnico e hospedagem/plataforma. Nenhuma conclusão sobre estabelecimento, tributação ou art. 9a decorre disso. [Fonte: Regulamento 2022/2065](https://eur-lex.europa.eu/eli/reg/2022/2065/oj/eng).

## O que o código prova e o que falta

`lib/catalog.ts` distingue produtos físicos; isso sozinho não comprova vendas físicas a consumidores americanos nem enquadramento legal. `lib/stripe-connect.ts`, `AccountState` e `readAccount`, fornece estados operacionais como `chargesEnabled` e `detailsSubmitted`: ativação da Stripe não comprova cumprimento do INFORM ou do DSA. O acesso aos campos exigidos não foi comprovado. Não se acessou conta real, documento de pessoa, contrato do processador ou configuração de fornecedor.

Faltam provas do catálogo e mercados efetivos, relação contratual com compradores, contagem legal por vendedor, porte empresarial com vínculos pertinentes e dados acessíveis sob permissões reais. Não há neste recorte inventário integral dos mecanismos de identificação existentes; não se declara que nada deles exista. Os arquivos apontados são localização de fatos limitados, sem atestado de conformidade.

## Depende do dono

Registrar os fatos empresariais e comerciais ausentes para futuro enquadramento, sem pedir documentos pessoais no canal. A escolha de uma coleta, se legalmente necessária, exige antes desenho de minimização, acesso, finalidade, retenção, exclusão, aviso, contestação e custo coberto. Nenhuma consulta será feita ou preparada para envio. Nenhum contrato ou termo será aceito; nenhum fornecedor será contatado.

Só uma etapa futura, com fontes e fatos suficientes, poderá implementar o que for aplicável. O custo desconhecido nunca é zero; verificação, armazenamento e avisos exigem teto e reserva antes do gasto. Este estudo não acrescenta chamada produtiva, chave, retenção, formulário ou declaração pública. Não calcula lucro. PLANS_ON_SALE e OPENING_REQUESTED permanecem false; preços, limites, comissão e travas permanecem os vigentes. Acessibilidade: 0 → 0 passos ou decisões de interface; nenhuma verificação humana presumida.
