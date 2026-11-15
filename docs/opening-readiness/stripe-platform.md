# Trava 2 — Elegibilidade da plataforma Stripe: o que o dono precisa provar

Preparado em 14/11/2026 pelo Claude 1 cloud A, só como documento. **Não liga nada**: não muda `CURRENT_STRIPE_PLATFORM_ELIGIBILITY_REVIEW` (continua `null`), `stripePlatformEligibilityReady()` (continua `false`), `PLANS_ON_SALE`, `OPENING_REQUESTED`, preços, limites, comissão, tax gate, art. 9a nem a revisão comercial. Nenhum agente cria conta, aceita termos, paga ou contata o Stripe.

**Estado das fontes.** Em 14/11/2026, a rede desta sessão recusou o Stripe. Em 15/11/2026, depois de o dono liberar `*.stripe.com`, foram lidas na versão Markdown oficial de docs.stripe.com, que não mostra data editorial: `get-started/account/activate`, `connect/charges`, `connect/direct-charges` (variante Stripe-hosted), `connect/cross-border-payouts`, `connect/platform-pricing-tools`, `connect/standard-accounts`, `connect/accounts`, `connect/account-capabilities` (Accounts v1) e `connect/dashboard`. O que não foi lido continua marcado **"a conferir na fonte oficial (URL), data de leitura pendente"**: `stripe.com/global` (o domínio raiz `stripe.com` continuou recusado pelo proxy), a página de status da conta (`get-started/account/statuses` deu 404) e os contratos. A lista está na seção 6.

## 1. O que o código exige (lido em `lib/stripe-platform-eligibility.ts`, main `3e71d00a`, 14/11/2026)

O registro `StripePlatformEligibilityReview` tem uma parte `platform` e uma parte `regions`, com quatro regiões obrigatórias: `US`, `CA`, `GB` e `EUROPE`. A função `stripePlatformEligibilityReady()` só devolve `true` se **todas** as condições abaixo forem verdadeiras.

### 1.1 Regras gerais do registro

| Campo | Exigência do código | Em português |
| --- | --- | --- |
| `schema` | `1` | Versão fixa do registro. |
| `reviewedOn` | dia real `AAAA-MM-DD`, **a partir de 2026-10-27** e não depois de hoje | Data em que o dono revisou as provas. |
| chaves extras ou faltando | recusado | O registro tem exatamente estes campos, nem mais nem menos. |
| getters, protótipos, Proxy | recusado | O registro é dado puro, escrito no código pelo dono. Nenhuma rota aceita prova enviada por visitante. |

### 1.2 Provas da conta da plataforma (`platform`)

| # | Prova | Campo e valor exigido | Observação |
| --- | --- | --- | --- |
| P1 | A conta é uma **plataforma nos EUA** | `platformCountry: "US"` | País da conta Stripe. |
| P2 | A empresa dona da conta é **dos EUA** | `companyCountry: "US"` | A LLC de Delaware. |
| P3 | A conta está **no nome da empresa** | `accountInCompanyName: true` | Razão social igual ao nome exato da LLC, não a pessoa física do dono. |
| P4 | A conta está **ativa** | `accountActive: true` | Ativada para receber pagamentos e fazer repasses, sem pendências. |
| P5 | A prova vem **da própria conta** | `source: "stripe-platform-account"` | Para a plataforma, uma confirmação por e-mail **não basta**: o código exige o registro da conta. |
| P6 | Referências opacas | `accountReferenceSha256` e `companyReferenceSha256`: 64 caracteres hexadecimais, **diferentes entre si** | Nunca a chave, uma URL privada, o SSN, o ITIN, um identificador pessoal ou o hash de um identificador pessoal. |
| P7 | Arquivo da prova | `evidenceSha256`: SHA-256 do arquivo guardado pelo dono | Por exemplo, o PDF ou a captura da página do painel. |
| P8 | Data da prova | `recordedOn`: dia real, não posterior a `reviewedOn` | |

### 1.3 Provas por região dos criadores (`regions.US`, `regions.CA`, `regions.GB`, `regions.EUROPE`)

Cada uma das quatro regiões precisa de um registro com os mesmos campos de prova, mais:

| # | Prova | Campo e valor exigido |
| --- | --- | --- |
| R1 | A região certa | `region` igual à chave (`"US"`, `"CA"`, `"GB"` ou `"EUROPE"`) |
| R2 | **Cobranças diretas** possíveis para criadores daquela região | `directChargesEligible: true` |
| R3 | Origem da prova | `source: "stripe-platform-account"` **ou** `"stripe-written-confirmation"` (aqui o e-mail escrito do Stripe é aceito) |
| R4 | Mesma conta e mesma empresa | `accountReferenceSha256` e `companyReferenceSha256` iguais aos de `platform` |
| R5 | Arquivo e data | `evidenceSha256` válido; `recordedOn` não posterior a `reviewedOn` |

`EUROPE` não é reduzida silenciosamente à UE (docs/stripe-platform-opening-gate.md). A prova de `EUROPE` deve dizer quais países europeus estão cobertos (seção 3.4).

## 2. Onde o dono encontra cada prova no painel do Stripe

Os endereços do painel marcados "lido em 15/11/2026" aparecem com esse caminho na documentação oficial lida nesse dia. Os outros estão a conferir. O painel pode mudar; vale o que a página oficial disser no dia da prova.

| Prova | Onde olhar no painel | O que deve aparecer | Fonte oficial |
| --- | --- | --- | --- |
| P1 país da conta | Verificação da empresa: `dashboard.stripe.com/account/onboarding` (lido em 15/11/2026) | País de origem da empresa: Estados Unidos. "After activating a Stripe service on a live account, you can't change the business origin country. To use a different supported country as your primary business location, create a new account." | [Activate your account](https://docs.stripe.com/get-started/account/activate), lida em 15/11/2026, sem data editorial |
| P2 e P3 empresa e nome | A mesma verificação (`dashboard.stripe.com/account/onboarding`) para os dados da empresa; dados públicos em `dashboard.stripe.com/settings/public` (lido em 15/11/2026) | Tipo de empresa: Company / LLC de sócio único; **nome legal da empresa** igual ao nome exato da LLC; EIN informado; endereço comercial real nos EUA, sem caixa postal nem escritório virtual (resposta do Stripe de 03/11/2026, em docs/stripe-platform-eligibility.md). O nome dos campos na tela continua a conferir. | Mesma página, lida em 15/11/2026; o nome dos campos é a conferir no painel |
| P4 conta ativa | Página inicial do painel e status da conta | Pagamentos e repasses ativados, sem informação pendente | **A conferir**: https://docs.stripe.com/get-started/account/statuses deu 404 em 15/11/2026; ler a página que a substituiu |
| P5 plataforma Connect | Perfil da plataforma: `dashboard.stripe.com/connect/profile`; configurações de capacidades: `dashboard.stripe.com/settings/connect/capability-settings`; interface de cadastro: `dashboard.stripe.com/settings/connect/onboarding-interface` (todos lidos em 15/11/2026) | Perfil da plataforma concluído; contas conectadas com acesso ao painel completo (Standard) | [Account capabilities, Accounts v1](https://docs.stripe.com/connect/account-capabilities?accounts-namespace=v1) e [Connect dashboard](https://docs.stripe.com/connect/dashboard), lidas em 15/11/2026 |
| R1–R3 países dos criadores | Não há, nas páginas lidas, uma lista de países de cadastro para contas Standard | — | **A conferir**; https://stripe.com/global continuou recusado pelo proxy em 15/11/2026 |
| R2 por conta real | Connect → Contas → abrir a conta de um criador de cada região | País da conta; capacidade `card_payments` **ativa**. "Your connected accounts must have the card_payments capability active in order to use direct charges." "For an Account to have the card_payments capability, you must request both card_payments and transfers." Uma cobrança direta de teste aparece no painel do criador. | [Charge types](https://docs.stripe.com/connect/charges) e [Account capabilities, v1](https://docs.stripe.com/connect/account-capabilities?accounts-namespace=v1), lidas em 15/11/2026 |
| Taxa de aplicação recebida | Taxas recebidas: `dashboard.stripe.com/connect/application_fees` (lido em 15/11/2026) | As taxas de aplicação de cada cobrança direta | [Create direct charges](https://docs.stripe.com/connect/direct-charges?platform=web&ui=stripe-hosted), lida em 15/11/2026 |
| R3 confirmação escrita | E-mail do Stripe Support no fio "Re: Connect platform eligibility for international accounts", **depois** de a conta americana existir | Resposta que cite a conta da LLC e diga, região por região, que cobranças diretas para contas Standard estão disponíveis | Rota de contato: https://support.stripe.com/contact — só leitura; **nenhum agente envia mensagem** |
| Contrato | Configurações → Jurídico / Contrato de serviços (Stripe Services Agreement e Connect Platform Agreement) | Entidade Stripe dos EUA contratante | https://stripe.com/legal/ssa e https://stripe.com/legal/connect-account — a conferir, data de leitura pendente; o dono lê e aceita, nenhum agente aceita termos |

**Comprovante para baixar.** Não encontrei, no repositório, uma fonte oficial que diga se o Stripe oferece uma carta ou um PDF de confirmação da conta. Até a leitura (seção 6), o caminho seguro é o dono salvar em PDF cada página acima, no dia, e gravar o SHA-256 de cada arquivo (P7, R5). O arquivo fica com o dono, fora do repositório, porque mostra dados da empresa.

## 3. Cobranças diretas para criadores de cada região

O que o repositório já registra, com a data de cada leitura. **Nada disso é prova da conta da LLC**, que ainda não existe; o código continua exigindo a prova real.

### 3.1 O que a documentação pública diz (lida por outra sessão em 13/11/2026)

Registro no ramo `claude2/eu-vat-official-sources`, arquivo `docs/eu-vat-official-sources-2026-11-13.md`, seção 6.1, lido em docs.stripe.com, na versão Markdown oficial, em 13/11/2026:

- [Charge types](https://docs.stripe.com/connect/charges): na cobrança direta, "Funds always settle in the country of the connected account". As restrições de região de [cross-border payouts](https://docs.stripe.com/connect/cross-border-payouts) valem para cobranças de destino e para cobranças e transferências separadas, não para a cobrança direta.
- [Create direct charges](https://docs.stripe.com/connect/direct-charges): a única restrição de país encontrada é a do Brasil ("platforms based outside of Brazil with Brazilian connected accounts can't collect application fees through Stripe").
- [Using Standard connected accounts](https://docs.stripe.com/connect/standard-accounts): Standard aparece como tipo v1 legado ("Deprecated feature"); para integração nova, o Stripe indica Accounts v2. **Ponto de risco para o dono:** a prova deve dizer que as cobranças diretas valem para o tipo de conta conectada que o Marktmorgen usa de fato.
- Conclusão daquela leitura: a documentação **não afirma** região por região que uma plataforma dos EUA pode fazer cobranças diretas em contas Standard do Canadá, do Reino Unido e do EEE. Isso depende de conta real ou de resposta escrita.

**Releitura em 15/11/2026** (docs.stripe.com, versão Markdown, sem data editorial). As frases acima continuam lá, e há mais três pontos:

- [Charge types](https://docs.stripe.com/connect/charges): "Funds always settle in the country of the connected account." "Direct charges aren't recommended for legacy v1 Express and Custom accounts—switch to v2 accounts, or use destination charges". A frase não fala das contas Standard.
- [Connect cross-border payouts](https://docs.stripe.com/connect/cross-border-payouts): "Platforms based in the US, UK, EEA, Canada, or Switzerland can transfer funds to connected accounts in any of those regions". Os fluxos cobertos são cobranças e transferências separadas, *top-ups* e cobranças de destino sem `on_behalf_of`; **a cobrança direta não está na lista**, porque nela o dinheiro já liquida na conta do criador.
- [Create direct charges](https://docs.stripe.com/connect/direct-charges?platform=web&ui=stripe-hosted): a única restrição de país à taxa de aplicação continua sendo a do Brasil. [Platform pricing tools](https://docs.stripe.com/connect/platform-pricing-tools): "Your platform is permitted to charge app fees in the connected account's country", sem lista de países.
- **Risco novo para o dono:** [Using Standard connected accounts](https://docs.stripe.com/connect/standard-accounts) e [Connect account types](https://docs.stripe.com/connect/accounts) marcam os tipos Standard, Express e Custom como "Deprecated feature": a página "applies only to platforms that already use legacy connected account types". Para plataforma nova, o Stripe indica Accounts v2. A conta americana da LLC será uma plataforma nova. O dono precisa obter do Stripe, por escrito, que ela pode conectar contas Standard (ou o equivalente em v2 com painel completo) com cobranças diretas. Se não puder, a integração muda, e isso é trabalho de engenharia com revisão própria, fora desta trava.

### 3.2 O que o Stripe respondeu por escrito (28/10/2026)

docs/stripe-platform-eligibility.md, seção SC1: resposta do Stripe de 28/10/2026, 19h37 (Fortaleza), conferida no Gmail do dono. É a visão padrão do Stripe para uma plataforma americana com contas Standard, cobranças diretas e sem taxa de aplicação. **Não é aprovação de conta**, e o próprio Stripe pediu para conferir a lista contra a conta real.

| Região do código | Países que o Stripe disse disponíveis em 28/10/2026 | Fora da lista |
| --- | --- | --- |
| `US` | Estados Unidos | — |
| `CA` | Canadá | — |
| `GB` | Reino Unido | — |
| `EUROPE` | Áustria, Bélgica, Bulgária, Croácia, Chipre, República Tcheca, Dinamarca, Estônia, Finlândia, França, Alemanha, Gibraltar, Grécia, Hungria, Irlanda, Itália, Letônia, Liechtenstein, Lituânia, Luxemburgo, Malta, Países Baixos, Noruega, Polônia, Portugal, Romênia, Eslováquia, Eslovênia, Espanha, Suécia e Suíça | **Islândia** não aparece (SR5 também a excluía) |

Os outros países da mesma resposta (Austrália, Hong Kong, Japão, México, Nova Zelândia, Singapura, Tailândia, Emirados Árabes Unidos) não são regiões exigidas pelo código. Malásia: cobrança direta indisponível. Brasil: beta. Índia: só por convite.

### 3.3 Criadores e compradores são coisas diferentes

A meta do dono de 14/11/2026, 16h (Fortaleza) é **vender**, no 1º dia, para compradores dos EUA, do Canadá, da UE, do Reino Unido e de qualquer país que os EUA não proíbam. Isso trata dos **compradores**. As regiões desta trava tratam dos **criadores**, isto é, de onde fica a conta Stripe conectada. Um comprador no Japão pode comprar de um criador nos EUA. A recusa de compradores de países sancionados e o tratamento de imposto por país do comprador estão em [deemed-supplier.md](deemed-supplier.md).

### 3.4 O que o dono precisa obter para cada região

1. **US:** conta Standard de um criador nos EUA conectada à plataforma da LLC, com `card_payments` ativa, e uma cobrança direta registrada no painel. Fonte: `stripe-platform-account`.
2. **CA, GB e EUROPE:** o mesmo, com um criador de cada região, **ou** a resposta escrita do Stripe, depois de a conta da LLC existir, confirmando cobranças diretas para contas conectadas no Canadá, no Reino Unido e em cada país europeu. Fonte: `stripe-written-confirmation`. Para `EUROPE`, a resposta deve listar os países (por exemplo, os 31 acima). A falta de um país não pode ser presumida como aceitação.
3. Guardar, de cada prova: a data, o PDF e o SHA-256.
4. **Prova extra, fora deste registro, mas necessária para a trava 3:** que a plataforma pode cobrar **taxa de aplicação** (`application_fee_amount`) em cobranças diretas nas contas conectadas do Canadá, do Reino Unido e de cada país europeu. É por ela que o Marktmorgen receberia o IVA ou o sales tax que deve como fornecedor ([deemed-supplier.md](deemed-supplier.md), seção 2, item 3). A leitura de 13/11/2026 não confirmou essa permissão: a documentação só exclui o Brasil e diz que a permissão depende do país da conta conectada.

## 4. Rascunho do registro, para o dono preencher (não vai para o código)

Valores entre `<...>` são do dono. **Não copiar para `lib/` sem prova real**; um registro preenchido com dados de exemplo só engana a trava.

```ts
// RASCUNHO, somente documento. Não colar em lib/stripe-platform-eligibility.ts sem a prova real.
const review: StripePlatformEligibilityReview = {
  schema: 1,
  reviewedOn: "<AAAA-MM-DD, a partir de 2026-10-27, não depois de hoje>",
  platform: {
    accountReferenceSha256: "<64 hex: referência opaca da conta da plataforma>",
    companyReferenceSha256: "<64 hex: referência opaca da LLC, diferente da anterior>",
    recordedOn: "<AAAA-MM-DD>",
    evidenceSha256: "<64 hex: SHA-256 do PDF das páginas P1–P5>",
    source: "stripe-platform-account",
    platformCountry: "US", companyCountry: "US",
    accountInCompanyName: true, accountActive: true,
  },
  regions: {
    US:     { region: "US",     directChargesEligible: true, source: "stripe-platform-account",     recordedOn: "<...>", evidenceSha256: "<...>", accountReferenceSha256: "<igual>", companyReferenceSha256: "<igual>" },
    CA:     { region: "CA",     directChargesEligible: true, source: "<stripe-platform-account | stripe-written-confirmation>", recordedOn: "<...>", evidenceSha256: "<...>", accountReferenceSha256: "<igual>", companyReferenceSha256: "<igual>" },
    GB:     { region: "GB",     directChargesEligible: true, source: "<...>", recordedOn: "<...>", evidenceSha256: "<...>", accountReferenceSha256: "<igual>", companyReferenceSha256: "<igual>" },
    EUROPE: { region: "EUROPE", directChargesEligible: true, source: "<...>", recordedOn: "<...>", evidenceSha256: "<...>", accountReferenceSha256: "<igual>", companyReferenceSha256: "<igual>" },
  },
};
```

Como gerar o SHA-256 de um arquivo salvo (no computador do dono): `shasum -a 256 arquivo.pdf` (macOS/Linux) ou `certutil -hashfile arquivo.pdf SHA256` (Windows). A referência opaca da conta pode ser o SHA-256 de um texto que o dono guarda fora do repositório; ela não pode ser o hash do SSN, do ITIN, do CPF ou do passaporte.

## 5. Ordem dos passos do dono (nenhum é feito por agente)

1. LLC constituída, EIN, endereço comercial real nos EUA e banco nos EUA no nome exato da LLC (docs/opening-readiness-status-2026-11-11.md, grupo A, itens 1 a 3).
2. Conta Stripe dos EUA no nome da LLC, ativada (P1–P4). Guardar qualquer mensagem que peça SSN ou ITIN (SR5).
3. Connect configurado, perfil da plataforma aprovado, contas Standard (P5). O Stripe disse em 03/11/2026 que a conta americana terá nova análise do perfil e que a aprovação de setembro da conta brasileira não passa para ela.
4. Provas por região (seção 3.4).
5. Salvar os PDFs, gerar os SHA-256 e preencher o rascunho da seção 4.
6. Pedir a um agente o PR que grava o registro em `lib/stripe-platform-eligibility.ts`, com revisão independente. Só então esta trava fica verdadeira; as outras continuam valendo.

## 6. URLs que ainda precisam ser lidas

Lidas em 15/11/2026 (seções 2 e 3): activate, charges, direct-charges, cross-border-payouts, platform-pricing-tools, standard-accounts, accounts, account-capabilities (v1) e dashboard. Faltam as seguintes; para cada uma, o trecho exato, a data editorial, se houver, e a data de leitura:

1. A página que substituiu https://docs.stripe.com/get-started/account/statuses, que deu 404: status da conta e pendências.
2. https://stripe.com/global: países em que um criador pode abrir conta. O domínio raiz foi recusado pelo proxy; ler de outra sessão ou liberar `stripe.com`.
3. https://support.stripe.com/questions/how-do-i-update-my-business-information: nome legal e EIN no painel.
4. https://docs.stripe.com/connect/accounts-v2: se uma plataforma nova ainda pode usar contas Standard e cobranças diretas, ou qual configuração v2 equivale a elas.
5. https://stripe.com/legal/ssa e https://stripe.com/legal/connect-account: entidade contratante. Só leitura; o dono é quem aceita.
6. Uma página oficial sobre carta ou PDF de comprovação da conta, se existir.

## Limites

Documento de preparação. Não é prova, não aprova conta, não abre vendas e não certifica margem. Custo e tempo da empresa com esta trava pertencem 100% ao Marktmorgen (FX275); custo desconhecido não é zero. Acessibilidade: Markdown com títulos em ordem, tabelas com cabeçalho e links com texto próprio; nenhuma tela muda (0 → 0 passos e decisões); sem teste humano nem certificação. Estado VR: "testado num PR" não se aplica (só documento); nada passa a funcionar para o cliente.
