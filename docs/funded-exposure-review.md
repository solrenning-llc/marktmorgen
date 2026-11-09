# Funded exposures and minimum paid customer base

> **MR vigente — dono27/10/2026 07h42 Fortaleza,464[MR1]:** [REGRA DE MARGEM](../AGENTS.md#mr--regra-de-margem-vigente-27-de-outubro-de-2026) substitui todos os pisos históricos de60% neste documento e suas referências. Exigir lucro líquido por unidade maior que zero no pior caso com a folga existente do spend floor,100% direitos mensal/anual e complementos; empresa sem prejuízo a partir de base mínima calculada com100%FX275 e exposições.60% é meta real mensal da empresa. Preservados ISS5%, leitura mais onerosa, recebimento mais caro, reservas/tetos/gates; desconhecido reprova, não é zero. Texto/citações/números antigos abaixo são histórico, não recalculados nem certificados. Código/relatório/regeneração pertencem a MR2; resultados atuais a MR3. Sem mudança de preços/limites/comissão/vendas.


## CX-67 — Held stores: financed company exposure (4 November2026)

This is an explicit exception to the historical closing-day deletion statements
below. Unknown billing coverage (`has_more`, malformed/failed evidence or an
unreadable independent refund queue) never advances a store to `removed`.
There is no deletion deadline for uncertainty and no new customer limit.

`lib/held-stores.ts` retains each unresolved obligation in the private shared
`nl:held:stores` index. The daily closing job revisits oldest due entries. **CX-69,4 November2026:**
only unknown platform billing coverage belongs in this index; known pauses,
member/buyer batches, notices and refund progress continue through the ordinary
walk. Previously misclassified entries may make local progress before any
coverage read is needed. The two-read retry is independent of the retention
policy and is counted in its existing recovery work line. The current-month
`post_cancellation` review governs retention only: its allocation supplies the
global funded retention-case ceiling and consumes its existing ledger without
initializing money, refunding slots or offsetting another scope. A null review
leaves retention unknown, but cannot freeze recovery. At most50 rechecks may run company-wide
per UTC day, and at most one per store/day, committed atomically before either
of the two recovery reads. A lost acknowledgement consumes its claim and cannot
permit another attempt. Attempted entries rotate to the next UTC day; unattempted entries retain their older score so the same first50 cannot starve the rest. Once
complete evidence proves there is no live billing, normal closing continues.
A refund already independently queued after a confirmed stop does not retain
files; its refund worker remains responsible after deletion.

`HELD_EXPOSURE` and `heldStoreMonthlyExposure` in `tests/plan-cost-registry.ts`
count the full paid-tier file/task/community ceiling and the full data room
plus **peak** outside-room keys and a4096-byte index allowance per held store,
for31days. They add up to31 two-read timeout waits per store,128 bookkeeping
commands and MAX_STORE_BYTES+128KiB of database replies per retry. The global
model uses at most1550 attempts/month, the reviewed simultaneous case cap,
three overlapping daily hashes (50 hashed identities each, two-day TTL) and
15 monthly aggregate keys (400-day TTL) plus a1KiB global walk cursor. Daily work caps are internal company
work bounds. These are modeled components, not a verified complete supplier
quote: endpoint tariff, deployment coverage, all retained provider records,
independent refund work and taxes require the complete funded review. The
runtime floor is only a necessary minimum; it cannot certify missing categories.
The approved current policy, actual case ceiling and complete total remain
**null**, never zero. No price, allowance, commercial flag or gate changes.

Retention funding must be renewed for every calendar month unresolved stores remain.
A full first page of final closings is not the whole queue: a global cursor
continues the bounded pages across a job deadline. A partial walk or a changed
final-index cardinality cannot certify a complete monthly observation.
Existing obligations above the reviewed case ceiling are **still retained and
counted**, not hidden or deleted to fit a budget; such overflow or any unknown
count makes the financed company total unknown and prevents certification of
an adequate minimum paid base. An unknown-duration hold has no invented finite
lifetime cost. The whole reviewed monthly exposure belongs100% in company
fixed/exposure accounting and its minimum paid base, never subsidized by a
paid customer's modeled profit or a hoped-for conversion.

The daily job atomically records aggregate count, observed daily peak, date and
walk completeness in `nl:held:month:YYYY-MM`; index mutations invalidate its
completion in the same Redis operation. Only a complete last-calendar-day
observation may populate `heldStores` and `heldStoresPeak` in the prior-month
company report (`companyMonthlyMarginReportWithHeld`). Missing, partial or stale
counts stay null; private store references, addresses and refund data never
enter the report. This connects operational counts to the existing report
calculator; reconciled money ingestion, scheduling and owner presentation are
still separate work, as before. No message, account or provider action is made
by the report. Synthetic tests and disposable-Redis Lua checks do not establish
an actual balance or authorize commercial release.

The owner authorized a calculated minimum paid customer base and separately funded acquisition/refund exposure. A free account has no positive revenue on which a 60% profit margin could be computed. It is never reported as a profitable paid customer.

Commercial review now separates nine revenue-bearing scenarios (six fixed plan/cycle offers and three overage cases) from seven funded exposure scopes: trial, setup, full refunds, non-payment, post-cancellation, paused accounts and accrued legacy credits. Every scope requires explicit maximum occurrences in the worst recognized month and complete per-occurrence cost/tax ceilings, even when the reviewed occurrence cap is zero. Expected conversions, future invoices and another scope's profit cannot offset losses. Full refunds preserve non-refundable card fees, taxes and service costs.

Every funded trial, setup and ended AI allocation must also appear in the corresponding exposure occurrence cap and full per-case AI cost. Those pools cannot disappear from the company accounting even when paid customer AI is covered.

The sum of all simultaneous losses must fit the reviewed monthly exposure ceiling. The entire ceiling is then added to the company fixed-cost ceiling before calculating the minimum paid base, with no assumed tax deduction. Each paying customer's surplus above 60% funds its equal allocation of this total. The weakest of all six plan/cycle cases determines the base, using exact annual normalization. A base of one is accepted only if that customer's own surplus covers the full allocation. A base below the computed minimum cannot approve commercial release.

The former demand that every free/refund case independently earn 60%, and that one customer always carry all company fixed expenses, is replaced by this explicitly authorized allocation. The 60% test on paid customer units is unchanged. Reviews bind these rules in the price-and-rights snapshot. Missing, expired, underfunded, unbounded or incomplete exposure reviews keep release closed.

This is a review calculation, not a live enrollment ledger. Actual acquisition occurrence limits, reserve availability, active paid-base observation, retention risk, legacy obligations and supplier enforcement still need runtime admission controls and evidence. Existing refund rights or accrued credits may not be denied to fit a new budget. New exposure must stop before exceeding a reviewed allocation; old obligations require sufficient reserves. The actual commercial review and the exposure policy remain null (the AI and upload policies are computed in code for paid plans only, docs/automatic-spend-policies.md), so this change does not authorize sales, certify tax rates or establish the real minimum customer count.

The first runtime integration is now the persistent exposure reservation before non-paying AI dispatch; see [exposure admission](exposure-admission.md).

Since 17 October 2026, under the owner's decision "Teto mínimo pago pela empresa" (AGENTS.md), every store that pays nothing (a free trial, no plan, an ended plan) must hold one of the calendar month's shared places before its studio, its public pages and requests, its orders and free copies or its emails cost anything (lib/free-pool.ts). The places are `FREE_POOL_BASE_STORES` (10) plus one for every `PAID_STORES_PER_FREE_STORE` (40) paying stores (lib/free-pool-rules.ts). Each such store has small figures of its own: a free trial counts its figures for the trial as a whole (1,000 visits, 100 orders paid and free together, 300 list emails on a trial of a plan with them, and the studio, API and email figures of `NON_PAYING_ALLOWANCES`), and a store with no plan or an ended one counts smaller ones by calendar month. tests/plan-cost-registry.ts works out the worst window one of them can cost (`nonPayingWorst`, about $1.36 at today's rates) and puts 1/40 of it into every paying plan's worst month (line free-share), held with the rest to the owner's 60%. The ten base places are a company fixed cost of at most ten times that worst window a month, covered by the minimum paid base. Files an ended store keeps were, until 18 October 2026, kept up to a store with no plan's room with no date: storage with no use behind it, for ever. Since that day a plan that ends keeps nothing past its closing day (`lib/plan-closing-rules.ts`, `keptRoomFor`; the same notices and checks as before), and what it keeps until then is priced once per payment in the payment's own worst case (`tests/plan-cost-registry.ts`, `PER_PAYMENT_LINES`, `retained-files`), so it is no longer an open exposure. A plan that ended before that day keeps the old rule; plans could not yet be bought then (lib/commercial-margin.ts is closed), so this legacy exposure is at most the owner's own test stores, and any such store must still be counted here before release. This does not implement the remaining enrollment, reserve migration, other-provider or annual-term controls.

## What a store keeps in the database after its closing day

Since 18 October 2026 every store has a data room in the database (`lib/store-data-rules.ts`, `DATA_ROOM_BYTES`): what it keeps and what its orders leave is counted where it is written (an order at what each of its writes really adds, `lib/order-data.ts`, docs/order-data.md) and refused past the room, and every record kept outside the room is bounded in `tests/store-data-registry.ts`, which fails for a new key family that does not say how. `tests/plan-cost-registry.ts` prices the room full and the records outside it in every paying plan's worst month (line `database-storage`), and once more for the closing days after a plan ends (`PER_PAYMENT_LINES`, `retained-data`). A store that pays nothing has a small room of its own (`NON_PAYING_DATA_ROOM_BYTES`), priced in its worst window (`nonPayingWorst`).

Both exposures of the database after a plan ends are closed:

- **After the closing day: closed (18 October 2026), and priced per customer.** A plan that ends from 18 October 2026 closes the whole store on its closing day, whether it keeps files or not (`lib/plan-closing-rules.ts`, `closesStore`): the same three notices, the same week after the last and the same check with Stripe, and then that day its memberships' renewals are stopped on the creator's Stripe account, its PDFs' previews are deleted, its files go, and within the hour the walk (`lib/closed-store-data.ts`, `app/api/cron/closed-data`) deletes every record it keeps in the database, family by family as `CLOSING` in `lib/data-families.ts` declares for every family of `tests/store-data-registry.ts` (`tests/closing-families.test.ts` fails for a family that declares nothing). Nothing of its sales is copied anywhere: Marktmorgen is not the seller of record, every sale, refund and payout is on the creator's own Stripe account, and Marktmorgen's own records are its invoices and fees on its own Stripe account (question 13 of docs/tax-uncertainty.md). What is left: the company's declared records (the closing job's dates for 400 days, the store's addresses held back 30 days); keys that name no store, such as what a sale left under its own reference, gone by themselves within the days `CLOSING` declares (430 at the most); and the store's id in a person's records across stores (a buyer's library, the lists they joined, an affiliate's hub), never shown once the store is gone and run out by the quarter it was written in, 39 months at the most after its last quarter (`lib/joined-stores.ts`). `tests/closing-journey.ts` closes a store with a key in every family against a real Redis (`scripts/test_closed_store_redis.py`) and the in-memory one, with an in-memory file store.

  The owner's rule is per customer, and a closing is part of one customer's life, so its worst cost is in that customer's own margin, not the company's: `tests/plan-cost-registry.ts` prices it once for each store in `PER_PAYMENT_LINES` (`closure`), which `tests/spend-floor.test.ts` adds to every payment, so a store that paid one month and closed carries all of it, and every plan keeps 60% with its buffer by the month and by the year. Its parts, each at the ceilings the code holds by itself:

  | Plan | Its deletes | What its followers read | Its whole export after its plan ended | Its last steps | Once for the store |
  |---|---|---|---|---|---|
  | Store | $0.0018 | $0.0018 | $0.0037 | $0.0015 | $0.0087 |
  | Studio | $0.0056 | $0.0085 | $0.0080 | $0.0015 | $0.0236 |
  | Scale | $0.0106 | $0.0155 | $0.0123 | $0.0015 | $0.0398 |

  Taking one's data away is a right: once a plan has ended, the store has `ENDED_STORE_EXPORTS` (1) whole export of its own before it closes, counted for the store (app/api/store/export), never taken from a studio figure or the share of stores that pay nothing, so never refused for want of room or a place, and priced above at the largest store there can be (its room and record, every product, course, lesson, post and form there can be, read together, and its sales' pages at Stripe, the two lists side by side). What an order leaves for its store's closing is priced with the order (`ORDER_COST`): its buyers' library entries for their whole life, and its share of stopping a renewal at Stripe, 25 at a time. The store's id left in a person's records that the registry already counts as the company's (the lists they joined, an affiliate's hub) is the company's as those records are, now bounded: it runs out with the quarter it was written in. A free trial's store closes the same way, $0.0084 at the most, in the share of stores that pay nothing (`nonPayingWorst`). To make room, the closing's costly parts were made cheap (nobody's library walked buyer by buyer, deletes 4,000 keys a command, followers and the export reading a hundred to a thousand records a command), what a store writes after its plan ends is bounded by an ended store's own figures, and `retained-data` no longer counts again what a unit writes and lets go by itself, because each window's share of `database-storage` already pays for its whole life (`lifetimeByteMonths`, held for every part). With all of it, the room over the floor is $0.2504 for Store by the month, $1.0124 for Studio and $1.0096 for Scale by the year, each above its buffer ($0.25 and $1), and no price changed. The walk itself, reading the whole database, is the company's scheduled job: once a day at the most, for every store due since the last, at about $0.0044 a walk for every million keys ($0.14 a month for every million keys at one walk a day), and its hourly check is two commands when nothing is due.
- **Data kept before 18 October 2026: closed by the one-time count.** A store's records written before the room was counted were counted only as they were next written or moved. `lib/data-recount.ts` (`app/api/cron/recount`, hourly until done) measures every key of a family the room counts, finds its store by the ids that name it, and sets the store's room slot `legacy` to what was measured beyond what the room counts, so every room is at least as full as what its store keeps. Bounded per run, resumable and idempotent (docs/order-data.md). Release should wait until it reports done. Keys that name no store (a mark under a payment's id, an address's library across stores) are not anyone's room and stay bounded by their own entries in `tests/store-data-registry.ts`.

The database is priced as one region. A read region added in Upstash keeps a copy of everything and is billed for it: it multiplies the `database-storage` and `retained-data` lines by the number of copies, and must be priced before it is turned on. `tests/upstash-single-region.test.ts` fails if the code or the deployment ever configures one; switching one on in Upstash's console is the owner's act, and must wait for that price.

Moving orders older than 90 days to R2 was asked for and is not built: docs/order-data.md ("Asked for, and not built here") says why, with the measured sizes, for the owner's decision. Deleting a closed store's records at its closing day is built (above); keeping its sales in R2 for 7 years was built and taken out the same day, because they are the creator's records, not Marktmorgen's.

## EC1 — A closing store fair to its buyers: post-cancellation exposure (queue item 307, 30 October 2026)

Queue item 307 [EC1] (owner's request of 23/10/2026, 15h58 Fortaleza, and its complement of 30/10/2026, 13h12) adds to every closing of a store whose plan ended from 31 October 2026 (`BUYER_NOTICE_FROM`): its members held from the plan's end (Stripe pause of collection, invoices voided, `lib/closing-holds.ts`), one service email to each of its buyers at least 7 days before the closing and one follow-up ("the store stays" or "your refund could not be made", `lib/closing-buyers.ts`), and its members' unused time refunded from the creator's own Stripe account (`lib/closing-refunds.ts`). The refunds are the creator's money on the creator's account, never Marktmorgen's: each is made only when the account's available balance, read first, covers it.

What Marktmorgen pays for it is bounded per closing, before any of it is spent: the closing's emails are set once, when its members are held, at `EMAILS_PER_BUYER_PER_ENDING` (2) for each buyer `buyerNoticeCap` allows (`BUYER_CAP_MONTHS` = 24 months of the plan's orders; a free trial's 100 orders for a store that never paid), and every email is taken from them first (`lib/closing-credit.ts`). Each buyer at its cap is costed at `CLOSING_BUYER_COST` (tests/plan-cost-registry.ts): two emails at the dearer provider's $0.0009, its address and a member's last payment kept for the closing days, its share of a page of the store's own payments (found by Stripe's search on their metadata, at most `buyerPagesCap` pages a closing: past it the rest are counted as not told), and `STRIPE_CALLS_PER_MEMBER` (8) calls to the creator's Stripe account, each held two seconds at 2 GB. The calls are capped like the emails: when the closing starts, its call budget is set to `STRIPE_CALLS_PER_MEMBER` for each buyer the cap allows (`startCallBudget`, `lib/closing-holds.ts`), and every call for a member (listing its open and draft invoices, voiding them or keeping drafts as drafts and letting them go on a release, reading its paid invoices, its hold, its release, a retry, and its refund: the payment, the refunds made and the refund) is taken from it before it is made (`takeCalls`). The three calls of a member's refund are set aside when it is held (`REFUND_CALLS_PER_MEMBER`, "rcalls"), so the holds' daily retries can never spend them; a later try of a refund the balance did not cover takes from the rest of the budget. On the closing day a refund the budget cannot cover is told to its member like one the balance did not cover. A member past the budget is not held and is counted for the creator in every notice and in the studio. Each membership's end on the closing day is not in this budget: it is the one its order already pays for (`ORDER_RENEWAL_STOP` in `ORDER_COST`), and it is never refused, so no member is charged after the closing. One closing at its cap (`closingBuyersCost`):

| Plan that ended | Buyers at the cap | Ceiling of one closing |
|---|---|---|
| Store | 4,800 | $9.15 |
| Studio | 10,800 | $20.60 |
| Scale | 36,000 | $68.65 |
| A store that never paid | 100 | $0.19 |

**Why it is here and not in the closure line.** The item asked for it in the closure line (`PER_PAYMENT_LINES`). Priced there, at the price list of 18 October 2026 Store's monthly unit no longer keeps the historical 60% sizing floor that tests/limits-proposal.test.ts, tests/pricing-optimization.test.ts and tests/pricing-usage-proposal.test.ts hold (they propose cutting Store's visible figures for a few cents a month), and no test may be relaxed. So it is carried as the company's post-cancellation exposure, one occurrence per closing (a closing follows at least a payment or a trial), at the ceilings above; the exposure review stays null and release stays closed, as before. Whether to move it into the closure line (with a price change) or lower the cap is in "Depende do dono" of docs/codex-queue.md, item 307. Buyers past the cap are not written to by Marktmorgen and are counted for the creator in every notice and in the studio, so nothing is silent; while the cap is what it is, a store with more distinct buyers than its cap is the one case the checkout's sentence does not cover in full.

No company postal address exists yet (`lib/company-postal.ts`, empty): until it does, no buyer is emailed, and a store whose buyers must be told does not close (its retention continues inside the existing closing-days exposure). This is a release condition, not a cost.

**A plan paid for a store already closing (queue item 307 [EC1], with item 569 [NC1]).** From the start of its closing day a store refuses a plan checkout, but one opened before can still be finished on it. That plan is ended at once and its payment refunded in full from Marktmorgen's own Stripe account (`lib/closing-plan-guard.ts`): it is the money the creator paid us, given back, so the refund itself is not a cost, but the receiving cost of that one payment (`lib/receiving-costs.ts`, the dearer provider's fee on the amount charged) is not given back by Stripe on a refund and is the company's. It is a full-refund occurrence of this review, never offset by another scope. **Bounded by the owner's decision of 30/10/2026, 18h16 ("faça o correto"; "Depende do dono" (d) of item 307 resolved):** starting a plan again during the closing period stays open, because it saves the store, but from the plan's end every plan checkout of the store lasts `CLOSING_CHECKOUT_SECONDS` (31 minutes: Stripe's minimum of 30, docs.stripe.com/api/checkout/sessions/create, and one for clocks), and none is opened from `lastPlanMoment` (the closing day less 32 minutes; the studio shows the exact moment, in UTC). So no plan checkout of the store is open when its closing day begins; the open ones are expired then anyway (`expirePlanCheckouts`), and a new one is refused until the store's records are gone. What is left is a payment submitted on a checkout before it expired that Stripe confirms only after the day began (a delayed payment method), or one that Stripe completes later than its own expiry. Each is at most one occurrence per closing: the contract funding allows one pending checkout grant per store (`pending: 'one-grant-per-store'`, lib/contract-funding-rules.ts) and a store whose plan is paid is refused a second checkout (`billing=already`). Its ceiling is the receiving cost of the dearest plan payment a store can make (Scale yearly, from `lib/receiving-costs.ts`), and the refund guard (`lib/closing-plan-guard.ts`) ends it and returns the money. Like every scope here, the exposure review stays null and release stays closed.

## Support mail sent on through SES: a company fixed cost with a ceiling (9 November 2026)

ALTO 1 of Claude 5's email audit (9 November 2026): every message written to our own support addresses was sent on through SES as a company email (`lib/inbound-mail.ts`, `forwardInbound`), with nothing bounding it but the webhook's per-connection limit, and the connection is Resend's, not the sender's. One sender writing 300 times with 1 MB each had all 300 messages and 300 MB sent on; the only real bound was SES's 24-hour quota (about $120 a day at 15 MB a message), and spending that quota also stops buyers' receipts and sign-in links.

Each forward is now counted before anything is fetched or sent, and a count that cannot be read sends nothing (Resend tries again); a message tried again is counted once:

| Ceiling | Value | Where |
|---|---|---|
| One sender, however the address is written (`canonicalEmail`), an hour | `SUPPORT_SENDER_HOURLY` = 10 | `lib/inbound-mail.ts` |
| One sender, a day | `SUPPORT_SENDER_DAILY` = 30 | `lib/inbound-mail.ts` |
| Every sender together, a UTC day | `SUPPORT_DAILY` = 200 | `lib/inbound-mail.ts` |
| Files sent on, a UTC day, before base64 | `SUPPORT_FILE_BYTES_DAILY` = 300,000,000 | `lib/inbound-mail.ts` |
| Notice to the inbox that messages are held, a UTC day | `SUPPORT_HELD_NOTICES_DAILY` = 1 | `lib/inbound-mail.ts` |

A message past a ceiling is held, not dropped: it stays in Resend (Emails, Receiving), is not tried again, and the inbox is told once a day where to find it. A file past the day's bytes is left out and named in the message ("Not attached (see Resend, Emails, Receiving)"). The store path keeps its own `CREATOR_HOURLY` and is one of the store's emails, not this cost.

**The month at the ceilings: $29.72 at the most** (`supportForwardMonthlyUsd` in tests/plan-cost-registry.ts, held by tests/support-forward-ceiling.test.ts): 31 UTC days of 201 emails, each at `PER_EMAIL` ($0.0009, Resend's overage, dearer than SES), the route's whole 60 seconds of CPU and memory and `SUPPORT_FORWARD_COMMANDS` database commands ($0.0045 a forward), plus 31 days of files at 4/3 for base64 at SES's $0.12 a GB (read 18 October 2026 in docs/pack-cost-decomposition-2026-10-18.md; not read again on 9 November 2026, aws.amazon.com being blocked in that session). It belongs 100% to Marktmorgen among the LLC's fixed costs (FX275) and is covered from the minimum paid base under MR item 2.

Not in that figure, so the complete month stays unknown, never zero: announcements of held messages (a function call, a read at Resend and a few commands each, bounded only by the webhook's per-connection limit and Resend's own receiving quota), transfer out of the function to SES, and Resend's count of received mail against its plan.

## LE448 — exposição própria da lista de pré-abertura (em implementação)

Pedido do dono26/10/2026 00h19Fortaleza. A lista da plataforma não é uma loja
fictícia, uma assinatura paga ou conversão futura. O escopo canônico
`platform_waitlist` passa a integrar a mesma revisão de exposição, o mesmo teto
de caixa e o mesmo ledger `nl:exposure:v1:YYYY-MM`; não cria um ledger paralelo,
não reinicializa saldo/slots nem usa uma loja inventada sob `setup`.
Revisão antiga sem esse caso é desconhecida e reprovada; interesse não pode entrar
como receita no caso. Tetos nulos, custos/impostos desconhecidos e ausência de
enforcement continuam reprovando. Nenhuma política atual deixa de ser nula.

O escopo tem slots/recibos próprios, preservando os recibos e obrigações dos demais
escopos. A reserva é permanente para a identidade/escopo/mês aprovada; repetir uma
operação não cria dinheiro ou slots. Faltando campo no ledger, a operação recusa
sem inicializá-lo. Configurar slots não autoriza enviar e-mail: ainda são
necessários o protocolo completo de consentimento, limites diários/mensais por
operação e o binding da unidade financiada à identidade/coorte real.

Antes de admissão, a revisão deve abranger inscrição, validação de e-mail,
confirmação, saída, consentimento exato/datatado, dados opcionais, retenção,
consultas/recusas/repetições, resumo semanal privado/CSV, armazenamento/transferência,
e-mail de abertura e novidades separadamente consentidas. Quantidade máxima de
casos, custo completo por caso e reserva são desconhecidos; não se publica aqui
um orçamento zero, uma base mínima ou margem aprovada. O teto por operação é
adicional à reserva de exposição, não substituído por ela.

Verificações adicionadas exigem contabilidade conjunta e recibos separados,
64concorrentes limitados a dois casos sintéticos e ledger antigo sem campo
recusado sem escrita, tanto no código real quanto no Lua real em Redis descartável.
Valores20/100/140/240centavos usados nesses testes são exclusivamente sintéticos,
não preços/tetos do produto ou custos oficiais. Nenhum envio, inscrição real,
conta, cobrança, obrigação fiscal ou gate comercial é ativado. Custo incremental
deCI permanece desconhecido, sem reduzir tetos/reservaFX275. LE448 integral não
está implementado, publicado ou usado ponta a ponta por este incremento.

### LE448 — núcleo compartilhado de tokens e isolamento de finalidade

A geração de tokens48hex, o identificadorRedis `nl:wl:t:sha256(token)` e o decoder
de grants de loja são extraídos para `lib/waitlist-tokens.ts`; a lista existente
importa esse núcleo e reexporta WAIT_TOKEN. Tokens/URLs/keys de lojas, seus
vencimentos, consentimento e dados permanecem compatíveis com grants legados
produzidos pelo código. A extração não cria lista, conta, e-mail, armazenamento,
cadastro ou boletim duplicado e não emite token de plataforma em produção.

Grants de plataforma possuem discriminador/versionamento próprio, finalidade
confirm/leave, identidade opaca de entrada e geração (para futura comparação CAS
no registro), emissão e vencimento absolutos. O decoder de loja recusa grants
com escopo de plataforma; o decoder de plataforma não aceita grants de loja,
finalidade trocada, geração/identidade inválida, dados excessivos, relógio
inválido, emissão futura, vencimento ou vida maior que confirm7dias/leave365dias
já usados pelo mecanismo. Só devolve dados de roteamento, sem e-mail/país/plano
ou afirmações de consentimento/autorização. A identidade hash não é anonimização
dos dados privados: futuras leituras continuam exclusivas ao fluxo autorizado.

Validar um grant não consome token, confirma inscrição nem autoriza despesa.
Comparação atômica da geração no registro e confirmação/saída/reentrada/outbox,
registro do consentimento exato/datatado, orçamento, políticas de retenção,
remetentes sintéticos, UI e resumo/CSV privado ainda estão pendentes no protocolo
integral LE448. Não se afirma que geração antiga já seja recusada contra uma
base que este incremento não cria. Testes novos cobrem compatibilidade, separação
entre listas/finalidades, tempo e dados indevidos; testes existentes de waitlist
também devem passar no CI completo do novo head. Nenhuma execução local ou
operação real; sem novo fornecedor/custo variável de operação, incremento real
deCI desconhecido e sem redução de tetosFX275. Sem entrega funcional adicional.

Correção do primeiro head422ca4793956b1b05ef7dcefe2ba132cbb00538a:
verify121401603679 falhou em26/10/2026 01:45:43Fortaleza no inventário de chaves,
porque o literalnl:wl:t: mudou para o núcleo compartilhado e sua família ainda
apontava ao arquivo antigo. Os seis testes novos e32checks legados de waitlist
passaram; isso não basta para aprovação geral. A entrada do registro é movida
para o novo arquivo, mantendo exatamente room/lib/waitlist.ts, partes, bytes,
retenção, unidade e custos: sem entrada duplicada, exceção ao scanner, mudança de
teto ou redução de custo. Nova verificação completa obrigatória no novo head.
