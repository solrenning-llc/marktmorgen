# 588 [KB9] — EU withdrawal function: official reading and design (6 November 2026)

State: **in progress (reading done, nothing built)**. This file records the official
text read, what it requires, what Marktmorgen already has, and the units proposed.
It changes no code, price, limit, commission, flag or gate.

## Source read

- Directive (EU) 2023/2673 of the European Parliament and of the Council of
  22 November 2023, amending Directive 2011/83/EU as regards financial services
  contracts concluded at a distance and repealing Directive 2002/65/EC.
  Official Journal of the European Union, Series L, 2023/2673, 28.11.2023.
- Read on 6 November 2026, 18:23 UTC, from the Publications Office's Cellar:
  `https://publications.europa.eu/resource/celex/32023L2673` (English
  manifestation, XHTML), which redirects to
  `.../resource/cellar/ba0121b2-8d8f-11ee-8aa6-01aa75ed71a1.0006.03/DOC_1`.
  SHA-256 of the file read:
  `1183c1f775c7fe6f306a7645dd9f485c48731cf4c5e9393184ab919b21513081`.
- EUR-Lex itself (`eur-lex.europa.eu`) answered every request from this
  environment with HTTP 202 and an empty body (a browser challenge). The
  challenge was not bypassed; the Cellar serves the same official text.
- This replaces, for Art. 11a, the secondary source S4 of
  `docs/kx1-renewal-legal-matrix-2026-10-30.md` (Van Bael & Bellis note of
  8 June 2026). National transposing laws were **not** read.

## The text, verbatim

Article 1(3) of Directive (EU) 2023/2673 inserts into Directive 2011/83/EU:

> **Article 11a — Exercise of the right of withdrawal from distance contracts concluded by the means of an online interface**
>
> 1. For distance contracts concluded by the means of an online interface, the trader shall ensure that the consumer can also withdraw from the contract by using a withdrawal function.
>
> The withdrawal function shall be labelled with the words "withdraw from contract here" or an unambiguous corresponding formulation in an easily legible way. The withdrawal function shall be continuously available throughout the withdrawal period. It shall be prominently displayed on the online interface and easily accessible to the consumer.
>
> 2. The withdrawal function shall enable the consumer to send an online withdrawal statement informing the trader of his or her decision to withdraw from the contract. That online withdrawal statement shall enable the consumer to easily provide or confirm the following information:
>
> (a) his or her name;
> (b) details identifying the contract from which he or she wishes to withdraw;
> (c) details of the electronic means by which the confirmation of the withdrawal will be sent to the consumer.
>
> 3. Once the consumer has completed the online withdrawal statement in accordance with paragraph 2, the trader shall enable the consumer to submit it to him by means of a confirmation function.
>
> That confirmation function shall be labelled in an easily legible manner, and only with the words "confirm withdrawal" or with an unambiguous corresponding formulation.
>
> 4. Once the consumer activates the confirmation function, the trader shall send to the consumer an acknowledgement of receipt of the withdrawal on a durable medium, including its content and the date and time of its submission, without undue delay.
>
> 5. The consumer shall be considered to have exercised his or her right of withdrawal within the relevant withdrawal period if he or she submitted the online withdrawal statement referred to in this Article before that period expired.

Article 1(2) also amends Art. 6(1)(h) of Directive 2011/83/EU: the pre-contract
information on the right of withdrawal includes, "where applicable, information
about the existence and placement of the withdrawal function referred to in
Article 11a". Annex I replaces instruction 3 of the model withdrawal
instructions with: "You can also exercise your right of withdrawal online at
[insert internet address or another appropriate explanation of where the
withdrawal function is available]. If you use this online feature, we will send
you an acknowledgement of receipt of the withdrawal on a durable medium (e.g. by
email), including its content and the date and time of its submission, without
undue delay."

Article 2(1): Member States adopt and publish the measures "by 19 December 2025
at the latest" and "shall apply those measures from 19 June 2026." Recital 37 says
the function applies to all distance contracts subject to the right of withdrawal
under Directive 2011/83/EU, not only financial services. It also allows withdrawal
from part of a contract. A consumer already logged in should not have to identify
themselves or the contract again.

## What it means here (reading, not legal advice)

- **Who is the trader.** In a store sale, the creator is the trader (app/terms,
  section 3). The online interface the buyer uses is Marktmorgen's checkout and
  store, so a creator can comply only if Marktmorgen provides the function. For
  Marktmorgen's own plans, Marktmorgen is the trader whenever the creator buying
  is a consumer. The terms do not limit plans to business buyers, so under the more
  protective reading the plans need it too.
- **When it must be available.** "Throughout the withdrawal period". Under
  Directive 2011/83/EU as read for item 91 (`lib/digital-consent.ts`):
  - **Digital content sold once,** where the buyer gave the art. 16(m) consent and
    acknowledgment and got the confirmation: the right ends when supply begins. No
    function is owed after that.
  - **The same content without that consent** (an older order, or a form that did
    not ask): 14 days from the contract.
  - **A pre-order:** until its release day.
  - **A membership** (at least partly a service): 14 days from the contract. The
    right is lost only once the service is fully performed (art. 16(a)), and the
    consumer pays in proportion (art. 14(3)).
  - **A shipped item:** 14 days from receipt, which the code does not know.
  - **A Marktmorgen plan bought by a consumer:** 14 days from the contract (a
    service).
- **What exists today and is not the function:**
  - `/@store/manage` opens the Stripe portal to cancel a membership. That stops
    future charges; it is not a withdrawal statement.
  - The money-back refund of plans.
  - The terms' text saying that refunding a member who cancels within 14 days is
    the creator's to do.
  - None of these has the label, the statement with name, contract and email, the
    "confirm withdrawal" step, or the acknowledgment with content, date and time.

## Proposed units (each with its own RESERVA and RED; none started)

1. **Buyer function for store orders.**
   - **Where:** "Withdraw from contract here" on `/@store/orders` (buyer already
     proved the address, so name, contract and email are prefilled), in the order
     confirmation email, and on `/@store/manage` for memberships.
   - **When shown:** only while the order's withdrawal period runs, by the kinds
     above. When the period cannot be known (shipped items), it stays shown with
     the 14 days counted from the latest date the order could have been received.
     Unknown never hides it.
   - **Form:** name, the order, and the email for the confirmation, each editable,
     then a button labelled "Confirm withdrawal".
   - **On confirm:**
     - record the statement (content, UTC date and time) on the order, kept like
       the consent record;
     - email the buyer an acknowledgment quoting it with its date and time;
     - put it in the creator's inbox with what the terms already say: the refund
       is theirs, from their Stripe account.
   - **Does not:** refund, cancel or change anything in Stripe by itself. Whether
     to cancel the membership at once is a question for the owner (below).
2. **Pre-contract information.** The checkout's box sentence and the confirmation
   email say where the function is (Art. 6(1)(h), Annex I instruction 3), in every
   buyer language, with the version bumped as `lib/digital-consent.ts` does.
3. **Creator plans.** The same function in the studio's billing page for a plan
   bought within its 14 days.
4. **Costs (MR).**
   - At most 2 emails per withdrawal (the acknowledgment and the creator's notice),
     plus one record. They count against the store's own email and data figures.
   - The checks run before sending. A store whose allowance is spent still sends
     the acknowledgment, because the law requires it, so its worst case must be
     added to the plan cost registry as its own line with a ceiling per order.
   - Unknown cost is not zero.

## Depends on the owner

- Whether a withdrawal of a membership also cancels it in Stripe at once (the
  consumer's decision is to end the contract), or only notifies the creator.
  Cancelling writes to the creator's Stripe account.
- Whether plan buyers are to be treated as consumers (the more protective
  reading, used above unless told otherwise).

## Not verified

- National laws transposing Art. 11a (for example the German § 356a BGB). Their
  wording may add requirements.
- The UK's equivalent rules.
- How a creator's own extra terms interact with this.
