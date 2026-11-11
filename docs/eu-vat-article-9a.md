## TX — Precedência vigente para esta análise (27/10/2026)

Pedido do dono27/10/2026 12h34Fortaleza,471[TX1]/473[TX3]. A regra19/maisimposto automático e consultas mencionadas no corpo antigo abaixo são HISTÓRICO,revogados nos pontos conflitantes pela políticaTX deAGENTS.md. Nenhuma consulta tributária será feita ou preparada para envio;CONSULTATION_ANSWERS permanece vazio. O recorte pretendido deTX13 separa serviço eletrônico automatizado,intervenção humana e bem físico,mas não é declarado integralmente conferido/implementado por este prefixo.

A [matriz de fontesTX1](tx-legal-source-review-2026-10-27.md) registra o que foi conferido e as lacunas. As rotas oficiaisEUR-Lex paraReg282eFenixC695/20 retornaram anti-robotJS durante esta conferência;resultados de busca não são inteiro teor autenticado. A documentação antiga continua preservada,sem alegação de nova prova. Só no ponto não confirmado,manter leitura técnica atual até correção e registrar divergência emDependedodono,sem consulta e sem bloquear a pesquisa restante.

Continua obrigatório construir e testar o tratamento de cada jurisdição emDEEMED_SUPPLIER_RECORDS;nenhum registro real foi preenchido ou gate relaxado. IVAporfora/dedução de repasse não é prova de ausência de custo/obrigação da plataforma:base,tributo devido,principal/agente,taxa de recebimento sobretotal,reembolso e reserva exigem fonte e custeio. Sem certificarconformidade/margem ou registrar empresa/conta/OSS/aceitartermos.

SV27/10/2026 13h19Fortaleza:servidoresUEdepoisdaabertura,EU_HOSTING_CONFIRMEDfalsee semcondiçãodeabertura por decisão do dono;retirada de dependência no código pertence a472[TX2],ainda pendente. Preservar ensaios SV e conferir mecanismosDPF/SCCdosfornecedoresatuais no Blocodeabertura,sem contato ou contratação.

EstadoVR:precedência documental atualizada;TX1/17teses/TX3 e conferência oficial integral desteescopo ainda incompletos. Sem alteração de código/cálculo/flag/preço/limite;sem novoIO operacional. Custos pesquisa/CI100%FX275,desconhecido nãozero. Conteúdo antigo integral abaixo.

# EU VAT, Implementing Regulation 282/2011 art. 9a: Marktmorgen as the supplier of what a store sells (18 Oct 2026)

Research of 18 Oct 2026, under the owner's rule 19 (the reading with more tax where the law leaves a doubt). Not advice, not a finding of compliance, and nothing on any public page may say Marktmorgen or a creator complies. Question 20 of [tax-uncertainty.md](tax-uncertainty.md) points here; questions 26 (United Kingdom) and 27 (physical goods) are detailed at the end.

## The short answer

- Marktmorgen's terms say the creator is the seller and Marktmorgen is not merchant of record, and every sale is a Stripe direct charge on the creator's own connected account (`lib/store-checkout.ts`, `lib/stripe-account.ts`). For EU VAT on electronically supplied services that does not decide who the supplier is.
- Art. 9a presumes that a taxable person taking part in such a supply through a portal acts in its own name. The presumption cannot be rebutted by one who authorises the charge, authorises the delivery, or sets the general terms and conditions. **Marktmorgen does all three**, so for every electronically supplied path it is, for EU VAT, the supplier to the consumer. This is the reading the text supports, not only the most-tax one.
- What follows: VAT at the consumer's Member State rate (up to 27%) on the whole price of every such sale to an EU consumer, owed by the LLC, through the non-Union OSS from the first sale (no threshold), with each sale's art. 63c record kept 10 years and the consumer's location shown by two non-contradictory pieces of evidence (art. 24b(d), 24f).
- The owner's design: that VAT is added on top of the buyer's price or taken from the creator's payout, **never from Marktmorgen's commission**.
- **None of it is built.** No store can sell today (the plans are not on sale), and since 18 Oct 2026 `PLANS_ON_SALE` also needs `deemedSupplierReady()` (`lib/deemed-supplier.ts`), which is false until the treatment is built and recorded for the EU, the UK, US states and other countries.

## Sources (read 18 Oct 2026)

- **Council Implementing Regulation (EU) No 282/2011**, consolidated version of 14 Apr 2025, https://eur-lex.europa.eu/eli/reg_impl/2011/282/2025-04-14/eng. The page opened and its metadata confirmed the consolidation date (identifier 02011R0282-20250414), but the tool received no article text, and EUR-Lex then refused further requests (HTTP 429). **So the articles were read from the UK National Archives' copy of the EU text**, as it stood on 31 Dec 2020, which notes no UK amendment: art. 7 (https://www.legislation.gov.uk/eur/2011/282/article/7/data.htm), art. 9a (https://www.legislation.gov.uk/eur/2011/282/article/9a/data.htm; inserted by Implementing Regulation 1042/2013, applying from 1 Jan 2015), arts. 24a–24c (https://www.legislation.gov.uk/eur/2011/282/chapter/V/section/4/subsection/3a), art. 63c (https://www.legislation.gov.uk/eur/2011/282/article/63c). An EU amendment after 31 Dec 2020 to any of these would not show there; before relying on a figure, the consolidated EUR-Lex text must be read. Arts. 5b and 24f were not read today (24f's list below is from the known text and must be checked).
- **Council Directive 2006/112/EC** (arts. 14a, 28, 58, 73, 358a–369, 369k), https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32006L0112: not re-read today (EUR-Lex refused); cited as Hazelsong's research of 18 Oct 2026 cites it.
- **European Commission, DG TAXUD, "Explanatory notes on the EU VAT changes to the place of supply of telecommunications, broadcasting and electronic services that enter into force in 2015"**, published 3 Apr 2014, not legally binding, https://taxation-customs.ec.europa.eu/system/files/2016-09/explanatory_notes_2015_en.pdf, §§3.4.2, 3.4.4, 3.4.6 (pp. 27–36).
- **European Commission, "Guide to the VAT One Stop Shop"**, March 2021, https://vat-one-stop-shop.ec.europa.eu/system/files/2021-07/OSS_guidelines_en.pdf, Part 1a and Part 2.
- **Revenue (Ireland), "Non-Union scheme - One Stop Shop"**, updated 19 Jun 2026, https://revenue.ie/en/vat/vat-ecommerce/non-union-scheme/index.aspx.
- **Court of Justice, C-695/20 Fenix International** (the operator of OnlyFans), judgment of 28 Feb 2023, press release 37/23, https://curia.europa.eu/jcms/upload/docs/application/pdf/2023-02/cp230037en.pdf: art. 9a is valid; the platform, whose fans pay creators and which takes 20% of each payment, was held to the presumption. The judgment itself was not read (EUR-Lex, CELEX 62020CJ0695).

## What art. 9a says (short excerpts)

- Paragraph 1, first subparagraph: where electronically supplied services are supplied through a telecommunications network, an interface or a portal such as a marketplace for applications, a taxable person taking part in that supply "shall be presumed to be acting in his own name but on behalf of the provider of those services", unless the provider is explicitly indicated as the supplier and that is reflected in the contractual arrangements.
- Paragraph 1, second subparagraph: to be "explicitly indicated", the invoice of each taxable person taking part, and the bill or receipt given to the customer, must identify the services and their supplier.
- Paragraph 1, third subparagraph: a taxable person who "authorises the charge to the customer or the delivery of the services, or sets the general terms and conditions" of the supply "shall not be permitted to explicitly indicate another person as the supplier".
- Paragraph 3: the article does not apply to a taxable person who "only provides for processing of payments" and does not take part in the supply. That is Stripe's position (and PayPal's), not Marktmorgen's.
- The Commission's notes, §3.4.6: "authorises the charge" "is not the same as taking payment or collecting payment"; "authorises … the delivery" "is a broader concept than making the delivery"; and one who does any of the three "will always be presumed to act in his own name". Taking no money (direct charges) therefore does not take Marktmorgen out of the presumption.

## Why Marktmorgen is in the third subparagraph

Read against the code of 18 Oct 2026:

- **It authorises the charge.** Marktmorgen's server, with the platform's key, creates every Checkout Session on the creator's account (`lib/store-checkout.ts`, `lib/cart-checkout.ts`, `lib/calls.ts`, `lib/call-packages.ts`, `lib/payment-requests.ts`, `lib/store-tip-checkout.ts`, PayPal in `lib/paypal-sales.ts`): it decides whether a checkout may open at all (`canSell`, `canSellProduct`, a plan, a suspension, the orders admitted for the hour, `admitOrders`), what lines and amounts it carries, which codes, sales and fair prices apply, and its share as an application fee (`lib/platform-share.ts`).
- **It authorises the delivery.** It hands over every electronically supplied product itself: the signed download link and its three-day window (`DOWNLOAD_WINDOW_SECONDS`), course access (`lib/learn.ts`), private podcast feeds, membership and community access asked again on every request (`lib/membership-access.ts`, `lib/community-access.ts`), licence keys (`lib/licence-keys.ts`), and their withdrawal after a refund or a lapsed membership.
- **It sets the general terms and conditions.** Creators accept Marktmorgen's Terms (section 3, "Selling through a Marktmorgen store": reviews only from confirmed buyers, payment requests, refunds and disputes handled through the creator's Stripe), and the buyer meets Marktmorgen's checkout, receipt, download and access rules, the same in every store.

Under the text the presumption is therefore irrebuttable. The terms' "You are the seller" and the creator's name on the statement do not change it for EU VAT.

## Path by path (the reading used)

"ESS" is an electronically supplied service (art. 7(1): supplied over the internet, essentially automated, minimal human intervention, impossible without information technology; Annex I and art. 7(2); exclusions in art. 7(3)).

| Path | Where in the code | ESS? | Art. 9a, most-tax reading |
| --- | --- | --- | --- |
| Digital products: a file, a link, a licence key, a bundle of them, a cart, an offer after paying or at checkout, the yearly offer | `lib/store-checkout.ts`, `lib/cart-checkout.ts`, `lib/upsell.ts`, `lib/next-offer.ts`, `lib/yearly-offer.ts`, `lib/licence-keys.ts`, PayPal one-off products | Yes (digitised products, art. 7(2)(a); Annex I) | **Applies.** Marktmorgen is the supplier to an EU consumer. |
| Courses (recorded lessons) | `lib/learn.ts`, `lib/course.ts` | Yes: automated distance teaching (Annex I point 5). Art. 7(3)(j) excludes only "teaching services, where the course content is delivered by a teacher over the Internet" | **Applies** to every course: Marktmorgen's courses are lessons uploaded in advance. |
| Private podcasts | podcast products | Yes (digitised audio content) | **Applies.** |
| Memberships and communities (recurring access, including live events put on for members) | recurring products, `lib/membership-access.ts`, `lib/community-access.ts`, `lib/community-events.ts` | Yes for the access sold; a live event inside is part of the same price | **Applies** to the whole membership price: one supply of access, priced as such. |
| Calls and packages of calls (a live video call with the creator) | `lib/calls.ts`, `lib/call-packages.ts` | **No** on the text: human delivery is the service (art. 7(1); compare art. 7(3)(i) and (j)) | **Does not apply on its text.** Doubt that stays: whether Marktmorgen acts in its own name under the Directive's art. 28 on these facts. Reading used: the same treatment as an ESS for an EU consumer (VAT at the consumer's rate, collected through Marktmorgen), because that is the treatment with more tax for the LLC to answer for. |
| Tips ("Support my work") | `lib/store-tip-checkout.ts` | Nothing is sold, so on its face no supply | Reading used: **applies**, as consideration paid through the platform to a creator whose content the payer receives (the Fenix platform's fans paid creators in the same way). |
| Payment requests | `lib/payment-requests.ts` | Depends on what the creator bills | Reading used: **applies** unless the request is for physical goods. |
| Physical goods | `lib/shipping.ts`, `lib/shipments.ts` | Not a service | Art. 9a does not apply. The Directive's art. 14a (goods) does: question 27 below. |
| Marktmorgen's own plans and the Store assistant add-on | `lib/billing.ts`, `lib/assistant-billing.ts` | Yes, Marktmorgen's own ESS | Not art. 9a: Marktmorgen is the supplier anyway. A business creator with a valid VAT number: reverse charge (Directive arts. 44 and 196). Without one (art. 18(2) of the Regulation): a consumer, VAT due by Marktmorgen (question 14). |

## What follows, under the reading used

1. **The supply chain for VAT.** The creator is deemed to supply Marktmorgen, and Marktmorgen to supply the consumer (art. 28 of the Directive, as art. 9a applies it). The creator's supply to Marktmorgen is a supply to a business established in the US (place of supply where Marktmorgen is established, art. 44): no EU VAT for the creator to charge on it.
2. **VAT due by the platform on the full sale price.** The taxable amount is everything the consumer pays for the sale (art. 73), not Marktmorgen's share; at the rate of the Member State where the consumer belongs (art. 58), from 17% to 27% standard. No threshold applies: the EUR 10,000 threshold is only for a supplier established in a single Member State (OSS Guide, Background point 9), and Marktmorgen is established in none.
3. **Non-Union OSS from the first sale.** "Any taxable person, not established in the EU, who supplies services to non-taxable persons" may use the non-Union scheme (OSS Guide, Part 1a point 1(a)); it "can choose any Member State to be the Member State of identification" (Part 1a, Background point 1). Registration applies from the first day of the next calendar quarter, or from the first supply if the Member State is told "by the tenth day of the month following that first supply" (Part 1a point 6). A return is due "by the end of the month following the end of the tax period" (Part 2 point 2), quarterly, with payment. Without the scheme, the LLC would have to register in every Member State where it has a consumer.
4. **Records (art. 63c, kept 10 years under the Directive's art. 369).** For each sale: the Member State of consumption, the type of service, the date, the taxable amount and currency, any later increase or reduction, the VAT rate, the VAT amount and currency, the date and amount of each payment, any payment on account, the invoice's content where one is issued, the customer's name where known, and the information used to establish where the customer belongs; made available electronically without delay, sale by sale.
5. **The consumer's location (art. 24b(d)).** Outside the fixed-line, mobile and decoder cases, the supplier identifies the place on "two items of non-contradictory evidence" from art. 24f (from the known text: the billing address, the device's IP address or other geolocation, bank details such as the account's or the card's country, the mobile country code, the fixed line's location, other commercially relevant information). The one-item simplification of art. 24b (supplies of at most EUR 100,000) is only for a taxable person established in a Member State, so it is not Marktmorgen's.
6. **A business buyer.** Art. 9a covers business buyers too: Marktmorgen is the supplier to them, the place of supply is the buyer's (art. 44) and the buyer accounts for the VAT (art. 196) if Marktmorgen holds a VAT number it checked (art. 18 of the Regulation; Hazelsong's `lib/vies.ts` already does the check). Without one, the buyer is a consumer.

## The margin consequence

The owner's design decides the main one: the VAT is added on top of the buyer's price, or taken from the creator's payout, never from Marktmorgen's commission. So the VAT itself does not move Marktmorgen's net. What still does, and must be built so that it does not:

1. **How the money reaches the LLC.** A direct charge lands on the creator's account. The only way Marktmorgen holds the VAT it owes is to take it from that charge with the application fee: application fee = the plan's share + the VAT + the costs of the VAT money (below). A store on Scale (0% share) still needs that fee for the VAT. A refund must give back the VAT part of the fee with the buyer's money and correct the next OSS return; a dispute lost must NOT give the VAT part back to the creator unless a Member State relieves it (reading used: no relief), so `lib/share-settle.ts` must keep it apart from the share it settles.
2. **The VAT money's own costs.** Stripe converts the fee into the platform's US dollars; the OSS is paid in euros (and UK VAT in pounds), so it is converted back; bank transfers cost a fee. Under the design these are withheld with the VAT from the creator's side, never from the commission, with a stated margin for the exchange rate's movement between the sale and the return.
3. **Costs that stay on Marktmorgen per sale.** Computing the rate, collecting and comparing the location evidence, checking a VAT number in VIES, and keeping the art. 63c record 10 years. Each must be counted per customer, at its worst, in the receiving model before anything opens (`lib/receiving-costs.ts` and the margin tests, the margin work's files).
4. **Fixed costs.** Non-Union OSS registration and quarterly returns, and UK VAT registration and returns, prepared by the owner ($0 for preparation; whether any Member State charges for registration was not verified). An import OSS intermediary would be needed for goods; the next build refuses those sales instead (question 27).
5. **ISS.** Whether Fortaleza's ISS would reach a sale EU VAT deems Marktmorgen's is question 25: reading used, 5% of the sale's price until Fortaleza answers, under which no plan that lets a store sell to an EU consumer keeps 60%. One more reason sales stay closed.
6. **Income tax.** None from the VAT itself: it is a fiction of EU VAT, the sale's price is credited to the creator, and the VAT passes through. Receita consultation 1 is asked to confirm that the VAT money is not the LLC's profit ([tax-consultations.md](tax-consultations.md)).
7. **The creator's own tax.** Today a creator may switch Stripe Tax on for their store (`lib/tax.ts`), which charges VAT as if the creator supplied the consumer. Under art. 9a that would be VAT charged twice on one sale; for EU consumers the build must replace the creator's VAT line with Marktmorgen's.

## The most-tax reading used by the gate

Every path that reaches an EU consumer is within art. 9a (calls, tips and payment requests included); VAT at the consumer's Member State standard rate, up to 27%, from the first sale; no relief on a lost dispute; ISS at 5% of the sale (question 25); physical goods to an EU address deemed supplied by Marktmorgen when the creator's Stripe account is not in the EU or the goods come from outside it (question 27).

## The code that would be needed (the next build, for the owner to approve)

Not built in this change. Scope, in order:

1. **Location evidence before the price is shown.** Two items before the checkout opens: the country from `x-vercel-ip-country` (already read in `lib/visitor.ts`) and the billing country the buyer gives; refused when they contradict. After payment, the card's issuing country read back from Stripe as a third; a contradiction is kept with the record.
2. **Consumer or business.** A VAT number box with the number checked in VIES on the server (port Hazelsong's `lib/vies.ts`); only a valid answer makes a business buyer.
3. **VAT on top.** For an EU consumer: the price shown includes VAT before the buyer commits; the checkout adds the VAT as its own line at the Member State's standard rate (a rate table with its source and date, or Stripe Tax's calculation on Marktmorgen's own account with its non-Union OSS registration, whichever is chosen when built); the creator's own automatic tax is off for that sale; `application_fee_amount` = share + VAT + the VAT money's costs.
4. **The VAT ledger.** One art. 63c record per sale, refund and correction, kept 10 years apart from the store and not deleted when the store closes (`lib/closed-store-data.ts` and `lib/data-families.ts` must say so), with the privacy policy and the terms changed with it (the terms' "You are the seller" needs an EU VAT carve-out; a legal change for the owner). The sentence buyers see before paying, `whoAnswers` in `lib/buyer-words/*.ts` (drawn by `components/who-answers.tsx`: the creator is the seller, Marktmorgen "is not a party to the sale"), is reviewed in the same change, in all seven languages, so it never contradicts a receipt that names Marktmorgen as the supplier for VAT.
5. **Refunds and disputes.** The VAT part of the fee given back on a refund, kept on a lost dispute; `lib/share-settle.ts` taught the difference.
6. **The quarterly OSS return's data.** Per Member State: taxable amounts, rates, VAT, corrections of earlier periods; amounts in euros at the rate the Directive sets for the return (to be read when built).
7. **UK.** The same for UK consumers at 20%, with a UK VAT return's data.
8. **Physical goods.** Shipping to an EU address refused when the creator's Stripe account is not in the EU, and to a UK address when it is not in the UK (`shipping_address_collection[allowed_countries]` in `lib/store-checkout.ts`), until a separate build for art. 14a and the UK's marketplace rules.
9. **Other jurisdictions** (questions 23 and 24): consumers of US states with a marketplace-facilitator law and of countries with a platform rule refused at checkout, or the tax collected, each recorded.

When it is built, each jurisdiction's record goes into `DEEMED_SUPPLIER_RECORDS` (`lib/deemed-supplier.ts`): the rule, the treatment ("collect" or "refuse-consumers"), the files that implement it, the day it was recorded, the registration (for "collect"), and the evidence that it was tested. Only then can `deemedSupplierReady()` be true, and only together with the margin review.

## What only the owner can do

- Form the LLC and obtain its EIN (before any registration).
- **Register the LLC in the non-Union OSS** in the EU Member State he chooses, after the LLC exists and before the first sale to an EU consumer, and record the Member State, the date and the identification number.
- Register the LLC for UK VAT as a non-established taxable person, before the first sale to a UK consumer.
- Decide the terms' change (Marktmorgen as the supplier for EU and UK VAT of what a store sells electronically to a consumer) and the creators' notice of it.
- Decide whether to collect or to refuse each other jurisdiction of questions 23 and 24.

## United Kingdom (question 26)

- The UK's own text of Regulation 282/2011 on legislation.gov.uk carries art. 9a with no UK amendment (read 18 Oct 2026). Whether HMRC applies it to a platform like Marktmorgen was not confirmed in any HMRC guidance read today; the Court of Justice's Fenix case was referred by a UK court and concerned HMRC's assessments of a UK platform.
- A non-established taxable person has no registration threshold in the UK (VAT Notice 700/1, sections 4.2 and 9.3, updated 4 Apr 2024 per the notice's history; the body was not read).
- Goods: the online marketplace rules make the marketplace the supplier of goods in the UK sold by an overseas seller and of imported consignments up to £135 (not read today).
- **OPEN**, reading used: art. 9a applies in the UK as in the EU; Marktmorgen registers for UK VAT from the first sale to a UK consumer, 20% on top or from the creator's payout, never from the commission; goods shipped to a UK address by a creator not established in the UK are refused until built.

## Physical goods in the EU (question 27)

- From 1 Jul 2021 an electronic interface that facilitates a distance sale of goods imported in consignments of up to EUR 150, or a supply of goods within the EU by a seller not established in the EU, is deemed to have received and supplied the goods (Directive art. 14a; "facilitates", Regulation art. 5b). Neither was re-read today.
- **OPEN**, reading used: Marktmorgen facilitates (it sets the terms and authorises the charge). The next build refuses those sales rather than register for the Union OSS and appoint an import OSS intermediary.


## Implementation checkpoint19October2026: record admission

The official14April2025 [EU consolidated text](https://eur-lex.europa.eu/eli/reg_impl/2011/282/2025-04-14/eng) was read directly for arts.9a,24b,24f and63c on19October2026, resolving the prior tool-access gap for those provisions. Article9a distinguishes participating platforms from payment processing alone. The general location rule uses two consistent evidence items; the limited single-item simplification refers to establishments in a Member State. Article24f includes billing, IP/geolocation and banking evidence; article63c specifies transaction, tax, payment and location records. This recheck does not resolve registrations, all other provisions, country rates, transaction classification or the complete launch gate.

Before admitting any future implemented treatment, lib/deemed-supplier.ts now requires a real calendar day, not merely a parseable timestamp. JavaScript can normalize February31 into March; accepting that as the recorded date weakens the evidence registry. Synthetic gate tests reject impossible month ends and non-leap February29, retain valid leap dates and show that no actual record or sales permission is created. This is registry hardening only, not implemented VAT collection, location evidence, OSS filing or ten-year retention. The existing empty registry and closed commercial gates stay intact.

No additional provider/data/storage/message operations, record retention or plan entitlement are added. Only constant-time local validation of the existing small registry changes; M0 before/after costs and margins remain unchanged for all plans/months/years. The most-tax model still fails60%. Before implementing collection or retention, calculate their paid worst-case cost and enforced reservations; unknown cost is not zero. Queue C-UE stays in progress.


## Creator-account controls: UI scope

The studio tax editor previously said without qualification that the creator files and pays the tax. That was broader than the implementation and this document's unresolved platform treatment. The controls remain creator-account Stripe Tax and invoice settings; their labels, values, save endpoint and provider behavior do not change. The interface now distinguishes that account setup from platform/marketplace duties, states that platform VAT collection/records are still being built, and states that entering a tax number alone does not establish treatment. It does not determine a transaction's legal outcome or claim registration/compliance.

The actual form describes itself through both visible explanations. Synthetic browser coverage reads the real studio at390/1280, checks scope text and unique accessible references, verifies fitting text and no POST, and does not open Stripe or save settings. This is clarity evidence, not actual screen-reader testing or every tax-state coverage.

The source change adds372characters of static copy/attributes (under1KB additional rendered static content) within the existing studio-page envelope. No extra provider/database/storage/message operation, record, allowance, rate or price; all plan monthly/annual M0 costs/margins stay before=after. The most-tax gate remains failed and sales stay closed. Actual EU collection, coherent location evidence, retention and their paid worst-case reservations remain separate unfinished C-UE work.
