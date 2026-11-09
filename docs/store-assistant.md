# Store assistant (paid add-on), 17 Oct 2026

> **TX vigente — dono, 27/10/2026, 12h34 Fortaleza.** As referências anteriores deste documento à regra 19, à leitura que dá mais imposto, ao ISS de 5% como certo ou a consultas tributárias ficam preservadas como histórico e são substituídas, nos pontos conflitantes, pela política TX de [AGENTS.md](../AGENTS.md). Nenhuma consulta será feita ou preparada para envio. As taxas de recebimento mais caras, SR, desconhecido reprova, reservas, exposição e custeio continuam obrigatórios. A [matriz TX1](tx-legal-source-review-2026-10-27.md) distingue fontes conferidas e lacunas; não certifica incidência zero. O código e os números antigos ainda não adaptados não provam a nova leitura; revisão e regeneração pertencem a TX2/TX5. Flags continuam false.
>
> **SV vigente — dono, 27/10/2026, 13h19 Fortaleza.** EU1 e SV1–SV5 ficam depois da abertura, com trabalho e provas preservados, sem novos PRs desses itens até lá. EU_HOSTING_CONFIRMED permanece false e não é condição de abertura por decisão do dono; a retirada técnica da dependência está em TX2. A conferência de DPF/SCC dos fornecedores atuais segue no Bloco de abertura, sem aceitar termos ou contratar.


> **MR vigente — dono27/10/2026 07h42 Fortaleza,464[MR1]:** [REGRA DE MARGEM](../AGENTS.md#mr--regra-de-margem-vigente-27-de-outubro-de-2026) substitui todos os pisos históricos de60% neste documento e suas referências. Exigir lucro líquido por unidade maior que zero no pior caso com a folga existente do spend floor,100% direitos mensal/anual e complementos; empresa sem prejuízo a partir de base mínima calculada com100%FX275 e exposições.60% é meta real mensal da empresa. Preservados ISS5%, leitura mais onerosa, recebimento mais caro, reservas/tetos/gates; desconhecido reprova, não é zero. Texto/citações/números antigos abaixo são histórico, não recalculados nem certificados. Código/relatório/regeneração pertencem a MR2; resultados atuais a MR3. Sem mudança de preços/limites/comissão/vendas.


One add-on, **Store assistant, $69 a month per store** ($49 until the owner's price decision of 18 October 2026, 11:21), on any plan once the plan is paid (not during the trial). It has three functions that share one monthly pool of AI replies, built in this order:

1. **24/7 store Q&A chat** on every page of the store, grounded only in the creator's own published products, pages and FAQ. **Built here** (`lib/store-assistant-rules.ts`, `lib/store-assistant.ts`, `components/store-assistant.tsx`, `app/api/store/assistant`).
2. **After-purchase next product** chosen among the creator's own products. **Built** (`lib/next-offer-rules.ts`, `lib/next-offer.ts`, `components/next-offer-card.tsx`, `components/next-offer-box.tsx`, `app/api/store/assistant-next`), design below.
3. **One reminder after a checkout left unpaid, only when asked for at checkout.** **Built** (`lib/assistant-reminder-rules.ts`, `lib/assistant-reminder.ts`, `components/assistant-reminder-box.tsx`, `lib/buyer-words/assistant-reminder.ts`, `remindAssisted` in `lib/checkout-recovery.ts`), design below.

It is published but **not sold**: `ASSISTANT_ON_SALE` (`lib/opening.ts`) is `PLANS_ON_SALE && assistantMeetsFloor()`, and `PLANS_ON_SALE` stays false behind the commercial review and the most-tax reading (`docs/tax-uncertainty.md`). The checkout route refuses with `assistant=not-open` and never reaches Stripe.

## Market (read 17 Oct 2026, scratchpad research, official pages)

- Kajabi Sales Agent: $79/month per agent on a $179+ plan, 1,000 messages + 250 AI credits, hand-over to a person is manual only ("does not escalate automatically"), lead capture by email only, GPT-5.4.
- HighLevel Conversation AI (H36): Growth $50/month for 1,000 agent responses; Unlimited $97 "fair use".
- Circle agents only on Scale ($419) / Plus; Thinkific Thinker only on Plus; Stan, ClickFunnels, Skool: no buyer-facing agent; Hotmart Tutor answers "as if it were you" (what this must never do).

How this one is different, each in code: works on every plan; hands over by itself (keyword pre-check before any model call, and the model's own `handoff` status) into the existing inbox with the buyer's email; refuses in code any reply with a number, a deal word, a code or a link that is not in the creator's own published words (`heldToFacts`); the AI label is drawn by the page and sent by the server, never written by the model; the chat becomes a no-AI "leave your question" form when the month is used. It gives fewer replies a month than Kajabi or HighLevel (700): that is what the owner's 60% floor allows at $49 with every cost counted, and the page says the number.

## Cost per message and the allowance (binding)

Model: **Claude Haiku 5.5**, the cheapest current model (platform.claude.com pricing, re-read 17 Oct 2026: $0.10 in / $0.50 out per million tokens for prompts up to 100,000 tokens; $0.50 / $2.50 above, which the 24 KiB cap never reaches). Fixed in `ASSISTANT_MODEL`, not overridable by a deployment setting.

Worst case of one message, `assistantMessageWorstMicroUsd()` = **$0.003539**:

- model hold at the caps (`ASSISTANT_INPUT_BYTES` 24,576 bytes counted as tokens + framing, `ASSISTANT_OUTPUT_TOKENS` 320), the cost table's 10% provider allowance (invoice tax, FX, remittance to the provider) and the 45-second function wait at 2 GB: **$0.003339** (`aiRequestHoldMicroUsd`, `lib/spend-cost-table.ts`);
- the message's own database work: 40 commands, the store record (1 MB at most), 40 products and 6 stored pages read, the conversation read and written, and a day of keeping it plus four months of one unanswered question: **$0.000200**.

One payment of $69 at full use (`assistantMonthWorst()`), all in whole cents rounded up, received in the one model every plan and add-on is held to since 18 October 2026 (`lib/receiving-costs.ts`; `docs/margin-alignment-2026-10-18.md` is generated from it and holds the figures for every unit):

| Line | Cents |
|---|---:|
| Dearer provider's fee on the amount charged, $69 plus the buyer's tax on top at 27% ($87.63): Stripe 2.9% + 1.5% international + 1% conversion + 0.7% Billing + 0.5% Tax = 6.6% + 30¢ (Paddle 5% + 50¢ is cheaper) | 611 |
| Remittance allowance, 1.5% of revenue | 104 |
| Dispute reserve: 1 payment in 100 lost with both $15 fees, on the amount charged | 118 |
| Refund reserve: 1 payment in 100 refunded (refunds only where the law requires) | 69 |
| AI: 700 replies at the worst | 248 |
| **Total** | **1,150** |
| Most a payment may cost and keep 60% after 27.5% (P × 5/29, `maximumPretaxCostCents`) | 1,189 |
| Room kept (`ADD_ON_ROOM_CENTS` ≥ 25) | 39 |

Net after 27.5%: **60.40%**. At $49 it kept 59.06%, $0.46 short; the owner set the price instead of cutting the replies or the input a buyer's answer reads (18 October 2026, 11:21: "preço: o que maximiza o meu lucro", docs/value-presentation-2026-10-18.md). $69 is the lowest round price above its floor with room ($65.90); the 39¢ left is too little for a round step in replies, so the 700 stay. So `assistantMeetsFloor()` is true, and the add-on is still not on sale, because `ASSISTANT_ON_SALE` also needs `PLANS_ON_SALE`, which the tax gate and the EU art. 9a gate keep false. Under the most-tax reading (VAT 27% inside the price, US 37%, California 13.3%, Brazil 27.5% and IOF without credit, ISS 5% of revenue) it keeps about 12%: it fails like everything else.

Emails and inbox messages a hand-over makes are taken from the plan's own figures (`inbox`, `store-email` lines of `tests/plan-cost-registry.ts`) and refused past them, so a plan's worst month is unchanged by the add-on. Every request of the chat is a public request of the store's window (`withinStore`): a question asked (`ask`, counted before the model is asked), and the non-AI ones (read, delete, hand-over).

The registry line is `ADD_ON_LINES` → `store-assistant` in `tests/plan-cost-registry.ts`; `OPEN` stays `[]`. The terms are bound into `CURRENT_COMMERCIAL_TERMS.storeAssistant` (schema 19), so any change invalidates an earlier review.

## Enforcement (before every model call)

`nl:assist:pool:<statsId>:<add-on period start>` holds the month in micro-USD (`ASSISTANT_POOL`, one Lua script, real-Redis test `scripts/test_assistant_pool_redis.py`):

- `reserve` a message's worst cost (`assistantMessageWorstMicroUsd`: the model at every cap and the message's own reads, writes and keeping) before anything of the store's products or pages is read; refused (0) when the pool cannot hold it → the chat becomes the creator form, with no catalog read and no AI cost;
- the reads are paid from that reservation: a message stopped before the model (its request too large, or the catalog read failing) is settled at the message's extra (`assistantMessageExtraMicroUsd`), and given back whole only when the facts were read by the caller;
- `settle` at what the model billed (its `usage` token counts at the same rates and allowance, plus the call's own cost `AI_CALL_INFRA_MICRO_USD` and the message's extra), giving back the rest;
- when the provider answered with an error status (not billed), the call was still made and waited on: settled at the call's own cost and the message's extra, as an answer is, the rest given back; a timeout or lost connection may have been billed, so it is settled at the full hold;
- the cap a month opened with is kept and only ever lowered; the key expires 40 days after it opened.

The window is the add-on's own paid month (`assistantWindow`), with the same two-day renewal grace as `lib/allowance-window.ts`; unknown is closed. Only `status: active` answers (no grace for an unpaid month of AI). Burst limits: 10 per visitor in 10 minutes, 40 a day, 20 per store a minute.

## Billing

Its own monthly Stripe subscription on the store's existing customer (`lib/assistant-billing.ts`): a yearly plan cannot carry a monthly line, and `planOf`/`periodStart`/`tier-switch` read a subscription's first item as the plan. Metadata `addon=assistant`, `assistant_for=<handle>`, never `store`, so `findStoreSubscriptions` and the daily sync never read it as a plan; `failedPlan`/`dueReminder` pass it over. The first payment asks for 3-D Secure. The daily sync (`lib/billing-sync.ts`) brings it in line, ends it at once on a disputed payment (and never sells it to that store again), and sets it to stop at the period's end when the plan is no longer paid.

## Privacy

Kept: the conversation for 24 hours after its last message under a random token in the buyer's browser, with addresses, phone numbers and links taken out (the model never sees them either); deletable at once ("Delete this chat"). Unanswered questions for the creator for ~4 months, never who asked. A hand-over goes into the inbox with the email the buyer typed, kept and erased as the inbox is (180 days, `lib/person-erasure.ts`). Registry: `lib/person-data.ts`. Privacy policy `#store-assistant`, Terms `#store-assistant`, Refund Policy `#store-assistant`.

## Function 2: one next product after a purchase (built 17 Oct 2026)

Switched on by the creator (`store.nextOffer`, studio, Pages → Store assistant), shown only while the add-on's month is paid (`nextOfferShown`). On the thanks page after a paid order, streamed in a `<Suspense>` boundary so the page never waits on it, one card: the product's title, its published price (`pricePill`), its own summary, a link to its own page (an ordinary checkout) and "No thanks" (`app/api/store/assistant-next`, kept as dismissed for the order). Not shown while an offer after paying is waiting on the buyer, or while a page funnel's next step is.

**What may be offered.** Only a product the store lists and can sell today (`canSellProduct`), with no limited number, not a bundle the buyer builds or one holding something owned; never the product bought, anything in the order (boxes, bundle items, offers taken after paying), anything turned down after paying (`FunnelView.declined`), or anything the address bought before: its completed checkouts and one-click offers on the creator's Stripe account, by the address paid with, and imported purchases (`ownedHere`; a Stripe error or more than one page means nothing is offered).

**How it is chosen** (`nextChoice`): the creator's picks ("goes well with"), then the product's offers after paying, then its checkout boxes, then the rest of a collection it is in; otherwise the store's order. Only in that last case, with at least two candidates (`modelAddsValue`), is the model asked to pick one by number among at most 16 candidates (plus up to 8 of the creator's own choices read), told only the products' titles, prices, delivery and summaries, nothing about the buyer. It is labeled "AI suggestion" by the page; its one sentence of why is shown only when `heldToFacts` passes against those products' published lines, otherwise the product's own summary is. A choice out of range, an error or a spent pool falls back to the store's order.

**Cost.** The model call is reserved from the same pool (`ASSISTANT_POOL`) at `min(assistantMessageWorstMicroUsd(), this request's hold + assistantMessageExtraMicroUsd())`, exactly as a chat message, settled at the billed tokens, released only when the provider answered with an error status, kept whole on a timeout. Its output is capped at 120 tokens and its reads (16 + 8 listings, one product record, about 36 commands) stay inside a chat message's priced extras (`withinAssistantReply`, tests/next-offer.test.ts), so one choice never costs more than one reply and **the add-on's month is unchanged: 700 replies, $8.04 of $8.44 allowed, 60.59% net after 27.5%** (`ADD_ON_LINES`, `OPEN` stays `[]`). Its reads and up to five Stripe calls count as `NEXT_OFFER_REQUEST_UNITS` = 6 public requests of the plan's window ($0.000378 against a worst of $0.000174, `NEXT_OFFER_READ`). One choice per order, kept 3 days under the checkout id (`nl:assist:next:`), with a one-minute lock (`nl:assist:nextlock:`), so reloads and the email ask nothing more.

**Email.** With "Also in the order's confirmation email" checked, the order's own confirmation (`lib/purchase-email.ts`) carries the kept choice in a few lines (label, title, price, its words, its link, "You see this because you agreed to hear from …"), only when the checkout's `news` consent is "yes". It never asks the model and never sends an email of its own; a buyer who never reached the thanks page gets no suggestion. Owner to confirm with counsel: the EU basis for a product mention inside a transactional email (here: explicit consent at checkout).

## Function 3: one checkout reminder, only when asked for (built 17 Oct 2026)

**Legal design: conservative, consent only**, because the owner has not yet confirmed with counsel which EU basis applies (consent or legitimate interest). Switched on by the creator (`store.assistReminder`, studio, Pages → Store assistant), offered only while the add-on's month is paid and the store has the postal address of its checkout reminders (`store.recovery.address`; without it the studio says why, the box is not shown and nothing is sent).

**The yes.** The buy box and the cart show an unchecked box, "Email me a reminder if I don't finish this order" (in the store's language, `lib/buyer-words/assistant-reminder.ts`), with an email field shown once it is checked (`.ask-remind`, works without scripts). Not a call, a gift, a purchase for a group or a pre-order. The checkout routes keep a yes only with the box checked, a valid address and the page's sentence version `ASSIST_REMIND_VERSION`: `nl:assist:remind:<checkout id>` = the address, the exact sentence, its version, its language and the time (ms), for `ASSIST_REMIND_KEEP_SECONDS` (3 days from the checkout opening), with the checkout noted under a one-way hash of the address for the same 3 days (`nl:assist:remindwho:`) so erasure finds it (`forgetAssistReminderPerson`, in `lib/person-erasure.ts` ERASERS); the queue `nl:assist:remindq` holds the store, its handle and the checkout, never an address. A checkout with the box checked closes after an hour (`expires_at`). Typing an address is never taken as consent. At most `ASSIST_REMINDERS_PER_STORE_DAY` = 50 yeses a store a day.

**The email** (`remindFromConsent`, every five minutes from `app/api/cron/mail`): an hour after the checkout closed (`ASSIST_REMIND_AFTER_SECONDS`), dropped six hours later. It reads the checkout from the creator's Stripe account: paid → nothing; still open → once more an hour after it closes. Then the shared `deliver` of `lib/checkout-recovery.ts`: never twice for one checkout (`nl:recover:sent:`, the same mark as Stripe's opt-in path, which now skips a checkout that has this yes), not when that address paid for those products since, pressed stop, left the list, bounced or was deleted (`lib/suppression.ts`), and not about the same products to the same address twice in a week. From the creator's name, with the postal address, the stop link (at once) and `List-Unsubscribe` one-click, the subject "You left … at checkout" / "Your cart at …", today's price, and "It reached you because you checked "…" at checkout on <day>." No discount, countdown, stock or review.

**The AI line** (`assistReminderNote`): only while the add-on's month is paid. The model gets the products' titles, descriptions and delivery (no price, nothing about the buyer), writes one line of at most 25 words, capped at `ASSIST_REMIND_OUTPUT_TOKENS` = 80; `neutralLine` refuses any digit, link, exclamation, deal word or pressure word (seven languages) or what `heldToFacts` refuses. It appears under "Written by AI from <store>'s own product descriptions:", drawn by the code. Spent pool, failed call or refused line: the same email with no AI line.

**Cost and margin.** The model call is reserved from `ASSISTANT_POOL` at `min(assistantMessageWorstMicroUsd(), this request's hold + assistantMessageExtraMicroUsd())`, settled at billed tokens, released only on a provider error status, kept whole on a timeout. Its products (4), output (80 tokens) and commands (40) stay inside a chat reply's caps (`withinReminderReply`), so **the add-on's month is unchanged: 700 replies, $8.04 of $8.44 allowed, 60.59% net after 27.5%** (`ADD_ON_LINES`, `OPEN` stays `[]`). The email is one of the store's own emails (`store-email` line): its room is read before the model is asked and it is taken before sending, refused past the figure. Its reads and two Stripe calls are `ASSIST_REMIND_REQUEST_UNITS` = 4 public requests ($0.000252 against a worst of $0.000187, `ASSIST_REMIND_READ`). The yes is at most 768 bytes and its note 256 bytes, for 3 days, 50 a store a day (`tests/store-data-registry.ts`). Commercial terms schema 21 (`CURRENT_COMMERCIAL_TERMS.storeAssistant.reminder`).

**Owner to confirm with counsel:** the EU basis (consent is used; legitimate interest is not relied on), whether three days of consent evidence is enough or it should be kept longer, and that a store's checkout reminder is a commercial email under CAN-SPAM (built as one: identity, postal address, opt-out).

## Follow-ups (not in this PR)

The reminder does not answer a question the buyer asked the chat in the same browser (it would need the chat token on the checkout session); it is not offered on calls (whose time is held only while the checkout is open), gifts, group purchases or pre-orders.

Also open: the buyer-language bridge (the creator reads a handed-over question translated and their answer goes back in the buyer's language) and citing the source block of each answer in the chat.
