# Automatic AI and upload spend policies

> **MR vigente — dono27/10/2026 07h42 Fortaleza,464[MR1]:** [REGRA DE MARGEM](../AGENTS.md#mr--regra-de-margem-vigente-27-de-outubro-de-2026) substitui todos os pisos históricos de60% neste documento e suas referências. Exigir lucro líquido por unidade maior que zero no pior caso com a folga existente do spend floor,100% direitos mensal/anual e complementos; empresa sem prejuízo a partir de base mínima calculada com100%FX275 e exposições.60% é meta real mensal da empresa. Preservados ISS5%, leitura mais onerosa, recebimento mais caro, reservas/tetos/gates; desconhecido reprova, não é zero. Texto/citações/números antigos abaixo são histórico, não recalculados nem certificados. Código/relatório/regeneração pertencem a MR2; resultados atuais a MR3. Sem mudança de preços/limites/comissão/vendas.


Since 17 Oct 2026 the AI spend policy and the upload budget policy are computed in code. Nothing has to be reviewed, renewed or switched on each month. The exposure and contract funding policies stay null (see the end of this page).

## One source of rates

`lib/spend-cost-table.ts` holds every supplier rate behind both policies, with sources and the date they were read:

- Anthropic list prices (read 2026-10-17): Sonnet 5.5 $2 in / $10 out per million tokens across its 1M context; Haiku 5.5 $0.10 / $0.50 up to 100,000 prompt tokens and $0.50 / $2.50 for the whole request above that. The application does not send `inference_geo`, so the 1.1x US-only multiplier does not apply.
- A 10% allowance on top of every model charge for invoice taxes, currency exchange and card or remittance costs. This is a deliberately high allowance, not a measured rate.
- Hosting for each model call: 2 GB of function memory held for the whole 45-second model timeout, the call, one CPU-second and twenty database commands (the same Vercel and Upstash rates as `tests/traffic-cost.ts`).
- Cloudflare R2 Standard: $0.015 per GB-month, $4.50 per million Class A operations, $0.36 per million Class B.

`tests/spend-cost-table.test.ts` fails if `lib/answers-rules.ts`, `tests/traffic-cost.ts`, `docs/tier-storage-limits.md`, the model timeout or the default models in `lib/ai.ts` disagree with the table, or if a supported model has no rate.

## AI

**Hold per request.** `askModel` computes the most a request can cost from the request itself (`aiRequestHoldMicroUsd`): each UTF-8 byte of instructions and text counts as one input token (a token always covers at least one byte), plus 1,024 framing tokens and 32 per content block; an image adds 4,784 tokens (the largest the provider keeps after downscaling); a PDF is held at the whole 1M-token context window because its extracted text is not bounded by its size; every `max_tokens` output token is counted. The hold is reserved in the monthly ledger before the fetch. #468's rules are unchanged: failed, timed-out, lost and successful attempts keep their full reservation, retries reserve again, request bounds and the per-job call envelope still apply, and non-paying scopes still reserve their funded exposure first.

**Ceiling per plan.** Since 20 November 2026 (433 [PV3] (b)), a plan's monthly dollar ceiling funds every right it publishes used in full at once, each call at the worst request its own feature can send (`requiredAiRightsMicroUsd` in lib/ai-entitlement-rules.ts, from the cost table; the models are fixed in code, `WRITING_MODEL` and `ANSWER_MODEL` in lib/ai-request-rules.ts):

- A writing job: two calls, each at the dearest text request either fixed model can send (16 KiB of instructions, 64 KiB of text, one image, 6,000 output tokens; Sonnet 5.5) = $0.259555 a call.
- A PDF read: Haiku 5.5 at the full context window with 6,000 output tokens = $0.566842, in place of one writing call. It runs only inside a page draft that took 1 + `READ_PDF_JOBS` = 10 writing jobs for it (lib/ai.ts refuses any other document request), so a month reads at most floor((jobs − 1) / 9) PDFs.
- A visitor answer or a store-guide reply: Haiku 5.5 at its dearest text request, which stays below Haiku's 100,000-token tier = $0.013304.

| Plan | Writing jobs | PDF reads at most | Visitor answers | Monthly AI ceiling |
|---|---:|---:|---:|---:|
| Store | 0 | 0 | 0 | $0 |
| Studio | 40 | 4 | 250 | $25.319548 |
| Scale | 80 | 8 | 400 | $49.308696 |
| Free trial, setup, ended | 0 | 0 | 0 | $0 (no allocation) |

Each request still sets aside only its own hard bound, so in practice a store's ceiling outlasts its jobs; until 20 November 2026 the ceiling funded only a reference job and answer ($3.353710 on Studio and $6.369120 on Scale), so long requests could exhaust it before the job count.

`MARKTMORGEN_AI_SPEND_CEILING_PERCENT` (a whole number from 0 to 100) is optional and can only lower every ceiling; above 100 counts as 100 and anything else is ignored.

## Uploads

Each paid plan may authorize up to its whole storage allowance in new sold-file and lesson-file bytes a month (Store 8 GiB, Studio 64 GiB, Scale 128 GiB), with 50, 300 and 600 upload starts, and enough signing requests for every byte plus one more batch per start. Stored bytes are already paid for by the storage allowance, because admission counts every open reservation against it; what the allowance adds is provider operations and function time, priced by `uploadOperationsMicroUsd`: Store $0.0616, Studio $0.3923 and Scale $0.7848 a month at most. Trial, setup and ended stores have no allocation. Only the revocable R2 path is admitted, as before.

## The 60% floor, per plan

**Historical (17 October 2026).** The table below is at the prices and the lighter fee model of that day. Since 18 October 2026 every unit is held to `lib/receiving-costs.ts`, and since the owner's price decision of that day (11:21) the price list is $69 / $690, $449 / $4,490 and $999 / $9,990: `docs/margin-alignment-2026-10-18.md` (generated) and `docs/value-presentation-2026-10-18.md` have the figures in force.

`tests/spend-floor.test.ts` adds, for each plan and billing cycle, Stripe's card and Billing fees, twelve (or one) full months of the per-plan worst case in `tests/plan-cost-model.ts` (storage at the dearest store, video, visits, orders, list email and receipts), the AI ceiling and the upload operations, and compares the sum with P x 5/29, the most a paid period may cost before a 27.5% tax and still keep 60%:

| Plan, cycle | Paid | Costs allowed | Stripe | Other per month | AI per month | Uploads per month | Total | Room |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Store, month | $22 | $3.79 | $1.0920 | $2.3290 | $0 | $0.0616 | $3.4826 | $0.3074 |
| Store, year | $220 | $37.93 | $8.2200 | $2.3290 | $0 | $0.0616 | $36.9069 | $1.0231 |
| Studio, month | $149 | $25.68 | $5.6640 | $13.0690 | $3.3537 | $0.3923 | $22.4790 | $3.2010 |
| Studio, year | $1,490 | $256.89 | $53.9400 | $13.0690 | $3.3537 | $0.3923 | $255.7200 | $1.1700 |
| Scale, month | $349 | $60.17 | $12.8640 | $32.3680 | $6.3691 | $0.7848 | $52.3859 | $7.7841 |
| Scale, year | $3,490 | $601.72 | $125.9400 | $32.3680 | $6.3691 | $0.7848 | $600.2027 | $1.5173 |

Since 17 October 2026 "other per month" is the sum of every line of `tests/plan-cost-registry.ts` but AI and uploads: storage, video, visits, orders, the monthly emails, receipts, workflows, imports, the ClickFunnels move, shared funnels and saved sections, team calls and their hosts' calendars, and quiz submissions (collections, the checkout script and AI funnel drafts are inside visits, orders and the AI ceiling). `tests/plan-cost-registry.test.ts` fails when a counter or a limit constant in the code is in no line, so a feature cannot be left out again; what no monthly figure bounds yet is listed there as OPEN and is not certified by this table. Counting the features of that day pushed every plan below the floor; to bring each back with at least $0.25 of room by the month and $1 by the year, without changing a price or the number of plans, these figures went down: orders a month (Store 400 to 250, Studio 1,500 to 750, Scale 3,000 to 1,500), new workflow runs a day (Studio 300 to 25, Scale 600 to 40, trial 50 to 10; and on 18 October 2026, when a run's waits and retries were counted, to 18, 29 and 7), the import and ClickFunnels figures by month (`lib/import-limits.ts`), shared funnels by month (`lib/funnel-share-rules.ts`), hosts per team event on Scale (6 to 4), and how often a host's calendar is read (every 5 minutes to every 15). Visits and orders past a plan are no longer sold (their prices did not keep 60%): public pages rest at 95% of the month's visits and buyers' own pages at 100%, and a paid store's new orders are admitted only within the figure (`lib/order-admission.ts`).

The annual cycle binds. The allowances before this change (Store 100 jobs and 500 answers, Studio 400 and 2,000, Scale 1,000 and 6,000) could not fit, so they were lowered in code and on every public page; no price changed. Store, paid by the year, was $1.4239 short of the floor ($39.3539 against $37.93), $0.6850 of it before any AI or upload, because of its visits, orders and receipt allowances. On October 17, 2026 Store's covered orders went from 500 to 400 a month (`ORDERS_INCLUDED.creator`, which also sets the free trial's free-copy stop): $0.21 less a month at $0.0021 an order, with no price changed and every other plan's figures as they were. Orders were cut rather than visits because an order is counted only while no share of its sale is taken, and 400 orders is far more than 3,000 visits sell at an ordinary conversion rate. The test now requires Store to pass on both cycles with at least $1 of room by the year and $0.25 by the month. Store still gets no AI.

## Ledgers

Both ledgers are one persistent hash per UTC month, `nl:ai-spend:v2:{YYYY-MM}` and `nl:upload-budget:v2:{YYYY-MM}`, each with an `:opened` marker in the same cluster slot. For the automatic policy, the first reservation of a month runs the opening script (`OPEN_AI_SPEND_LEDGER`, `OPEN_UPLOAD_BUDGET`) in the same pipeline as the unchanged reservation script:

- A missing ledger is created once, with zero counters and the funded allocation counts, and the marker is set. If the marker exists the ledger was lost: it is never recreated, and the month stays refused.
- A ledger written under any other review (a separately reviewed policy) is never touched.
- When the computed ceilings change (a deploy or the lowering setting), the policy binding is replaced and every spent amount and claimed allocation is carried; new allocation slots are what the new count leaves after those already claimed. Nothing is reset, refunded or expired.

Since 17 October 2026 a paying store's monthly ceiling follows its billing month (lib/allowance-window.ts), not the calendar month: its AI reservations go into the ledger of the calendar month its billing month began in, under the field `store:<statsId>:<billing month>`, and its uploads under `store:<statsId>@<billing month>:…`. One payment buys one month's ceiling however many calendar months it touches, which is what each plan's worst month prices. A store that pays nothing, and every reservation made without a window, keeps the calendar month and the field `store:<statsId>`. A paying store whose billing month is not known reserves nothing.

Explicitly supplied policies keep #468's behavior exactly: their ledgers are never created by the request path. `scripts/test_spend_ledger_open_redis.py` runs both opening scripts and the reservation scripts against the loopback CI Redis.

## What stays null, and what is missing

`CURRENT_EXPOSURE_BUDGET_POLICY` and `CURRENT_CONTRACT_FUNDING_POLICY` stay null. They cannot be computed from code: the exposure policy needs an approved funded-exposure review (occurrence caps and full per-case cost and tax ceilings for trial, setup, refunds, non-payment, post-cancellation, pauses and accrued credits) and the amount of cash actually set aside with evidence of it; the contract policy also needs the company's fixed costs and taxes, the reviewed paying base, a liability tail and bank-backed reserves. Until the owner supplies those, free-trial, setup and ended stores get no AI and no new uploads, and the commercial review in `lib/commercial-margin.ts` stays null, so paid release stays closed.

The commercial gate's own AI coverage check (`aiEntitlementsFunded`) still requires every allowed call at the largest request; with dollar ceilings it does not pass. Reconciling it with the automatic ceilings is part of the owner's commercial review.

## Limitations

- Holds are hard bounds and often several times a request's real cost; with no refunds, the dollar ceilings are what limit use.
- A signed part URL can be replayed until it expires (one hour); each replay is a Class A operation not in the priced allowance, bounded only by the uploader's bandwidth.
- Paid standing includes a card in Stripe's past-due grace period, as before.
- A full loss of Redis data (ledger and marker together) would reopen a month at zero. An Anthropic workspace spend limit set once in the console would bound that case independently.
- The demo store is on Studio (`DEMO_STORE.tier` in lib/demo-seed.ts) so the public demo shows the AI features. It pays no subscription, so its usage is a company cost bounded by Studio's own automatic ceilings: at most $25.3195 of AI a month since 20 November 2026 (433 [PV3] (b); $3.3537 before), of which only the visitor answers ($3.326 at most) can be asked by the public, since only the operator opens its studio, plus Studio's visit allowance; it sends no email to anybody (lib/house-store.ts).
