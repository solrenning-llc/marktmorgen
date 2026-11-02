# 613 [WP12] — Conferência oficial dos pixels e das APIs de conversão do X e do Reddit (02/11/2026)

Conferência feita pelo Claude 1 em 02/11/2026, só em páginas oficiais, para o Claude 3, cujo ambiente não abre esses sites. Estados: **CONFIRMADO**, **DIVERGENTE**, **NÃO ENCONTRADO**. O que estiver NÃO ENCONTRADO é lacuna e não vira parâmetro de código. Nada foi criado, aceito ou contratado; nenhum preço, limite, comissão ou flag muda. Em todos os casos o pixel só carrega com o consentimento do comprador e respeitando o Global Privacy Control (lib/pixels.ts, lib/ad-consent.ts).

## X (antigo Twitter)

Página principal do pixel: https://business.x.com/en/help/campaign-measurement-and-analytics/conversion-tracking-for-websites

1. **Instalação** — CONFIRMADO: código base antes de `</head>` em todas as páginas, iniciado com `twq('config', '<pixel_id>')`; o carregador vem do Events Manager.
2. **Script** — CONFIRMADO: `https://static.ads-twitter.com/uwt.js`. Para a política de segurança de conteúdo, liberar `ads-twitter.com`, `ads-api.twitter.com` e `analytics.twitter.com` em `img-src` e `connect-src`.
3. **Eventos** — CONFIRMADO: `twq('event', 'tw-<pixel_id>-<event_id>', {...})`; tipos Page view, Add to cart, Lead, Added payment info, Purchase e Custom; o código base registra Site Visit e Landing Page View sozinho. O nome técnico de cada evento é o ID criado no Events Manager, não uma palavra fixa.
4. **Valor e moeda no pixel** — CONFIRMADO: `value` (número) e `currency` (ISO 4217); no Purchase também `conversion_id` e `contents[]`.
5. **Hash no pixel** — CONFIRMADO: o próprio pixel aplica SHA-256 a `email_address` e `phone_number` (telefone com código do país).
6. **API de conversões: endereço** — CONFIRMADO, com versão **DIVERGENTE**: `POST https://ads-api.x.com/<versão>/measurement/conversions/<pixel_id>`; o guia mostra a versão 11 e a referência a 12. Conferir a versão vigente no código, nunca fixá-la por este documento. https://developer.x.com/en/docs/x-ads-api/measurement/guides/conversion-api e https://docs.x.com/x-ads-api/measurement/web-conversions
7. **Autenticação** — CONFIRMADO: OAuth 1.0a (HMAC-SHA1) em toda chamada da Ads API; o token precisa ser de usuário com acesso AD_MANAGER ou ACCOUNT_ADMIN da conta de anúncios; para a conta de outra pessoa (o criador), OAuth de 3 etapas. https://docs.x.com/x-ads-api/fundamentals/making-authenticated-requests
8. **Acesso** — CONFIRMADO: conta de desenvolvedor com acesso Essential (aprovação imediata) e a opção Conversion API marcada na aplicação da Ads API; apps novos começam com tokens de acesso limitado. (Criar a conta de desenvolvedor é passo do dono, em Depende do dono.)
9. **Campos do evento** — CONFIRMADO: `conversions[]` com `event_id`, `conversion_time` (ISO 8601) e `identifiers` (pelo menos um: `twclid` sem hash, `hashed_email` com espaços tirados e SHA-256, `hashed_phone_number` em E.164 e SHA-256; `ip_address` e `user_agent` só valem junto de outro identificador). Opcionais: `value` (texto, por exemplo "20.00"), `number_items`, `conversion_id`, `description`, `contents[]`.
10. **Moeda na API de conversões** — NÃO ENCONTRADO: o campo `currency` não aparece na referência; não presumir que existe.
11. **Deduplicação** — CONFIRMADO: o mesmo `conversion_id` no pixel e na API, para o mesmo evento, numa janela de 48 horas.
12. **Limites** — CONFIRMADO: 60.000 eventos por conta a cada 15 minutos; até 500 conversões por requisição.
13. **`twclid`** — CONFIRMADO: vem do parâmetro `twclid` da URL de destino; a X recomenda sempre enviá-lo.
14. **Consentimento** — CONFIRMADO: o anunciante precisa do consentimento antes de gravar ou ler cookies não essenciais, consentimento livre e fácil de retirar, com finalidade, duração e link para a política. https://help.x.com/en/business-and-advertising/about-conversion-tracking
15. **Restricted Data Use** — CONFIRMADO: parâmetro `restricted_data_use` com valor `restrict_optimization` (padrão desligado), aceito no pixel e em cada conversão da API, por pessoa (pedido de exclusão) ou por região. https://business.x.com/en/help/campaign-measurement-and-analytics/conversion-tracking-for-websites/restricted-data-use-guide . DIVERGENTE: a página principal ainda fala em pedido por chamado de suporte; vale o guia específico. Na API o valor aparece como "RestrictOptimization": conferir o esquema antes do código.

## Reddit

1. **Termos e deduplicação** — CONFIRMADO: o pixel segue os Reddit Business Tool Terms, e a deduplicação é **obrigatória** quando o pixel e a API de conversões são usados juntos; os metadados aprimorados vêm ligados e podem ser desligados no Events Manager. https://business.reddithelp.com/articles/Knowledge/reddit-pixel
2. **Limited Data Use** — CONFIRMADO: o Reddit oferece a marca Limited Data Use, inclusive para tirar quem não consentiu da segmentação por comportamento; anunciantes de categorias sensíveis não podem ligar os metadados aprimorados. Mesma página.
3. **Script, eventos padrão, valor e moeda do pixel** — NÃO ENCONTRADO: as páginas oficiais de instalação e de eventos não carregaram.
4. **API de conversões (endereço, versão, autenticação, campos, `rdt_cid`, limites)** — NÃO ENCONTRADO em página oficial: `ads-api.reddit.com` e os artigos do help center não abriram. Um guia de migração da v2 para a v3 fora do domínio do Reddit indica `/api/v3/pixels/{pixel_id}/conversion_events`, `action_source` obrigatório e `user.data_processing_options`, mas não é fonte oficial: não usar até conferir.

## O que isso libera

- **X:** a unidade do pixel e da API de conversões do X pode ser construída com os itens CONFIRMADOS acima, desligada até a conta do criador ser ligada, com consentimento, Global Privacy Control e `restricted_data_use` para quem pediu exclusão.
- **Reddit:** fica como lacuna até a leitura das páginas oficiais de instalação, eventos e API v3; nenhum parâmetro do Reddit entra no código antes disso.
