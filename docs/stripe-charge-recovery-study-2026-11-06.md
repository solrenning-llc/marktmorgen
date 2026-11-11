# 657 [WG17] — Stripe charge recovery on Standard connected accounts: what we read, what we write, what only the creator turns on

Date: 2026-11-06. Branch `claude4/wg17-recovery-study`.

**Status: Study only: nothing built, nothing changed, nothing available to customers (VR).**

## Resumo para o dono

- Nenhuma das três funções do Stripe (Smart Retries, atualização automática de cartões, Adaptive Acceptance) tem configuração que a plataforma consiga ler ou mudar pela API numa conta Standard conectada. Quem liga, desliga e ajusta é o criador, no painel do Stripe dele.
- O que a plataforma consegue ler é o efeito, não a configuração: em cada fatura, `next_payment_attempt` (quando o Stripe vai tentar de novo) e `attempt_count`; e os eventos `payment_method.automatically_updated` (cartão atualizado pela bandeira).
- Preço, pela página oficial de preços (EUA): atualização de cartões e Adaptive Acceptance vêm sem custo extra no preço padrão do Stripe; no preço personalizado são cobradas à parte (25 centavos por cartão atualizado; 0,08% por transação). Quem paga é a conta do criador, não a Marktmorgen.
- Proposta para "Something's not working": uma frase de orientação com o link oficial da tela de tentativas do Stripe (https://dashboard.stripe.com/revenue_recovery/retries), sem nenhuma leitura nova. Opcional, se o dono quiser: 1 GET a mais que mostra quantas mensalidades em atraso têm nova tentativa marcada.
- Custo de função da leitura opcional: desconhecido, não zero, a medir antes de construir (não existe linha "checkup" em tests/plan-cost-registry.ts).
- Nenhum percentual de receita é prometido. O "+6–11%" da Whop é alegação sem prova e não é repetido aqui.
- Achado novo: o Stripe também pode mandar seus próprios e-mails de cartão vencendo e de pagamento que falhou, se o criador ligar; aí o membro recebe dois avisos (o do Stripe e o nosso). Registrado, nada mudado.

## How this was read

All sources are Stripe's own, all read on 2026-11-06:

1. **[spec]** Stripe's official OpenAPI specification, the machine form of the API reference: `github.com/stripe/openapi`, file `latest/openapi.spec3.json`, commit `e63fafc8ff863f2ec13d140a9ac95ce90cdd437e` (committed 2026-11-05), API version `2026-10-28.endive`. Quotes are verbatim.
2. **[page]** The documentation and pricing pages themselves, opened in full once the network allowed docs.stripe.com, stripe.com and support.stripe.com: docs pages as Stripe's own Markdown rendering (`<url>.md`), stripe.com pages as served in `en-US`, the support article from the article text embedded in its page (its `article:modified_time` is 2026-10-06). Quotes are verbatim.

Two redirects to note: `docs.stripe.com/billing/revenue-recovery/smarter-saved-cards` now serves the "How cards work" page (`/payments/cards/overview`), and `docs.stripe.com/billing/revenue-recovery/automation-recipes` now serves "Automations for Stripe Billing" (`/billing/automations`). They are cited at the page they serve.

Not used: Whop, blogs, agency articles, and every percentage on Stripe's marketing pages.

## The table

| Feature | Marktmorgen can READ (API / event, exact field) | Marktmorgen can WRITE | ONLY THE CREATOR can turn on (where) | Sources (read 2026-11-06) |
|---|---|---|---|---|
| **Smart Retries** (automatic retries of a failed subscription invoice) | Not the setting. Only its effect, per invoice, with `Stripe-Account`: `invoice.next_payment_attempt`, `invoice.attempt_count`, `invoice.attempted`, `invoice.status`; reached through `GET /v1/subscriptions?status=past_due&expand[]=data.latest_invoice` (already read daily by lib/payment-recovery.ts). Also the events `invoice.payment_failed` / `invoice.updated` via `GET /v1/events` on the account. | No retry setting. No API path for retry, recovery or automation settings exists in the spec (`/v1/billing/*` holds alerts, credits, meters only; `account.settings` has no retry field). Per object only: `POST /v1/invoices/{id}/pay` (an attempt out of schedule) and `payment_settings[save_default_payment_method]` on a subscription (already set by lib/payment-recovery.ts). | Smart Retries or a custom schedule (up to 3 retries), number of tries, window (1 week to 2 months), and what happens after the last try (cancel, unpaid, past_due, pause). Dashboard: **Billing > Revenue recovery > Retries**, https://dashboard.stripe.com/revenue_recovery/retries | [spec] `invoice.next_payment_attempt`, `invoice.attempt_count`, path list. [page] https://docs.stripe.com/billing/revenue-recovery/smart-retries |
| **Automatic card updates** (card account updater) | Not whether it is on. Only that it happened: event `payment_method.automatically_updated`, read with `GET /v1/events?type=payment_method.automatically_updated` and `Stripe-Account` (kept 30 days), or by a Connect webhook endpoint (`connect=true`). Events with a non-null `request.id` are API updates, not network ones. After an update, `payment_method.card.exp_month`, `exp_year`, `last4` and, for a new number, `fingerprint` hold the new values. | Nothing. No API field turns it on or off. | Nothing to switch in Billing: it is an account-level payments feature, part of Authorization Boost. On standard pricing: "Included at no additional charge"; on custom pricing without Authorization Boost: "25¢ per update". Effects show on the creator's Optimization page, https://dashboard.stripe.com/optimization | [spec] event type `payment_method.automatically_updated`; `GET /v1/events`. [page] https://docs.stripe.com/payments/cards/overview , https://support.stripe.com/questions/how-can-i-see-cards-updated-automatically-via-card-updater , https://docs.stripe.com/connect/webhooks , https://stripe.com/pricing , https://stripe.com/authorization-boost , https://docs.stripe.com/payments/analytics/optimization/a-b-testing |
| **Adaptive Acceptance** (Stripe reformats or retries a declined card request) | Nothing that names it. The only related fields are the charge's own outcome: `charge.outcome.network_status`, `type`, `reason`, `advice_code`, `network_advice_code`, `network_decline_code`. The words "Adaptive Acceptance" do not appear in the spec. | Nothing. | Part of Authorization Boost. On standard pricing: "Included at no additional charge"; on custom pricing without Authorization Boost: "0.08% per successful online card transaction" (Authorization Boost as a whole on custom pricing: "0.2% per successful online card transaction"). The creator sees its estimated effect on https://dashboard.stripe.com/optimization | [spec] `charge_outcome` fields. [page] https://docs.stripe.com/payments/analytics/optimization , https://docs.stripe.com/payments/analytics/acceptance , https://stripe.com/pricing , https://stripe.com/authorization-boost |
| **Stripe's own recovery emails and Billing automations** | Nothing about the settings. (Stripe keeps email logs for 60 days in the creator's Dashboard Customers page only.) | Nothing. No API path for automations or email settings. | "Send emails when card payments fail" at https://dashboard.stripe.com/revenue_recovery/emails ; "Send emails about expiring cards" (sent 1 month before expiry); other customer emails in subscriptions and emails settings, https://dashboard.stripe.com/settings/billing/automatic . Automations: the Automations tab of the Revenue recovery page (triggers such as "Subscription payment fails"; actions such as "Set retry policy", "Cancel subscription", "Mark invoice uncollectible"). | [spec] no automations or email-settings path. [page] https://docs.stripe.com/billing/revenue-recovery/customer-emails , https://docs.stripe.com/billing/automations , https://docs.stripe.com/billing/revenue-recovery |

### Key quotes, one per fact

- **[spec]** `invoice.next_payment_attempt`: "The time at which payment will next be attempted. This value will be `null` for invoices where `collection_method=send_invoice`."
- **[spec]** `invoice.attempt_count`: "Number of payment attempts made for this invoice, from the perspective of the payment retry schedule. … Retries will continue to be scheduled, and attempt_count will continue to increment, but retries will only be executed if a new payment method is obtained."
- **[spec]** `POST /v1/invoices/{invoice}/pay`: "Stripe automatically creates and then attempts to collect payment on invoices for customers on subscriptions according to your subscriptions settings."
- **[spec]** `GET /v1/events`: "List events, going back up to 30 days." `event.account`: "The connected account that originates the event."
- **[spec]** `webhook_endpoints.connect`: "Whether this endpoint should receive events from connected accounts (`true`), or from your account (`false`)."
- **[spec]** `POST /v1/accounts/{account}`: for `controller.requirement_collection` = `stripe`, "which includes Standard and Express accounts, you can update all information until you create an Account Link or Account Session to start Connect onboarding, after which some properties can no longer be updated." `account.settings` holds only `bacs_debit_payments, branding, card_issuing, card_payments, dashboard, invoices, payments, payouts, paypay_payments, sepa_debit_payments, treasury`; `settings.invoices` holds only `default_account_tax_ids` and `hosted_payment_method_save`. None is a retry, updater or acceptance switch.
- **[page]** https://docs.stripe.com/billing/revenue-recovery/smart-retries: "To configure subscription retries in your Dashboard, go to **Billing** > **Revenue recovery** > Retries" (link: `https://dashboard.stripe.com/revenue_recovery/retries`). "For new Stripe accounts, Stripe enables Smart Retries by default and configures it for up to 8 retries within 2 weeks." "Stripe doesn't retry payments if: … The Stripe Connect account has been disconnected." "After a payment attempt on an invoice, its next_payment_attempt value is set using the current subscription settings in your Dashboard." "For automations users, next_payment_attempt is no longer set in `invoice.payment_failed` webhooks but is set in `invoice.updated` webhooks."
- **[page]** Same page, confirming the design already in lib/payment-recovery.ts: "if a subscription has a `default_payment_method`, but you only update `customer.invoice_settings.default_payment_method`, Stripe continues to retry on the subscription's `default_payment_method`."
- **[page]** https://docs.stripe.com/payments/cards/overview: "Stripe works with card networks and automatically attempts to update saved card details whenever a customer receives a new card." "Automatic card updates require card issuers to participate with the network and provide this information. It's widely supported in the United States, allowing Stripe to automatically update most American Express, Visa, Mastercard, and Discover cards issued there. International support varies from country to country. It isn't possible to identify cards that support automatic updates." "The `payment_method.automatically_updated` event notifies you of automatic card updates from the network."
- **[page]** https://support.stripe.com/questions/how-can-i-see-cards-updated-automatically-via-card-updater (modified 2026-10-06): "When that happens, Stripe creates an event in your account"; filter with the List Events API and "ignore events where request[id] is not `null`".
- **[page]** https://stripe.com/authorization-boost: "Stripe supports card account updater on Visa, Mastercard, American Express, and Discover volume—including cross-brand updates." Price rows: "Adaptive Acceptance … Included in Authorization Boost 0.08% per successful online card transaction without Authorization Boost and with custom payments pricing"; "Card account updater … Included in Authorization Boost 25¢ per update for accounts without Authorization Boost and with custom payments pricing".
- **[page]** https://stripe.com/pricing (en-US): "Authorization Boost … inclusive of Adaptive Acceptance, card account updater and network tokens. … Included at no additional charge for businesses on standard payments pricing 0.2% per successful online card transaction for accounts with custom payments pricing".
- **[page]** https://docs.stripe.com/payments/analytics/optimization: "Adaptive Acceptance uses AI to reformat payment requests based on card issuers' preferences. Stripe can make these changes before sending a payment or after a payment is declined." "Stripe doesn't guarantee any outcomes for your use of Authorization Boost features."
- **[page]** https://docs.stripe.com/payments/analytics/optimization/a-b-testing (a private-preview page): for card account updater, "If you don't have this feature enabled, Stripe enables it for both groups", which shows it is a per-account enablement that some accounts do not have.
- **[page]** https://docs.stripe.com/billing/revenue-recovery/customer-emails: "Enable **Send emails when card payments fail** in the revenue recovery settings page. When you enable this setting, Stripe automatically sends an email to your customer after each failed payment." And: "turn on **Send emails about expiring cards**. This automatically sends an email 1 month before your customer's card on file expires."
- **[page]** https://docs.stripe.com/billing/automations: "You create an automation for the `Subscription payment fails` event with no conditions applied. … Your default settings for subscription payment failure won't run."
- **[page]** https://docs.stripe.com/billing/revenue-recovery: "None of the features require you to write code."
- **[page]** https://docs.stripe.com/connect/authentication: "To make server-side API calls for connected accounts, use the `Stripe-Account` header with the Account ID."
- **[page]** https://docs.stripe.com/connect/webhooks: the "Connected accounts" scope covers "Events triggered by resources that exist in connected accounts", including "Direct charges … for customers of your connected accounts"; "Each event for a connected account contains a top-level `account` property that identifies the connected account."
- **[page]** https://docs.stripe.com/connect/standard-accounts: "Standard connected accounts can access the full Stripe Dashboard, which gives them a large degree of control." The page is marked "Deprecated feature", applying "only to platforms that already use legacy connected account types".

### Constraint on a platform with Standard accounts

What a platform may manage on a full-Dashboard account is a short, named list: https://docs.stripe.com/connect/platform-controls-for-stripe-dashboard-accounts ("Manage more features on behalf of your connected accounts that use the full Stripe Dashboard") lists third-party extensions, payout timing, reporting, branding, Terminal hardware, and removing the account **[page]**. Billing, retries, customer emails and acceptance features are not on it. https://docs.stripe.com/connect/accounts contrasts Custom ("You have the ability to change all of the account's settings … programmatically") with Standard ("Full Dashboard"; payout timing only "with Platform controls") **[page]**. And the API has no endpoint or account field for these settings **[spec]**. Even the Dashboard's acceptance analytics is limited: "To see data from Standard accounts, platforms must enable Platform controls" (https://docs.stripe.com/payments/analytics/acceptance) **[page]**.

So the conclusion holds on three official grounds. A single sentence that says "a platform cannot change a Standard account's Billing settings" in those words was still not found (Gaps, item 1).

## What the existing code already does (do not duplicate)

- **lib/dunning-rules.ts** — the creator's choice of 1, 2 or 3 emails per failed payment (`REMINDER_CHOICES`, days `REMINDER_DAYS` = 0, 3, 7; default 1) and the card notice before a card expires (`CARD_NOTICE_DAYS` = 10, on by default). Its header assumes Stripe's retries "run for weeks by default", which matches the page for new accounts (up to 8 tries in 2 weeks).
- **lib/payment-recovery.ts** — the daily job, no webhooks ("this app receives no events from Stripe — it asks"). Per store with memberships: `GET /v1/subscriptions?status=past_due&limit=100&expand[]=data.latest_invoice&expand[]=data.customer` on the creator's account; reads `latest_invoice.status`, `amount_due`, `hosted_invoice_url` and **`next_payment_attempt`** (the email says "it will be tried again on …" only when Stripe has a next try); sets `payment_settings[save_default_payment_method]=on_subscription` once per failed invoice; sends the member the hosted invoice link. It also reads active subscriptions' cards (`CARD_PAGES` = 5, `CARD_LOOKUPS` = 20) for the expiry notice.
- **lib/checkup.ts** — "Something's not working": six readers side by side, each capped at `CHECK_WAIT_MS` = 8,000 ms. Stripe calls today: `readAccount` (one `GET /v2/core/accounts/{id}`, lib/stripe-connect.ts) and `readDisputes` (at most `DISPUTE_PAGES` = 3 `GET /v1/disputes` pages on the creator's account). Nothing about retries, card updates or acceptance is shown today.
- Already reading events on creators' accounts: the lost-dispute jobs read `GET /events` per store (`LOST_DISPUTE_PAGES` in tests/plan-cost-registry.ts).

Three consequences of the creator's own settings, noted here and not acted on:

1. If a creator turns on "Send emails when card payments fail", the member gets Stripe's email and Marktmorgen's email about the same payment. Nobody can see that setting from here.
2. If a creator turns on "Send emails about expiring cards", the member gets Stripe's notice one month ahead and Marktmorgen's notice 10 days ahead.
3. With an automation on "Subscription payment fails", the creator's default retry settings do not run for the payments it matches, and `next_payment_attempt` comes in `invoice.updated` rather than `invoice.payment_failed`. Whether the invoice object read by the daily job still carries it is not stated (Gaps, item 4); if not, our email would say "not tried again" when Stripe will try.

## Proposal for "Something's not working"

**The settings themselves are not readable, so the checkup shows no state for them.** It shows one guidance line, the same for every store with a Stripe account, no Stripe call:

> Whether Stripe tries a failed membership payment again, and whether Stripe emails the member about it, are settings in your own Stripe account that we cannot see or change. Check them in your Stripe Dashboard under Billing, Revenue recovery: https://dashboard.stripe.com/revenue_recovery/retries

(The link is the one Stripe's Smart Retries page gives for "Billing > Revenue recovery > Retries"; the emails setting sits on the same Revenue recovery page, `/revenue_recovery/emails`.)

Not proposed: a line for automatic card updates or Adaptive Acceptance. Neither is a Billing switch the creator can be sent to; both depend on the creator's pricing with Stripe, which we cannot read; and Marktmorgen already warns members about expiring cards itself.

**Optional, only if the owner wants a readable state (one read):** the effect of the retry setting, never the setting.

- Read: one `GET /v1/subscriptions?status=past_due&limit=100&expand[]=data.latest_invoice` on the creator's account, filtered to this store's subscriptions (`metadata.store`, as lib/payment-recovery.ts does).
- State shown: "N memberships with a failed payment; Stripe will try again for X of them; for Y no further try is scheduled." Y counts open, `charge_automatically` invoices whose `next_payment_attempt` is null.
- Whole page or no total (Codex CX1 on #2747): the list holds at most 100 a page and says `has_more` (https://docs.stripe.com/api/subscriptions/list, https://docs.stripe.com/api/pagination), and other stores' subscriptions share the creator's account. N, X and Y are shown as totals only when the page came back whole (`has_more: false`) with every row readable (lib/stripe-list.ts, `readStripePage`). With `has_more: true` the line says "at least N" for what was found, never 0 for this store, since its rows may sit on a later page; a page in another shape or an unreadable row gives no number at all and only the guidance sentence. Still one read: no paging, so the cost below does not change.
- What it must not say: that retries are "off". A null `next_payment_attempt` also means the tries are used up, and under automations may mean something else (Gaps, item 4). The line says what Stripe will do, and links the guidance sentence above.
- Not a repeat of lib/payment-recovery.ts: that job reads the same list once a day to send emails and keeps nothing to show.

## Worst-case read cost per plan

Each checkup open is a studio page: `STUDIO_PAGE_UNITS` = 4 studio requests (lib/studio-allowance-rules.ts, counted in `studioView`, lib/studio-route.ts). So the most opens in one window are the plan's studio figure / 4, if the store spent its whole studio figure on nothing else.

Stripe calls per open, worst case: today 1 (`readAccount`) + `DISPUTE_PAGES` 3 = **4**. With the guidance line only: **4** (no change). With the optional read: **5**.

| Plan / standing | Studio figure (lib/store-allowance-rules.ts) | Max checkup opens | Stripe GETs per window today (4/open) | With guidance only | With the optional read (5/open) |
|---|---|---|---|---|---|
| creator | 2,000 | 500 | 2,000 | 2,000 | 2,500 |
| pro | 5,000 | 1,250 | 5,000 | 5,000 | 6,250 |
| scale | 15,000 | 3,750 | 15,000 | 15,000 | 18,750 |
| trial | 1,000 | 250 | 1,000 | 1,000 | 1,250 |
| none | 300 | 75 | 300 | 300 | 375 |
| ended | 100 | 25 | 100 | 100 | 125 |

- **Inside the existing ceiling.** The optional read would run side by side with the other six readers, under the same `within(…, CHECK_WAIT_MS)` cap (`CHECK_WAIT_MS` = 8,000 ms in lib/checkup.ts), so the page still waits at most 8 seconds; a read that fails or is late is "not checked", never "fine".
- **Stripe charge per call.** The brief and lib/checkup.ts treat a Stripe read as having no per-call charge, and no per-request fee appears on https://stripe.com/pricing (read 2026-11-06); tests/plan-cost-registry.ts still keeps the Stripe GET tariff `null`, and this study does not change that.
- **Rate limits and read allocation** **[page]**, https://docs.stripe.com/rate-limits: "Live mode: 100 requests per second", individual endpoints 25 per second; "Your account's read API requests must not exceed an average of 500 per transaction"; "Connect platforms use a separate allocation to make read requests on behalf of their connected accounts … also 500 requests per transaction based on the aggregate transaction count across its connected accounts"; "Every account, regardless of transaction count, has a minimum allocation of 10,000 read requests per month." So every checkup read counts against Marktmorgen's single platform allocation, shared by all stores. What happens past it is not stated (Gaps, item 6).
- **Function time.** There is no line named "checkup" in tests/plan-cost-registry.ts; the page draw falls under the general `studio` line (STUDIO_PAGE_UNITS each), which does not price the checkup's Stripe waits. So the function time of the optional read is **unknown, not zero, to be measured before building**.

## Revenue

No revenue percentage is promised or estimated here. Whop's "+6–11%" is an unproven claim and is not repeated. Stripe's own pages print uplift figures for Authorization Boost and Adaptive Acceptance; they are Stripe's claims about its own customers, the same documentation says "Stripe doesn't guarantee any outcomes", and they are not repeated either.

## Gaps (open after reading the pages)

Closed by the pages, 2026-11-06: the documentation is no longer read through excerpts (every fact above is quoted from the page); the Dashboard deep link for retries (`https://dashboard.stripe.com/revenue_recovery/retries`, given by Stripe's Smart Retries page; the page itself was not opened, it needs a signed-in account); `payment_method.automatically_updated` on a connected account (the support article: Stripe "creates an event in your account", the account holding the card; the Connect webhooks page puts events of resources that exist in connected accounts, and direct charges, in the "Connected accounts" scope; the spec lets the platform list events with `Stripe-Account`); card updater networks (Visa, Mastercard, American Express, Discover; widest in the US, "International support varies from country to country"); card updater and Adaptive Acceptance fees on en-US pricing (included at no additional charge on standard pricing; on custom pricing without Authorization Boost, 25¢ per update and 0.08% per transaction); Standard accounts as a "Deprecated feature" for new platforms (confirmed; nothing here depends on it).

Still open (not guessed):

1. **No sentence that says, in so many words, that a platform cannot change a Standard account's Billing settings.** Shown by the platform-controls list, the Custom/Standard contrast and the API, not by one sentence.
2. **Card updater on or off by default** for an account on standard pricing: not stated. The A/B test page shows some accounts do not have it enabled; how an account turns it on is not documented on the pages read.
3. **Adaptive Acceptance on or off by default**, and whether it applies to a Standard account's direct charges: not stated. No API field shows it was applied to a charge.
4. **`next_payment_attempt` under automations:** the pages speak only of webhooks; whether the invoice object still carries it is not stated. Affects the wording of the existing failed-payment email.
5. **Smart Retries on existing accounts:** "on by default, 8 tries in 2 weeks" is stated "For new Stripe accounts". An existing creator's account may differ, and that cannot be read by API.
6. **Read allocation overrun:** the rate-limits page says reads "must not exceed" the allocation but not what happens past it (throttling, a fee, or contact), nor whether the v2 `GET /v2/core/accounts/{id}` counts in it.
7. **Pricing outside the US:** the figures above are from the en-US pages; a creator in another country may be priced differently.

## Rules

- No price, limit, commission, flag or gate changes.
- No account, terms, contract or contact: nothing was created, accepted, signed or sent, and no one at Stripe or elsewhere was contacted.
- Nothing is built from this study until the open gaps that touch what would be built (items 4 and 6 for the optional read) are closed, and the optional read, if built, counts only a whole page with every row readable ("at least N" with more pages, no number on a page it cannot read), as the proposal above says.
