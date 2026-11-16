# Live quiz with a creator-given prize: study

**Date:** November 6, 2026
**Queue item:** 661 [WG21]
**Status:** Study only: nothing built, nothing changed, nothing available to customers (VR).

## Resumo para o dono

- Pedido: quiz ao vivo na comunidade ou na sala ao vivo, com prêmio dado e pago sempre pelo criador, nunca pelo Marktmorgen.
- As regras de cada país **não foram lidas em fonte oficial**: todos os sites de governo e de leis estão bloqueados pela rede desta sessão (403). O teste de aceitação, na parte das regras por país, **não foi cumprido**. A tabela traz só pistas a conferir, nunca conclusões.
- Risco principal: o quiz fica dentro de uma comunidade paga. Em vários países, pagar para entrar com chance de ganhar pode virar sorteio ilegal, e no Brasil o "concurso cultural" sem autorização exige que não haja vínculo com compra.
- Solução AAA para o tempo: a pontuação conta só os acertos, nunca a velocidade, e as respostas ficam abertas por uma janela longa, sem contagem regressiva que feche a pergunta.
- Pior custo de servidor por sessão, com teto de 500 pessoas, 20 perguntas e 90 minutos: **cerca de US$ 5,94** com uma gravação por resposta, ou **cerca de US$ 3,14** com um envio por pessoa. Não há margem nova se cada resposta for descontada das franquias atuais. Parte do custo continua **desconhecida, não zero**.
- Recomendação: **não construir agora a versão com prêmio**. Se o dono quiser algo já, a menor versão segura é o quiz ao vivo **sem prêmio**. **Depende do dono.**

## Scope and rules of this document

This study responds to queue item 661 [WG21]. The item's text was not found in this branch's `docs/codex-queue.md`, which ends its WG items at 645 [WG5], so the text used is the one given in the brief. In plain terms, the item asks for this. A creator runs a live quiz inside their community or its live room. The creator writes the questions, and answers are timed. The prize is always access, the creator's own discount, or an item. The creator always gives and pays for the prize, never Marktmorgen.

This document changes no price, limit, commission, flag or gate. It creates no account, accepts no terms, signs no contract and contacts nobody. No code, test, route or page was added. Every figure below comes from constants already in the repository, cited by name.

## What exists in the code, and what would be new

### What exists

| Piece | Where | What it does today |
| --- | --- | --- |
| Course quizzes | `lib/quiz.ts` | One quiz per lesson. It holds up to `MAX_QUESTIONS` (20) questions with `MIN_CHOICES`–`MAX_CHOICES` (2–6) choices, single or multiple answer, and an explanation. The server does the marking (`gradeQuiz`). The correct choices never reach the browser before the student answers. It also has attempts (`MAX_ATTEMPTS`), a pass mark, a question bank, shuffling and a wait between tries (`lib/quiz-bank-rules.ts`). **No time limit per question.** Usage is counted per store: `QUIZ_MONTHLY_SUBMISSIONS` = 1,000 in `lib/quiz-usage-rules.ts`, priced in `tests/plan-cost-registry.ts`, line `quizzes`, at `request("light", 8)` each. |
| Live room (community chat) | `lib/community-chat.ts`, `lib/community-chat-rules.ts` | A text room stored as a sorted set. It keeps `MAX_CHAT_KEPT` (500) messages of up to `MAX_CHAT_TEXT` (1,000) characters, and each look reads at most `CHAT_PAGE` (100). The creator can set a cooldown of up to `MAX_SLOW` (300 s), switch links off, or make the room creator-only. An hourly ceiling applies per member (`RATE_LIMITS.comment`, 30 an hour, `lib/community-text.ts`, checked in `app/api/store/community/chat/route.ts`). Every message is one store "buyer action" (`takeBuyerAction`). |
| How "live" works | `lib/chat-pace.ts`, `lib/chat-grant.ts`, `lib/chat-pass.ts` | No socket. The page polls every `LIVE_MS` (5 s) while people talk and every `IDLE_MS` (30 s) while the room is quiet. It stops when the tab is hidden or after `AWAY_AFTER_MS` (20 min) without a touch. Each member gets a 10-minute grant (`ROOM_GRANT_MINUTES`). Each grant is counted toward the store's visits as `ROOM_LIVE_PARTS` (260 hundredths) or `ROOM_IDLE_PARTS` (60 hundredths) (`lib/traffic-rules.ts`). The creator is never counted. |
| Live events | `lib/community-events.ts`, `lib/event-meetings.ts`, `lib/call-rooms.ts` | A calendar event with a title, a start time, a length from `EVENT_LENGTHS` and a cap of up to `MAX_EVENT_CAP` (5,000). RSVP is atomic. The event takes place in a Jitsi room, the creator's own link, or Google Meet or Zoom. |
| Polls | `lib/community-polls.ts` | A poll on a post: up to 12 options, an optional end date, a tally hash, and one vote per member. |
| Hosted live streaming | Queue item 45 [H2] in `docs/codex-queue.md` | **To do, document only.** It covers a hosted broadcast billed by the minute with an automatic ceiling, extended by P4 to recorded calls, own broadcast with recording, and breakout rooms. Its cost rule: "qualquer custo desconhecido reprova implementação". No code exists for it. |

Nothing in `lib/`, `app/` or `components/` mentions a sweepstake, giveaway, raffle, contest or prize. That was checked with grep on November 6, 2026.

### What would be new (and is not built)

1. A **live quiz session** object tied to a community. It needs a start, an end, a state for each question (hidden, shown, closed, revealed), a participant list, and one answer record per participant.
2. **Ranking** by correct answers only (see the accessibility section). This is new: `gradeQuiz` marks one student against a pass mark, and it ranks nobody.
3. **Rules text** that the creator publishes, with a prize described as access, the creator's own discount, or an item. The text must say that the creator is the sponsor.
4. **Winner handling.** The creator delivers the prize. Marktmorgen holds no prize, no money and no stock.
5. A **free entry route** wherever the law requires one (see the jurisdiction table). This conflicts with the community's paid door, because a non-member cannot enter today.
6. **Admission against the existing figures** (buyer actions and visits) before a session starts. This uses the existing figures without changing them.

What it reuses without duplicating: question and choice validation and server-side marking from `lib/quiz.ts`, the polling, grant and visit counting from the live room, and RSVP and caps from live events. It does not overlap 45 [H2], because it needs no video, no streaming and no per-minute supplier.

## Jurisdictions: buyers' main markets

> **The acceptance test is NOT met for this section.** No rule below was read in an official source. On November 6, 2026, every official host this study needed was refused by the session's network policy. Through the proxy, the answer was `CONNECT tunnel failed, response 403`, which the proxy status records as "policy denial". Through the fetch tool, the answer was `getaddrinfo ENOTFOUND`. The only thing that worked was a web search restricted to each official domain. The search returned page titles and URLs on those domains, plus a machine-written excerpt. **Those excerpts are leads to verify. They are not readings, not exact quotes and not conclusions.** Every cell marked "Lead" must be confirmed by opening the official page before any decision is made.

Each column answers one question:

- **Pure skill quiz with a creator prize, no permit?** Can a quiz decided only by skill run without a permit?
- **Permit or registration:** When is a permit or a filing needed?
- **Rules text required:** Must the sponsor publish rules?
- **Minimum age:** Is there a minimum age?
- **Purchase-required restriction:** What happens when entry requires a purchase?

| Jurisdiction | Pure skill quiz with a creator prize, no permit? | Permit or registration | Rules text required | Minimum age | Purchase-required restriction | Official source located (not read) |
| --- | --- | --- | --- | --- | --- | --- |
| **United States: federal (FTC)** | Unknown, not read. | Lead: no general federal permit found in search. | Lead: FTC orders against a sweepstakes operator require the disclosure "No Purchase Necessary. A Purchase Will Not Improve Your Chances of Winning." That is a case order, not a general rule. | Unknown, not read. | Lead: FTC consumer page excerpt, "Real sweepstakes are free and by chance. It's illegal to ask you to pay or buy something to enter." It concerns chance promotions. Paid **skill** contests are a state-by-state question that was not read. | ftc.gov (`/system/files/ftc_gov/pdf/1823145pchorder.pdf`), consumer.ftc.gov |
| **US: New York** | Lead: GBL § 369-e covers games **of chance**, so a pure skill quiz appears to be outside it. Not read. | Lead: registration with the Department of State and a bond or trust when announced prizes total **more than $5,000**, with a $100 fee. Not read. | Lead: rules filed with the registration, listing each prize and its retail value. | Unknown, not read. | Unknown, not read. | nysenate.gov/legislation/laws/GBS/369-E; dos.ny.gov/games-chance-registration |
| **US: Florida** | Lead: § 849.094 covers "game promotions" (chance). Not read. | Lead: file the rules and a prize list with FDACS **at least 7 days** before start, plus a trust account or surety bond, when the total announced prizes are **more than $5,000**, with a $100 fee. Not read. | Lead: yes, filed. | Unknown, not read. | Unknown, not read. | leg.state.fl.us (Statutes 849.094); fdacs.gov/Business-Services/Game-Promotions-Sweepstakes |
| **United Kingdom** | Lead: a prize competition needs no licence if it meets s.14(5). The skill or knowledge required must be "reasonably likely" to stop a significant proportion of people from entering or from winning. The Gambling Commission excerpt says "multiple choice questions, or questions that allow a second chance if your first answer is wrong, rarely meet this criteria". **A plain multiple-choice quiz is therefore at risk of being a lottery when entry is paid.** Not read. | Lead: none for a compliant prize competition or free draw. The Commission "does not approve" them. | Unknown, not read. | Unknown, not read. | Lead: Sch. 2 para 8 offers a free entry route that is no more expensive, no less convenient and equally prominent. Not read. | gamblingcommission.gov.uk/public-and-players/guide/page/free-draws-and-prize-competitions; legislation.gov.uk/ukpga/2005/19 (s.14, Sch. 2) |
| **Canada** | Lead: Criminal Code s.206(1)(f) targets games "of chance or of mixed chance and skill" where the contestant pays. A pure skill quiz appears to be outside it, which is the search tool's own inference and not the text. Not read. | Lead: no federal permit. Competition Act s.74.06 is a **disclosure** rule (number and value of prizes, regions, chances, no undue delay, selection by skill or at random). Not read. | Lead: "adequate and fair disclosure" under s.74.06. | Unknown, not read. | Lead: Bureau guidance says s.74.06 "does not directly prohibit" a purchase requirement. Under s.206, a no-purchase alternative removes the problem for chance contests. Not read. | laws-lois.justice.gc.ca (C-34 s.74.06; C-46 s.206); competition-bureau.canada.ca/en/promotional-contests-enforcement-guidelines |
| **Germany** | Lead: GlüStV 2021 § 3(1) defines gambling as a **payment** for a chance to win where the outcome depends "wholly or predominantly on chance". A skill quiz appears to be outside it. Not read. | Unknown, not read. | Lead: UWG § 5b on essential information. The participation-conditions wording was **not** found. | Unknown, not read. | Unknown, not read. | gesetze-im-internet.de/uwg_2004; gluecksspiel-behoerde.de (GlüStV 2021 PDF and FAQ) |
| **France** | Lead: Code de la consommation L121-36 says promotional operations with a draw or chance are lawful unless unfair. CSI L322-2 bans lotteries where a "sacrifice financier" is required. A conflicting excerpt claims that L322-2 was repealed, so the version in force is **unknown**. Not read. | Unknown, not read. | Unknown, not read. | Unknown, not read. | Unknown, not read (this is the core question for a paid community). | legifrance.gouv.fr (C. consommation L121-36 ff.; CSI L322-1 ff., L322-2-1); economie.gouv.fr/dgccrf |
| **Spain** | Lead: Ley 13/2011 art. 2.2.c excludes "combinaciones aleatorias con fines publicitarios o promocionales" from the licensing scope. The DGOJ excerpt says no licence or prior notice is needed. A **skill** quiz was not addressed. Not read. | Lead: none for promotional draws. The 10 % or 5 % gaming tax (art. 48) is **unclear**. Not read. | Unknown, not read. | Unknown, not read. | Lead: art. 3.i requires no surcharge for taking part. Not read. | boe.es/buscar/act.php?id=BOE-A-2011-9280; ordenacionjuego.es |
| **Italy** | Lead: DPR 430/2001 art. 6 excludes contests for literary, artistic or scientific works where the prize rewards merit. A general-knowledge quiz may **not** fit that exclusion. Not read. | Lead: a "concorso a premio" needs a communication to the Ministry (MIMIT), deposited rules and a **guarantee** equal to the prize value. Not read. | Lead: yes, deposited rules. | Unknown, not read. | Unknown, not read. | mimit.gov.it (DPR 430/2001 PDF; "Concorsi e operazioni a premio"; FAQ January 2024) |
| **Brazil** | Lead: Lei 5.768/1971 art. 3 II exempts from authorization a contest that is "exclusivamente cultural, artístico, desportivo ou recreativo", with no chance element ("álea") and **no link to buying** goods or services. **A quiz open only to paying community members may fail the "no link to buying" condition.** Not read. | Lead: otherwise, prior authorization from the SPA/Ministério da Fazenda through the SCPC system (Portaria SEAE/ME 7.638/2022; Portaria MF 422/2013 on cultural contests). Not read. | Unknown, not read. | Unknown, not read. | Lead: Lei 5.768 forbids converting prizes into cash. Not read. | planalto.gov.br/ccivil_03/leis/l5768compilado.htm; gov.br/fazenda (Secretaria de Prêmios e Apostas, Promoção Comercial) |
| **Australia** | Lead: SA and ACT pages say a competition decided **only by skill** is not a lottery and needs no trade promotion permit. Not read. | Lead: for chance promotions, NSW requires an authority over $10,000 in prizes, SA requires a licence over $5,000, and the ACT requires a permit over $3,000. Not read. | Unknown, not read. | Unknown, not read. | Unknown, not read. | sa.gov.au (trade promotions); gamblingandracing.act.gov.au (trade promotions); service.nsw.gov.au (trade promotion gaming authority) |

**Searched November 6, 2026** with the domain restricted to each official host listed. No page was opened, and every "Lead" is a search excerpt to be verified. Read as leads, they point the same way. A pure skill quiz is usually outside lottery and chance rules. Three things decide the outcome:

- whether the quiz really is skill, given that the UK warns about multiple choice;
- whether entry is tied to a payment, which is the paid community problem;
- the prize value thresholds for chance promotions.

**None of this is established until the pages are read.**

### Why the paid community matters

Today a member is in the community because they bought or claimed a product (`lib/community-access.ts`). If a quiz is open only to those members and gives a prize, entry may count as **paid** in a jurisdiction that treats the purchase of access as consideration. The leads above show this for the UK (Sch. 2), Canada (s.206 for mixed chance and skill), France ("sacrifice financier") and Brazil ("vinculação à compra"). Any prize version therefore needs one of two things before it can be considered:

- (a) a free entry route open to non-members on equal terms, or
- (b) a per-jurisdiction finding, read in the official source, that skill-only entry with a purchase is lawful there.

A free route open to non-members does not exist today and would change who can enter a community.

## Rules text the creator would publish (template)

This is plain US English. Placeholders are in `[BRACKETS]`. The template is not legal advice, and it is not yet checked against any jurisdiction because no official source was read.

> **[QUIZ NAME] — Official Rules**
>
> **1. Who runs this quiz.** This quiz is run by [CREATOR LEGAL NAME], [ADDRESS], [CONTACT EMAIL] (the "Sponsor"). **The Sponsor alone gives and pays for every prize.** Marktmorgen only hosts the community where the quiz takes place. Marktmorgen is not a sponsor, does not run or judge this quiz, does not give, pay for, ship or guarantee any prize, and is not responsible for it.
>
> **2. No purchase necessary.** [USE WHERE REQUIRED:] You do not need to buy anything to enter or to win. Buying something does not improve your chances. To enter for free, [FREE ENTRY METHOD: for example, "open [PUBLIC QUIZ LINK] and enter your email address"]. Free entries are scored exactly the same way as all other entries.
>
> **3. Who can enter.** You must be at least [MINIMUM AGE] years old and live in [ELIGIBLE COUNTRIES/STATES]. The quiz is void where prohibited or restricted by law. [EXCLUSIONS: for example, the Sponsor's employees and their households.]
>
> **4. When.** The quiz opens on [START DATE AND TIME, TIME ZONE]. You can send your answers until [CLOSE DATE AND TIME, TIME ZONE]. That is at least [N] days after the live session, so nobody has to answer within a time limit.
>
> **5. How winners are decided.** This is a test of knowledge. **There is no draw and no element of chance.** Each correct answer scores one point. Speed does not count. [TIE RULE: "Everyone tied for the top score wins," with at most [MAX WINNERS] winners; or "Ties are broken by the tie-breaker question [TEXT], won by the answer closest to [CRITERION]."] The Sponsor publishes the correct answers after the quiz closes.
>
> **6. Prizes.** [NUMBER] prize(s): [DESCRIPTION — only access to [PRODUCT], a discount of [AMOUNT] on [PRODUCT], or the item [ITEM]], approximate retail value [VALUE AND CURRENCY]. **No prize is paid in cash** and no prize can be exchanged for cash. Prizes cannot be transferred. [SUBSTITUTION RULE.] Any taxes on a prize are the winner's responsibility, unless the law says otherwise.
>
> **7. Telling winners.** The Sponsor tells winners in [CHANNEL] within [N] days after the quiz closes and delivers the prize within [N] days. If a winner does not answer within [N] days, [WHAT HAPPENS].
>
> **8. Fair play.** One entry per person. Entries made by software, with more than one identity, or by sharing answers during the quiz are disqualified.
>
> **9. Accessibility.** You can answer without a time limit. If you need an accommodation, write to [CONTACT EMAIL].
>
> **10. Your data.** The Sponsor uses your entry only to run this quiz and deliver prizes. [PRIVACY NOTICE LINK.]
>
> **11. Questions or complaints.** Write to the Sponsor at [CONTACT EMAIL]. [GOVERNING LAW / REGISTRATION NUMBERS WHERE REQUIRED.]

Product rule for any future build: the studio must not publish a prize quiz while any placeholder above is still empty. The Sponsor block and the "Marktmorgen is not a sponsor" sentence are fixed text that the creator cannot remove.

## Accessibility (AX274: WCAG 2.2 AAA)

The repository's AX274 line in `docs/codex-queue.md` lists these requirements: no time limit (2.2.3), postponable interruptions (2.2.4), nothing flashing at any frequency (2.3.2), and interaction animation that can be switched off, respecting `prefers-reduced-motion` (2.3.3). The W3C pages could not be re-read today because w3.org was blocked. The WCAG 2.2 criterion 2.2.3 contains an exception for real-time events. **This design does not rely on that exception.**

### The AAA solution for timing

- **Scoring never uses time.** The score is the number of correct answers, and speed is never a factor. Ties are settled by the published tie rule (all tied winners, or a skill tie-breaker judged on closeness). Ties are never settled by speed or by a random draw, because a draw would add chance and bring the quiz into lottery rules.
- **Answers stay open long after the live moment.** During the live session the creator shows questions one by one, so the "live" experience is the show. Every question shown stays answerable until the published close, which is at least a few days later (the `[CLOSE DATE]` in the rules). A participant can therefore answer during the session, after it, or both, and be scored the same way. Nobody loses a point because of time.
- **No countdown closes anything.** If the creator wants a "now answering" cue, it is static text ("Question 4 of 10 is open"), not a ticking timer. An optional on-screen timer, if ever added, would only be a visual pace guide that a participant can hide. It never closes a question, and screen readers do not announce it.
- **One submission per participant (model B, below).** Answers stay on the page and can be changed freely. Nothing reaches the server until the participant chooses "Send my answers". Before sending, a review step lists every answer and lets the participant go back (Error Prevention, 3.3.6 AAA). The send is final, there is one per participant, and it can happen at any time before the close. This removes rushing and also cuts the write cost. If the page is closed before sending, the answers are kept only in that browser (a per-viewer convenience), so the participant is told plainly that nothing has been sent yet.
- **Interruptions (2.2.4):** a new question appearing is a polite update. It never takes focus or moves the reader's place.

### No flashing, reduced motion, screen readers

- Nothing flashes, blinks or pulses: no confetti, no winner animations, no flashing "correct" or "wrong" (2.3.2). State changes appear instantly without transitions, so `prefers-reduced-motion` has nothing to reduce (2.3.3).
- Right and wrong are not shown by color alone. Each answer carries the words "Correct" or "Not correct" and the explanation.
- Announcements go through one `aria-live="polite"` region: "Question 4 is open", "Your answers were sent", "Results are published". There is no `assertive` region, and no announcement repeats on every poll.
- Questions are real headings, and choices are native radio buttons or checkboxes in a `fieldset` with a `legend`. Targets are at least 44 px, everything is reachable by keyboard, and focus stays visible.
- A store whose live view **rests** (no visits left) shows "Check for new questions" as a button, as the room does today. The participant can still send answers, because the answers do not depend on polling.

## Prohibited

1. **Any prize paid by Marktmorgen**, in cash or in kind. Marktmorgen never holds, pays, ships or guarantees a prize.
2. **Cash prizes**, from anyone, in this feature. The prize types are only access, the creator's own discount, or an item (and the Brazil lead says Lei 5.768 forbids converting prizes into cash).
3. **A purchase required to enter** where the law of an eligible country forbids it. Until that is read country by country, the prize version is not built.
4. **Chance-based selection** (draws, random tie-breaks, "lucky" bonuses) without the permit or registration the law requires. This feature has no draw at all.
5. **Entry by minors** where they are barred, or below the minimum age stated in the rules. The buyer-side minimum age is unknown (see Gaps).
6. **Scoring by speed**, because it breaks the AAA solution above.
7. **Any flashing or blinking** effect.
8. Any change to prices, limits, commissions, `PLANS_ON_SALE`, `OPENING_REQUESTED`, flags or gates in order to "make room" for a quiz.

## Worst-case server cost per session, with a ceiling

### What the existing code prices, by name

| Constant or function | File | Value used |
| --- | --- | --- |
| Hosting and database rates: `VERCEL_CALL_MICRO_USD_PER_MILLION` (600,000), `VERCEL_CPU_MICRO_USD_PER_HOUR` (128,000), `VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR` (10,600) at `VERCEL_FUNCTION_GB` (2), `UPSTASH_MICRO_USD_PER_MILLION_COMMANDS` (2,000,000), `UPSTASH_MICRO_USD_PER_GB_TRANSFER` (30,000), `UPSTASH_MICRO_USD_PER_GB_MONTH` (250,000) | `lib/spend-cost-table.ts` | as listed |
| `request(shape, commands, bytes)`, `SHAPES`, `COMMAND`, `DB_BYTE`, `ORIGIN_PER_BYTE` (0.06 per GB), `TAKE_COMMANDS` (4) | `tests/plan-cost-registry.ts` | — |
| `UNIT_COST.buyer`: the price of one buyer action, which is what a live-room message is counted as | `tests/plan-cost-registry.ts` | **$0.0002945** |
| `UNIT_COST.studio`: one studio request (the creator's own clicks) | `tests/plan-cost-registry.ts` | **$0.00007204** |
| Quiz submission at `request("light", 8)`, line `quizzes` | `tests/plan-cost-registry.ts` | $0.00002781 |
| `roomLookCost()`: one poll answered by the database, no CDN share | `tests/traffic-cost.ts` | **$0.000005133** |
| `roomLeaveCost()`: one 10-minute grant, `COMMANDS.roomLeave` (20) | `tests/traffic-cost.ts` | **$0.00004567** |
| `roomMinutesCost(LIVE_LOOKS)`: 10 live minutes for one reader (`LIVE_LOOKS` = 120) | `tests/traffic-cost.ts`, `lib/chat-pace.ts` | **$0.0006617** |
| `visitCost()`; `ROOM_LIVE_PARTS` = 260 hundredths | `tests/traffic-cost.ts`, `lib/traffic-rules.ts` | $0.0002638 a visit; a live grant is counted as $0.0006858 (≥ $0.0006617, as `tests/room.test.ts` holds) |
| `STORE_ALLOWANCES.buyer`: buyer actions a month | `lib/store-allowance-rules.ts` | Store 200 · Studio 1,000 · Scale 3,000 |
| `VISITS_INCLUDED`: visits a month | `lib/traffic-rules.ts` | Store 3,400 · Studio 10,000 · Scale 40,000 |

The values were computed on November 6, 2026 by copying the formulas from these files into a scratch script. None of the files was changed.

### Proposed ceilings (study figures, not set anywhere)

| Ceiling | Value | Why |
| --- | --- | --- |
| Participants per session (P) | 500 | Well under `MAX_EVENT_CAP` (5,000), and enough for a large community hour. |
| Questions per session (Q) | 20 | The same as `MAX_QUESTIONS` in `lib/quiz.ts`. |
| Choices per question | 6 | The same as `MAX_CHOICES`. |
| Answers per participant per question (A) | 1 | Model A stores each answer once. In model B, changes stay on the page and are sent once, at the end. |
| Sends per participant (model B) | 1, final | After the review step. |
| Live session length (T) | 90 minutes, or 9 grants of `ROOM_GRANT_MINUTES` | After that, live polling stops and the page shows a button. |
| Sessions at once per store | 1 | — |

### Worst case: P = 500, Q = 20, T = 90 min, every look answered by the database

| Part | Formula | Model A: one write per answer | Model B: one submission per participant |
| --- | --- | --- | --- |
| Participants polling | P × 9 × `roomMinutesCost(120)` | $2.978 | $2.978 |
| The creator polling (never counted, but still costs) | 9 × `roomMinutesCost(120)` | $0.006 | $0.006 |
| Answers written | A: P × Q × `UNIT_COST.buyer`; B: P × `UNIT_COST.buyer` | $2.945 (10,000 writes) | $0.147 (500 writes) |
| The creator's clicks (start, then show, close and reveal for each question, then end) | (2 + 3Q) × `UNIT_COST.studio` | $0.004 | $0.004 |
| Ranking (one read of every answer, 64 B each, "heavy" shape) | `request("heavy", 10, P·Q·64)` + bytes sent | $0.0001 | $0.0001 |
| Results look per participant | P × `roomLookCost()` | $0.003 | $0.003 |
| Answers kept one month (640 KB) | bytes × `DB_BYTE_MONTH` | $0.0002 | $0.0002 |
| **Total known worst case per session** | | **≈ $5.94** | **≈ $3.14** |
| Worst case per participant | | ≈ $0.0119 | ≈ $0.0063 |

**Ceiling against the plans.** Under the existing rules, one ceiling session draws from the figures the plans already price:

- **Visits:** 500 participants × 9 live grants × 2.6 = **11,700 visits**. That is more than Store's whole month (3,400) and Studio's (10,000), and 29 % of Scale's (40,000). When the visits run out, polling rests, as the room does today.
- **Buyer actions:** 10,000 in model A, which is more than any plan's monthly figure (3,000 on Scale), or **500** in model B, which is more than Store's 200.

So the margin rule holds **only** under these conditions:

- each answer is taken from `STORE_ALLOWANCES.buyer` before it is written;
- each grant is counted as the room counts it today;
- each answer write stays inside `UNIT_COST.buyer`'s shape (at most 104 commands, 60 KB and 10 s);
- a session is admitted only when the remaining buyer actions cover the registered participants (model B) or participants × questions (model A).

Under those conditions, no plan's worst month grows, because the lines `buyer-actions` and the visits lines already price the full figures. It also means a real quiz on the Store plan is small: about 200 participants in model B, and only if nothing else in the month used buyer actions. **Raising those figures would be a limit change and is not proposed here.**

**Unknown, not zero:**

- Lua scripts priced as one command. The queue note of October 31, 2026 says each `EVAL` is billed as 1 plus each `redis.call`. Any script in the answer path must be recounted before pricing.
- CDN request pricing when the CDN does not share an answer (`CDN_PER_REQUEST`, already inside `roomLookCost`), and any change to it.
- Logs and observability volume per request.
- Delivering a discount prize, if it were automated through Stripe, which would be a call to another service; an `integration` unit may be the right figure, but this is not measured.
- Any email to winners. None is proposed, but if it were added, `PER_EMAIL` applies.
- The visit cost after draft #1496, which would raise the maximum visit cost from $0.000264 to $0.000304 if merged. The table above uses the value on main.
- External legal review per jurisdiction. It is not a server cost, but it is not zero, and no contract is proposed here.

## Recommendation

**Depende do dono.**

1. **Do not build the prize version now.** The rules per jurisdiction were not read in any official source (every host was blocked). The leads point to real risk on three points:
   - multiple-choice questions may not count as skill (UK);
   - entry through a paid community may count as payment (UK, Canada, France, Brazil);
   - Brazil's exemption requires no link to buying.

   Building it before those are read would contradict the item's own acceptance test.
2. **If the owner wants something now, the smallest safe version is a live quiz without a prize.** It has these properties:
   - It is untimed and scored by correct answers only (model B, one submission per participant).
   - It reuses `lib/quiz.ts` validation and server marking and the room's polling, grants and visit counting.
   - Every answer is taken from the existing buyer-action figure, and admission is checked before start.
   - It has no prize field, no rules text and no free entry route, because without a prize there is no contest to regulate.
   - It needs its own reservation, RED tests, cost proof against `tests/plan-cost-registry.ts`, and an AX274 check before and after.
3. **Before any prize version:**
   - allow the official hosts listed in Gaps and read each source, keeping the URL, the date and an exact quote;
   - decide per country whether to allow the quiz, or exclude the country in the rules;
   - design a free entry route that does not open the community to non-members;
   - record the buyer-side minimum age.

## Gaps

1. **Official sources not read (all blocked, November 6, 2026).** A 403 from the proxy, or "ENOTFOUND" in the fetch tool, came back from: `www.legislation.gov.uk`, `www.gamblingcommission.gov.uk`, `www.ftc.gov`, `consumer.ftc.gov`, `www.ecfr.gov`, `uscode.house.gov`, `www.law.cornell.edu`, `www.nysenate.gov`, `dos.ny.gov`, `www.dos.ny.gov`, `businessexpress.ny.gov`, `www.leg.state.fl.us`, `www.flsenate.gov`, `www.fdacs.gov`, `laws-lois.justice.gc.ca`, `competition-bureau.canada.ca`, `ised-isde.canada.ca`, `www.gesetze-im-internet.de`, `www.gluecksspiel-behoerde.de`, `www.legifrance.gouv.fr`, `www.economie.gouv.fr`, `www.boe.es`, `www.ordenacionjuego.es`, `www.mimit.gov.it`, `www.normattiva.it`, `www.gazzettaufficiale.it`, `www.planalto.gov.br`, `www.gov.br`, `www.in.gov.br`, `www.nsw.gov.au`, `www.fairtrading.nsw.gov.au`, `www.service.nsw.gov.au`, `legislation.nsw.gov.au`, `www.legislation.nsw.gov.au`, `www.sa.gov.au`, `www.cbs.sa.gov.au`, `www.gamblingandracing.act.gov.au`, `www.accesscanberra.act.gov.au`, `www.w3.org`, `eur-lex.europa.eu`. Allowing these hosts is a decision for the session owner, and this study did not request it.
2. **Minimum age** for buyers or community members is not established. The creator Terms (`app/terms/page.tsx`) require 18 or the age of majority for using the Services, but this study did not confirm that the same rule applies to buyers.
3. **Other US states.** Some states may restrict **paid** skill contests. None was read.
4. **France:** whether CSI L322-2 is in force (the excerpts conflict). **Spain:** the tax rate under art. 48. **Italy:** whether a general-knowledge quiz falls under art. 6. **Germany:** the UWG wording on participation conditions. All of these are unread.
5. **Whether an open-book, untimed quiz still counts as skill** under the UK s.14(5) test, given that participants can look answers up. This is unknown.
6. **How the buyer's country is known.** It is not established. A country restriction in the rules would rest on what the participant states.
7. The cost items listed above as **unknown, not zero**.
8. Queue item 661's text is not in this branch's `docs/codex-queue.md`, and the brief's text was used.
