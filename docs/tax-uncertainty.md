<!-- TX6-RESIDUAL-RISKS:START -->
# Current residual tax risks — 476 [TX6]

Read on: 2026-11-04. Scope: the risks left by the legally supported TX reading, not a new tax calculation. The [current TX policy](../AGENTS.md#tx--política-tributária-vigente-dono27102026-12h34-fortaleza) takes precedence over the historical readings below. The aggravating facts and design measures in this register are project-specific inferences from the cited texts; they are not findings that those facts exist or that the measures have been implemented.

A foreign LLC's registration, the owner's label as administrator, a creator's direct Stripe charge, or a foreign customer address does not by itself prove every applicable tax treatment. The evidence column is deliberately separate from the proposed mitigation. No conclusion of tax exemption, compliance, profit or opening readiness is made here.

| Risk | Aggravating facts to check | Design mitigation to retain or implement | Evidence still needed; residual uncertainty | Primary sources |
| --- | --- | --- | --- | --- |
| BR-ENTITY | The actual business has a Brazilian economic/professional unit, local service operations or contracts inconsistent with the foreign LLC being the supplier. | Keep the actual contracting entity, invoices, receipts, company accounts and operating records consistent; record where work and decisions occur. Never replace real facts with a nominal foreign address. | The actual contracts, payment flows and operating substance have not been audited here. The cited general rules do not by themselves determine corporate residence or which Brazilian taxes apply. | [R1], [R4] |
| BR-PERSON | Customers contract with or pay the owner personally for work; withdrawals described as dividends lack supporting company profit records. | Identify the owner in the capacity actually held, keep company and personal transactions distinct, and reconcile distributions to company accounts and profit records. | The owner's actual activities, remuneration and supporting accounts remain unverified. The foreign-profit regime is conditional; it is not a general exemption for personal service income. | [R2], [R3] |
| INSS | The owner receives amounts for work, or performs remunerated activity on their own account, even if a payment has a different label. | Separate and document remuneration, distributions and reimbursements according to their substance; retain the activity and payment records needed to evaluate contribution liability. | No actual payroll, compensation or distribution evidence is certified. An absent formal pro-labore entry alone does not settle the remuneration question; no presumed contribution amount is invented. | [R3] |
| ISS | A Brazilian economic/professional establishment provides the service, or a service developed in Brazil has its result there; foreign payment alone is relied upon as proof of export. | Keep contracts and delivery records identifying the supplier, service, customer and actual place of the result; assess the real establishment and service category separately. | Establishment, place of result, municipal classification and applicable rate are not established by this register. Neither zero ISS nor a universal 5% rate is certified. | [R4] |
| US-CLOUD | U.S. infrastructure or personnel contributes to providing the cloud service, or the facts include a U.S. office/agent; the owner's work location is treated as the sole sourcing fact. | Maintain an accurate supplier/region and activity inventory. Future European hosting under SV can reduce the U.S. infrastructure fact, while keeping other sourcing and business-presence facts under review. | The production footprint and sourcing allocation have not been verified. A U.S. server alone is not declared an office or an ECI determination. Moving a server does not settle personnel, intangible-property or other relevant facts. | [R5], [R6] |
| FACILITATOR | A destination's rules reach the platform's actual control of ordering, delivery or transaction terms, even though a third party processes payment; local product/recipient conditions are met. | Maintain a jurisdiction-and-product treatment matrix, evidence for recipient/supplier status, auditable sales counts and records, and consistent supplier identification. Preserve the existing direct-charge separation without treating it as an exemption. | Washington and Canada provide concrete counterexamples to a payment-only test, not a worldwide classification. Country/state scope, thresholds, exceptions, actual platform functions, records and compliance costs still require their own evidence. | [R7], [R8], [R9] |

## What the primary texts establish, and what they do not

All sources in this section were read on 2026-11-04. They support the limited propositions stated here; they do not certify Marktmorgen's actual circumstances.

- **R1 — Brazil, CTN (Lei 5.172/1966), arts. 126 III and 127 II.** The official consolidated text treats tax capacity independently of regular legal constitution and addresses an establishment's tax domicile. This supports checking the real economic unit, not a determination that the LLC is Brazilian or that every Brazilian tax applies.
- **R2 — Brazil, Lei 14.754/2023, art. 5 caput, §§5, 10 and 11.** The official consolidated text governs qualifying foreign-controlled profits and their accounts/distribution history. It does not turn a person's actual remuneration into company profit merely by naming it a dividend.
- **R3 — Brazil, Lei 8.212/1991, arts. 12 V f–h, 21 and 28 III.** The official consolidated text identifies individual-contributor categories and the remuneration basis. Actual work, remuneration and applicable classification must be established; this register computes no contribution or annual ceiling. The Planalto `l8212cons.htm` address was blocked; the complete official Chamber text was used instead.
- **R4 — Brazil, LC 116/2003, arts. 2 I and sole paragraph, 3, 4 and 5.** The official consolidated text distinguishes export/result, establishment and service provider. A foreign payer is not the sole export test; the establishment test concerns the actual economic/professional unit, regardless of its name. No municipal rate is inferred.
- **R5 — United States, 26 CFR §1.861-19(b), (c), (d) and (e).** The eCFR publisher displayed Title 26 updated through 2026-11-02. The text classifies qualifying cloud transactions as services; its paragraph (d) contains examples, not a final sourcing rule. Classification alone does not settle the source of this SaaS's income. The eCFR is the government's continuously updated, unofficial legal edition.
- **R6 — United States, IRS Internal Revenue Bulletin 2025-08, T.D. 10022 and REG-107420-24.** The classification decision is final; REG-107420-24 is proposed sourcing guidance, discussing personnel, intangible property and tangible property. The proposed formula is not adopted here as law or as a numerical tax input. A rulemaking timetable is not proof that a final rule took effect.
- **R7 — Washington, WAC 458-20-282(104)(a), (201)(a) and (201) Example 2.** The official rule requires a combination of activities; its example still treats the platform as facilitator when a third party processes payment. This defeats an automatic direct-charge exemption, without establishing Marktmorgen's actual classification, nexus or liability.
- **R8 — Canada, Excise Tax Act §211.1(1), distribution platform operator and excluded operator definitions.** The official consolidation displayed current to 2026-10-19. Essential transaction control and exclusions require their own factual analysis; payment routing alone does not settle the operator definition.
- **R9 — Canada, Excise Tax Act §211.13(1)–(2).** Under its specified supplier, recipient, platform and registration/business conditions, this section deems the operator to make the supply. It does not make every platform the supplier of every transaction. Registration thresholds and territorial/product scope are not determined here.

[R1]: https://www2.camara.leg.br/legin/fed/lei/1960-1969/lei-5172-25-outubro-1966-358971-normaatualizada-pl.html
[R2]: https://www2.camara.leg.br/legin/fed/lei/2023/lei-14754-12-dezembro-2023-795058-normaatualizada-pl.html
[R3]: https://www2.camara.leg.br/legin/fed/lei/1991/lei-8212-24-julho-1991-363647-normaatualizada-pl.html
[R4]: https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp116.htm
[R5]: https://www.ecfr.gov/current/title-26/section-1.861-19
[R6]: https://www.irs.gov/irb/2025-08_IRB
[R7]: https://app.leg.wa.gov/WAC/default.aspx?cite=458-20-282
[R8]: https://laws-lois.justice.gc.ca/eng/acts/E-15/section-211.1.html
[R9]: https://laws-lois.justice.gc.ca/eng/acts/E-15/section-211.13.html

## Decision boundary and remaining work

European hosting is risk reduction, not an opening gate. SV remains after opening under the owner's decision; this document neither changes a region nor makes a foreign server proof of zero tax. No tax consultation is required or prepared. No registration, account, contract acceptance, payment or external contact is performed or authorized by this register.

Unknown costs remain UNKNOWN, never zero. Any later financial review needs the applicable treatment, evidence and full costs; this matrix supplies no finite minimum customer base or new price, limit, commission, tax parameter, flag or opening condition. The worldwide facilitator/product review remains incomplete; no universal threshold or zero-tax rule is inferred. The EU consolidated text attempted in this session returned an anti-bot page, so no new full-current-EU-text verification is claimed; the existing EU review remains separately scoped.

VR: documented and checked in a PR, not a deployed product change. The register makes aggravating facts, design measures and missing evidence explicit. It does not implement the measures, verify actual company/provider records, finish TX1/TX3/TX4/TX5/TX7, or certify a legal or financial outcome. Research/CI and compliance costs remain unknown where not evidenced, allocated 100% to Marktmorgen under FX275. No interface or user action changes; no accessibility certification is claimed.

Historical material below remains unchanged; its old dates, consultation plans and incompatible readings are historical, not current instructions. The new register above does not adopt them.
<!-- TX6-RESIDUAL-RISKS:END -->

## TX1 — Conferência oficial parcial e divergências (27/10/2026)

Fonte de autoridade desta política: pedido do dono27/10/2026 12h34Fortaleza, integral em docs/codex-queue.md,471–477. As seções antigas abaixo, inclusive o título “MORE tax”, regra19 e consultas, são histórico; não comandam a execução atual. A [política TX vigente](../AGENTS.md#tx--política-tributária-vigente-dono27102026-12h34-fortaleza) prevalece. Este registro não adota automaticamente os17pontos nem declara concluídoTX1.

Conferido27/10/2026 no texto oficial da [Lei14.754/2023 de12/12/2023, Câmara](https://www2.camara.leg.br/legin/fed/lei/2023/lei-14754-12-dezembro-2023-795058-normaatualizada-pl.html): art.2§1 estabelece15%anual;art.5caput/§5/§10 disciplinam controladas enquadradas,apuração31/12 e balanço;§11 impede nova tributação da distribuição de lucros já tributados. Isso sustenta o mecanismo legal, não autentica enquadramento real da LLC, balanço ou incidência de outros tributos. A referência IN1.037 art.2IV do pedido ainda não foi confirmada: texto integral do ato RFB não foi recuperado nesta rodada; busca oficial apontaVII e exige conferir ato vigente antes de corrigir/adotar. Não declarar incisoIV verificado.

Conferido27/10/2026 no [Decreto6.306/2007 de14/12/2007, texto atualizado da Câmara](https://www2.camara.leg.br/legin/fed/decret/2007/decreto-6306-14-dezembro-2007-566561-normaatualizada-pe.html): art.14 define base pelo valor em reais da operação cambial;art.15-BXXV prevê0,38%para demais entradas não isentas/não abrangidas pelos incisos anteriores, com remissões às alterações2025 eADC96. A fonte não diz que IOF incide automaticamente sobre lucro contábil. Classificação da operação,isenções e efeitos das remissões precisam de revisão antes de aplicar.

**Depende do dono — divergência delimitada TX4/IOF:** ponto4do pedido diz0,38%sobre valor que entrar no Brasil;textoTX2 diz0,38%sobre lucro. Art.14vincula a operação cambial. Registrar a inconsistência e conservar somente o componente IOF atual até correção deste ponto; não substituir por15,38%sobre lucro como se fosse identidade legal conferida, não presumir remessa zero nem exigir consulta. Restante da pesquisa prossegue.

Conferido27/10/2026 na [LC116/2003 de31/07/2003, Planalto](https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp116.htm): art.2I eparágrafoúnico tratam exportação/resultado;art.3 estabelece regra geral e exceções. A localização do cliente,sozinha,não prova resultado no exterior nem inexistência de estabelecimento. Art.4 e análise factual ainda serão conferidos antes de concluir o pontoISS; não adotarISSzero por essa leitura parcial,nem tratar5%como conclusão jurídica certa.

Sem alteração de cálculos/código nesta etapa. Restantes pontosIRPJ/CSLL/PIS/Cofins/IBS/CBS/INSS/IVA/obrigações,USA/estados e Europa/outrospaíses permanecem em conferência; não sãozero comprovado. Sem consulta,contato,submissão ou serviço novo. VR: política executável para o trabalho atualizada;interpretações/parâmetros não implementados;TX1incompleto. Custos pesquisa/CI/fixos desconhecidos nãozero,100%FX275.

# Tax uncertainty: always the hypothesis with MORE tax (owner's rule 19, 17 Oct 2026; research of 18 Oct 2026)

The owner's words (Portuguese, verbatim, 17 Oct 2026):

> 19. REGRA PARA A INCERTEZA Onde a legislação deixar dúvida ou houver mais de uma interpretação, use a hipótese que der MAIS imposto, para nunca superestimar o meu lucro, e liste essas dúvidas no fim, para eu confirmar com um contador antes de abrir a empresa.

On 18 Oct 2026 the owner decided not to use an accountant. Rule 19 stays as it is: where a doubt remains, the reading with more tax is used. What changes is how a doubt is closed. **A doubt is closed only by:**

- an **official text** that settles it, cited with its link; or
- an **answer to a consultation** (Receita Federal under IN RFB 2.058/2021, or the Prefeitura de Fortaleza for ISS), recorded here and in [tax-consultations.md](tax-consultations.md) with its date and source, and in `CONSULTATION_ANSWERS` (`lib/tax-gate.ts`).

**Otherwise it stays at the most-tax reading.** Nothing here is advice and nothing here is a finding of compliance; it is the research of 18 Oct 2026 and the readings the code uses.

Binding for Hazelsong and Marktmorgen, together with the 60% rule (AGENTS.md, "Owner's margin rule, restated 17 Oct 2026"). Questions 1 to 22 carry the same numbers as Hazelsong's docs/tax-uncertainty.md (the same LLC, the same owner); what differs for Marktmorgen is said in each. Questions 23 to 27 are Marktmorgen's own, because Marktmorgen is a platform on which creators sell (see [eu-vat-article-9a.md](eu-vat-article-9a.md)).

## Statuses

- **CLOSED-TEXT**: an official text settles it.
- **CLOSED-DESIGN**: a business choice settles it.
- **CLOSABLE-CONSULTA**: the free Receita consultation can settle it (drafts: three, listed in [tax-consultations.md](tax-consultations.md)).
- **OPEN**: the most-tax reading stays (rule 19).

Counts for Marktmorgen: **CLOSED-TEXT 9, CLOSED-DESIGN 3, CLOSABLE-CONSULTA 3, OPEN 12**, over 27 questions. Question 9 is counted twice (same year CLOSED-TEXT, later year CLOSABLE-CONSULTA) and question 21 is a pointer to 7 and 10, so it is not counted. Hazelsong counts CLOSED-DESIGN 4 because its question 14 is closed by the owner's decision A; that decision is Hazelsong's, so for Marktmorgen question 14 is OPEN.

## The 27 questions

Each: the status, the answer with its citation and link, and the reading the code uses.

1. **US effectively connected income (ECI).** OPEN.
   Foreign-source income is ECI only with a US "office or other fixed place of business", meaning a fixed facility (26 U.S.C. §864(c)(4)(A)–(B), https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title26-section864&num=0&edition=prelim; 26 CFR §1.864-7(b)(1), https://www.ecfr.gov/current/title-26/section-1.864-7). An independent agent's office does not count (§1.864-7(d)(2)). No text says where automated SaaS on US servers is "performed".
   Reading used: ECI at up to 37% (`MOST_TAX_READING` in `lib/receiving-costs.ts`, the gate today through `gateReading()` in `lib/tax-gate.ts`). After EU hosting is live and verified (`EU_HOSTING_CONFIRMED`), the gate may move to the after-design reading (`EU_HOSTING_READING`), with no US federal tax. Both products are one LLC: Marktmorgen's flag is set only once Marktmorgen's own servers AND Hazelsong's are in EU regions, so that neither product gives the LLC a US place of business.
2. **US state income tax.** OPEN.
   California sources a nonresident's services by market (Cal. Rev. & Tax. Code §25136, https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=25136; *Suurs*, 2026-OTA-238, https://ota.ca.gov/). Unitary treatment of a nonresident sole proprietor is pending in *Garcia-Rojas v. FTB*, S297035 (https://appellatecases.courtinfo.ca.gov/).
   Reading used: California's top rate, 13.3% of profit, on every customer, because any creator may be in California and the rule is per customer.
3. **Who collects sales tax/VAT on Marktmorgen's own plans.** CLOSED-DESIGN.
   Marktmorgen bills its plans on its own Stripe account (`lib/billing.ts`); Stripe is not merchant of record (https://stripe.com/pricing).
   Reading used: no tax inside the price; the buyer's tax added on top at up to 27%, and the payment fee charged on the whole amount (`lib/receiving-costs.ts`). Registration by threshold where a threshold exists, and from the first sale where none does (question 14). The sales a creator makes in a store are questions 20 and 23 to 27, not this one.
4. **US 30% FDAP withholding.** OPEN (follows from 1 and 22).
   Applies only to US-source income that is not ECI (26 U.S.C. §861(a)(3), https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title26-section861&num=0&edition=prelim; https://www.irs.gov/individuals/international-taxpayers/nra-withholding).
   Reading used: inside the 37% of question 1 today; none after EU hosting (no US-source income).
5. **Brazil, Lei 14.754.** CLOSED-TEXT.
   A US state LLC owned by non-residents is a privileged regime (IN RFB 1.037/2010 art. 2º, VII, https://normas.receita.fazenda.gov.br/sijut2consulta/link.action?hidemenu=true&idAto=16002; SC Cosit 56 of 9 Apr 2026). So art. 5 §5, I applies: 15% on 31 Dec, distributed or not (Lei 14.754/2023, https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2023/lei/l14754.htm). Transparency (art. 8) is optional.
   Reading used: 15% of the LLC's profit (inside `EU_HOSTING_READING`); `MOST_TAX_READING` takes 27.5%, the individual top rate, should the profit be taxed through the owner.
6. **Brazil credit for US tax.** CLOSABLE-CONSULTA (Receita consultation 1).
   Art. 5 §15 of Lei 14.754 credits tax "devido no exterior pela controlada". A disregarded LLC's US tax is owed by the owner.
   Reading used: no credit until answered; every tax is added in full.
7. **INSS.** CLOSABLE-CONSULTA (Receita consultation 2).
   Contribuinte individual, 20% up to the ceiling (Lei 8.212/1991 arts. 12 V h, 21, 28 III, https://www.planalto.gov.br/ccivil_03/leis/l8212cons.htm; 2026 ceiling R$ 8,475.55, https://www.gov.br/inss/pt-br/direitos-e-deveres/inscricao-e-contribuicao/tabela-de-contribuicao-mensal). No text says whether LLC profit is remuneration.
   Reading used: due, as a fixed cost of the owner shared 50/50: 20% of the ceiling, R$ 20,341.32 a year, at R$ 4.50 per dollar, $4,520.30 a year (Hazelsong's `FIXED_COSTS_ANNUAL_CENTS.shared.inssContribuinteIndividual`); Marktmorgen's half $2,260.15.
8. **IOF.** CLOSED-TEXT.
   Decreto 6.306/2007 art. 15-B as worded by Decreto 12.499/2025: 0.38% on bringing in a profit distribution (XXV); 3.5% on card purchases abroad (VII) and other transfers out (XXIV) (https://www.planalto.gov.br/ccivil_03/_ato2007-2010/2007/decreto/d6306compilado.htm, https://planalto.gov.br/ccivil_03/_ato2023-2026/2025/decreto/d12499.htm).
   Reading used: 0.38% of profit, and the remittance allowance on revenue kept too (`REMITTANCE_BPS`, 1.5%), so IOF is counted twice; `MOST_TAX_READING` adds 3.5% on what is sent. Receita consultation 3 asks whether the zero rate of inciso I applies instead. VAT money Marktmorgen would remit to an EU or UK tax authority (question 20) leaves the LLC's own account abroad and is never exchanged in Brazil.
9. **Minimum tax on high incomes (Lei 15.270/2025, from 2026).** Same year CLOSED-TEXT; later year CLOSABLE-CONSULTA (Receita consultation 1, question 5).
   Above R$ 600k a year; the Lei 14.754 tax is deducted (Lei 9.250 art. 16-A §3º III as added by Lei 15.270, https://bibliotecadigital.mj.gov.br/bitstream/1/16356/1/LEI_PR_2025_15270.html), so nothing extra in the same year. A distribution in a later year is not settled.
   Reading used: profit distributed in the year it is taxed, or the owner stays below R$ 600k; nothing extra is modeled.
10. **ISS Fortaleza.** OPEN (consultation 4, to the Prefeitura de Fortaleza).
    LC 116/2003 arts. 2º I and II, 3º, 4º, 5º, 7º, 8º II (maximum 5%) (https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp116.htm). The provider is the LLC; the exception "desenvolvidos no Brasil, cujo resultado aqui se verifique" is unsettled. The consultation is municipal (the Receita refuses it, IN 2.058 art. 27, XIII): CTM, LC 159/2013 arts. 27, 176, 177 as amended by LC 430/2025, and Decreto 13.716/2015 arts. 495–499. Also OPEN: the item (1.03, 1.05, 1.09, and for Marktmorgen's share of sales also 10.05, intermediação) and its rate; whether the owner is the taxpayer; whether it is an export.
    Reading used: 5% of Marktmorgen's REVENUE (its plans and its share of sales), not of profit, not deducted before the profit taxes (`revenueTaxBps` 500 in `lib/receiving-costs.ts`). The base for what the creators sell is question 25. The Fortaleza draft describes only Hazelsong; before it is filed it must describe Marktmorgen too ([tax-consultations.md](tax-consultations.md)).
11. **Delaware and Form 5472.** CLOSED-TEXT (fixed costs).
    Delaware: $400 a year from tax year 2026 (HB 400; Chapter 273, Vol. 85, https://legis.delaware.gov/SessionLaws/Chapter/GetPdfDocument?fileAttachmentId=655304; https://corp.delaware.gov/alt-entitytaxinstructions/; [delaware-annual-tax-update.md](delaware-annual-tax-update.md)). Form 5472 with a pro forma 1120; penalty $25,000 per failure (https://www.irs.gov/instructions/i5472).
    Reading used: $400 a year, shared 50/50; Form 5472 preparation $0, because the owner prepares it himself.
12. **Carnê-leão vs annual return; exchange rate.** CLOSED-TEXT.
    Profit enters the annual return (DAA) on 31 Dec at the Central Bank's closing sell rate (Lei 14.754 art. 5 §§10–12).
    Reading used: as the text says.
13. **Records.** CLOSED-TEXT.
    EU: 10 years for a special scheme (Directive 2006/112/EC arts. 369 for the non-Union scheme and 369k for the Union scheme, https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32006L0112), with the content of Implementing Regulation 282/2011 art. 63c. US: while material (26 CFR §1.6001-1(e), https://www.ecfr.gov/current/title-26/section-1.6001-1). Brazil: until the tax claim expires (CTN art. 195, https://www.planalto.gov.br/ccivil_03/leis/l5172compilado.htm).
    Reading used: **10 years** from the end of the year, for Marktmorgen's own records (each plan invoice and each share of a sale, on Marktmorgen's own Stripe account, which is not deleted when a store closes). Until 18 Oct 2026 this said 7 years; 10 is longer, so it replaces it. Today a closed store's per-sale rows are deleted with the store and nothing of its sales is copied anywhere (`lib/closed-store-data.ts`), which is right while Marktmorgen is not the supplier of any sale. Once Marktmorgen is the deemed supplier of a sale (question 20), that sale's art. 63c record is Marktmorgen's own record and must be kept 10 years apart from the store, whatever becomes of the store: part of the build in [eu-vat-article-9a.md](eu-vat-article-9a.md). Whether Stripe's own retention is enough as the record of Marktmorgen's invoices is not settled by any text read; under rule 19 the LLC keeps its own copy (an export of its invoices and fees), to be built before the first paid sale.
14. **EU and UK buyers of Marktmorgen's own plans.** OPEN (no owner decision for Marktmorgen).
    Directive 2006/112/EC arts. 44 and 196: reverse charge for a business buyer. Implementing Reg. 282/2011 art. 18(2) (https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32011R0282): with no VAT number the supplier may treat the buyer as a consumer. UK: HMRC VATPOSS01350 (https://www.gov.uk/hmrc-internal-manuals/vat-place-of-supply-services/vatposs01350). Hazelsong's decision A (EU VAT number required and checked in VIES, consumers refused) was taken for Hazelsong.
    Reading used: an EU creator without a VAT number checked in VIES, and a UK creator without UK business evidence, is a consumer, and Marktmorgen owes VAT on the plan at that country's rate from the first sale (no threshold for a supplier established outside the EU or the UK): on top of the price, through the same non-Union OSS and UK registrations as question 20.
15. **Canada, Marktmorgen's own plans.** CLOSED-DESIGN.
    GST/HST: simplified registration above $30,000 a year of sales to consumers and unregistered businesses (Excise Tax Act s. 211.12, https://laws-lois.justice.gc.ca/eng/acts/E-15/section-211.12.html). QST: $30,000 (https://www.revenuquebec.ca/en/). BC PST 7% on SaaS (https://www2.gov.bc.ca/gov/content/taxes/sales-taxes/pst/publications/software). Manitoba RST on cloud and SaaS from 1 Jan 2026 (https://www.gov.mb.ca/finance/taxation/).
    Reading used: tax-exclusive prices with thresholds; Manitoba from the first sale. Canada's rules for a platform on the creators' sales are question 24.
16. **US sales tax on Marktmorgen's own plans.** CLOSED-DESIGN.
    Washington: more than $100,000; SaaS is a retail sale (https://dor.wa.gov/). Other states not verified one by one.
    Reading used: threshold monitoring, tax added on top. Marketplace-facilitator rules on the creators' sales are question 23.
17. **California $800 and LLC fee.** OPEN (a fixed cost).
    Doing business = the lesser of the indexed amount ($757,070 in 2025) or 25% of sales (Cal. Rev. & Tax. Code §23101, https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=23101). Not a safe harbor (FTB Chief Counsel Ruling 2016-03). Fee: $900 from $250k of California income.
    Reading used: $800 a year, shared 50/50, every year. The fee from $250k of California income is not in the per-customer reading.
18. **Washington B&O.** CLOSED-TEXT.
    Retailing rate 0.471% above $100,000 (https://dor.wa.gov/taxes-rates/business-occupation-tax).
    Reading used: none below the threshold; registration by threshold.
19. **Chicago lease tax.** CLOSED-TEXT.
    15% from 2026 (rests on secondary reports). No duty to collect without sufficient contacts; small new business exemption (https://www.chicago.gov/city/en/depts/fin.html).
    Reading used: not collected.
20. **EU art. 9a: Marktmorgen as the supplier of what a store sells electronically.** CLOSED-TEXT (it applies) for every electronically supplied path; its treatment is NOT BUILT.
    Implementing Reg. 282/2011 art. 9a: a taxable person taking part in a supply of electronically supplied services through an interface or portal is presumed to act in its own name; one who authorises the charge, authorises the delivery or sets the general terms and conditions may not name another person as the supplier. Marktmorgen does all three. The citations, the reading path by path and what follows are in [eu-vat-article-9a.md](eu-vat-article-9a.md).
    Reading used: VAT at the consumer's Member State rate (up to 27%) on the whole price of every sale to an EU consumer through a store, owed by the LLC through the non-Union OSS from the first sale, with the art. 63c records kept 10 years; VAT added to the buyer's price or taken from the creator's payout, never from Marktmorgen's commission (the owner's design). Until that is built and recorded, no store may sell: `PLANS_ON_SALE` needs `deemedSupplierReady()` (`lib/deemed-supplier.ts`).
21. **INSS/ISS for the owner.** See 7 and 10.
22. **§1.861-19 cloud.** OPEN (source).
    The classification as services is final (T.D. 10022, 14 Jan 2025, https://www.irs.gov/irb/2025-08_IRB; 26 CFR §1.861-19, https://www.ecfr.gov/current/title-26/section-1.861-19). The source rule REG-107420-24 is only proposed; it counts R&D staff, service staff and the location of property such as servers.
    Reading used: as question 1 today; after EU hosting, foreign source.
23. **US marketplace-facilitator laws on the creators' sales.** OPEN (not researched state by state).
    Most US states with a sales tax make a "marketplace facilitator" collect it on sales it facilitates, with the threshold counted on all the sales it facilitates. No state's text was read on 18 Oct 2026, and whether a platform whose sales are direct charges on the seller's own Stripe account "collects payment directly or indirectly" is not settled by anything read.
    Reading used: Marktmorgen is a marketplace facilitator in every state that has such a law, from the first sale in a state where no threshold applies and from the threshold otherwise, counted over every creator's sales into that state; the tax added on top of the buyer's price or taken from the creator's payout, never from the commission. Not built: no store may sell while `deemedSupplierReady()` lacks a record for "US".
24. **Other countries' platform rules on the creators' sales.** OPEN (not researched).
    Several countries make a platform the supplier, or the collector, of digital services sold through it by sellers established abroad (for example Canada's distribution platform operators under the Excise Tax Act since 1 July 2021, Australia's electronic distribution platforms, New Zealand, Norway, Switzerland, Singapore, Japan). None was read on 18 Oct 2026.
    Reading used: such a rule applies wherever it exists, from the first sale; the same treatment as question 20 (VAT/GST on top, or the country's consumers refused). Not built: a record for "other" is required by `deemedSupplierReady()`.
25. **The base of ISS for what the creators sell.** OPEN (to be added to consultation 4, Fortaleza).
    LC 116/2003 art. 7º sets the base at the price of the service. Marktmorgen does not receive the price of a creator's sale (a direct charge on the creator's own account) and its terms make the creator the seller; art. 9a deems Marktmorgen the supplier only "for the application of Article 28" of the VAT Directive, a fiction of EU VAT. No Brazilian text read says whether a sale that EU VAT deems Marktmorgen's is part of its "preço do serviço".
    Reading used: until Fortaleza answers, ISS at 5% of Marktmorgen's own revenue (question 10) AND at 5% of the price of every sale Marktmorgen is deemed to supply under question 20, 23 or 24. Under it no plan that lets a store sell to an EU, UK or other deemed-supplier consumer can keep 60% (a 5% tax on the sale against a share of at most 6.25%), which is one more reason sales stay closed. If the answer is "only Marktmorgen's own fees", this question closes.
26. **United Kingdom: the same rule for digital services, and the online marketplace rules for goods.** OPEN.
    Art. 9a appears in the UK's own text of Implementing Regulation 282/2011 on legislation.gov.uk with no UK amendment (https://www.legislation.gov.uk/eur/2011/282/article/9a/data.htm, read 18 Oct 2026). A non-established taxable person has no UK registration threshold (VAT Notice 700/1, https://www.gov.uk/government/publications/vat-notice-7001-should-i-be-registered-for-vat, last updated 5 Aug 2026; its body was not read). Goods sold through an online marketplace: the marketplace is the supplier for goods in the UK sold by overseas sellers and for imported consignments up to £135 (not read on 18 Oct 2026).
    Reading used: Marktmorgen is the supplier of every electronically supplied sale to a UK consumer, registers for UK VAT from the first such sale, charges 20% on top or from the creator's payout, and is the supplier of physical goods shipped to a UK address by a creator not established in the UK. Detail in [eu-vat-article-9a.md](eu-vat-article-9a.md). Not built: a record for "UK" is required by `deemedSupplierReady()`.
27. **EU: physical goods sold through a store.** OPEN (art. 14a of the Directive and art. 5b of the Implementing Regulation not re-read on 18 Oct 2026).
    From 1 July 2021 an electronic interface that facilitates a distance sale of goods imported in consignments of up to €150, or a supply of goods within the EU by a seller not established in the EU, is deemed to have received and supplied them (Directive 2006/112/EC art. 14a; Implementing Reg. 282/2011 art. 5b on "facilitates").
    Reading used: Marktmorgen facilitates (it sets the terms and authorises the charge) and is the deemed supplier of every physical product shipped to an EU address by a creator whose Stripe account is not in the EU, and of every consignment shipped into the EU from outside it. Not built; the next build refuses those sales instead ([eu-vat-article-9a.md](eu-vat-article-9a.md)).

**Links.** Each link above is the official publisher's location of the cited text. Where the research read a reproduction or nothing, that is said in the next list.

**Pages not read from the official site:**

- normas.receita (IN 2.058, IN 1.037, SC Cosit 56) were read from reproductions (Hazelsong's research of 18 Oct 2026).
- Never fetched: Chicago's 2026 notice, the QST page, the Manitoba rate and threshold, California's 2026 threshold, the INSS 2026 portaria, Fortaleza's tax code (its consultation's fee, channel, deadline and binding effect are OPEN), the Central Bank's PTAX series, any US state's marketplace-facilitator law, any country's platform rule of question 24, the body of VAT Notice 700/1, the Directive's art. 14a, and HMRC's online marketplace guidance for goods.
- EUR-Lex refused the consolidated Implementing Regulation and the Directive on 18 Oct 2026 (the page did not render its text, then HTTP 429); arts. 7, 9a, 24a–24c and 63c were read from the UK National Archives' copy of the EU text (legislation.gov.uk, the text as it stood on 31 Dec 2020, which notes no UK amendment). See [eu-vat-article-9a.md](eu-vat-article-9a.md).

## Combined tax on $100 of the LLC's profit (no VAT inside the price)

| Reading | Breakdown | Combined |
| --- | --- | --- |
| (a) Supported by the texts | Brazil 15 + IOF 0.38 | **15.38%** |
| (b) Most tax after the design choices (`EU_HOSTING_READING` in `lib/receiving-costs.ts`) | Brazil 15 + IOF 0.38 + CA 13.3 of profit, plus ISS 5% of revenue | **28.68% of profit + 5% of revenue** |
| (c) Most tax, every tax stacked (`MOST_TAX_READING`, the gate today) | US 37 + CA 13.3 + Brazil 27.5 + IOF 0.38 of profit, plus ISS 5% of revenue, 27% VAT inside the price and IOF 3.5% on what is sent | **78.18% of profit + 5% of revenue** |

Under (c) no unit of Marktmorgen keeps 60% at any limit, even with nothing used ([margin-alignment-2026-10-18.md](margin-alignment-2026-10-18.md)). Question 25's reading adds 5% of the creators' sales to EU, UK and other deemed-supplier consumers on top of every row.

## What the code does with this (18 Oct 2026)

1. **The gate reading** (`lib/tax-gate.ts`, `gateReading()`): `MOST_TAX_READING` (every tax stacked), because EU hosting is not live: `EU_HOSTING_CONFIRMED` is false, and `gateProblems()` refuses the after-design reading while it is. `tests/tax-gate.test.ts` fails if the old confirmation flag comes back, if a recorded consultation answer lacks its question, authority, date, source or reading, if the gate setting is refused, or if anything is on sale while a published plan misses 60% under the gate reading with nothing used.
2. **The release gate** (`lib/opening.ts`): `PLANS_ON_SALE` needs the per-customer margin review of `lib/commercial-margin.ts` (none exists, so it is false), a gate setting `gateProblems()` accepts, well-formed consultation answers, and, since 18 Oct 2026, a recorded deemed-supplier treatment for the EU (art. 9a), the UK, US states and other countries (`deemedSupplierReady()`, `lib/deemed-supplier.ts`). A store sells only with a paid or trial plan (`canSell`, `lib/store-checkout.ts`; PayPal likewise), and a plan can be started only while `PLANS_ON_SALE` is true, so no store can sell today.
3. **The sizing** stays where it was (27.5% on profit, no tax inside, `SIZING_READING`): no limit is lowered by this change.
4. **Fixed costs** shared 50/50 with Hazelsong (Hazelsong's `FIXED_COSTS_ANNUAL_CENTS.shared`): Delaware $400, California $800, INSS $4,520.30, Form 5472 $0 (self-prepared), no accountant ($0) since 18 Oct 2026, registered agent, domains and tools as Hazelsong lists them. Marktmorgen's company review (`CURRENT_COMMERCIAL_MARGIN_REVIEW`) is absent, so no minimum base is computed here yet. If Marktmorgen becomes a deemed supplier, its OSS and UK returns are prepared by the owner ($0, not verified that no Member State charges for registration).

## What remains (the most-tax reading is used for each)

1. ECI and the source of cloud income (1, 4, 22): closed by design only once both products' servers are in EU regions and verified.
2. California (2, 17): 13.3% of profit on every customer and $800 a year.
3. ISS in Fortaleza (10, 25): 5% of revenue, and 5% of every deemed-supplier sale, until the Prefeitura answers.
4. The credit for foreign tax (6), INSS (7), IOF's zero rate (8) and the later-year minimum tax (9): until the Receita answers.
5. Marktmorgen as deemed supplier (20, 23, 24, 26, 27): the treatment, the registrations and the records are not built; [eu-vat-article-9a.md](eu-vat-article-9a.md) has the next build.
6. EU and UK creators without a checked VAT number buying a plan (14): VAT due by Marktmorgen.
7. Marktmorgen's own copy of its invoices and fees for 10 years (13): to be built before the first paid sale.

When an answer arrives: record it in [tax-consultations.md](tax-consultations.md) and in `CONSULTATION_ANSWERS` (`lib/tax-gate.ts`) with its date and source, change the reading it closes, then recompute; never before.


## FX275 allocation supersession — 22 October2026

Owner22/10/2026 05:10Fortaleza: "esqueça Hazelsong". All LLC fixed taxes/costs are100% Marktmorgen, superseding every earlier50/50/half amount in this historical research. INSS fullBRL1695.11/month,20341.32/year; Delaware fullUSD400/year; California fullUSD800/year plus entire applicable income-tierLLCfee (up toUSD11790 under the official schedule). Earlier USD conversion at4.50BRL/USD is historical, not a verified future currency ceiling. Registered agent, domains, tools, mailbox andEU/UK representatives are entire company costs too. Current dated sources, native prices, unknown ceilings and rejected minimum-base result: [full fixed costs](llc-fixed-costs-2026-10-22.md). No tax reading, consultation status, gate or commercial review changes. Unknown never becomes zero; no finite base or60% certification.


## SR467 — Elegibilidade Stripe não equivale a tratamento tributário (27/10/2026)

A [regra SR](stripe-platform-eligibility.md),dono27/10/2026 08h00Fortaleza,subordina respostasStripe contraditórias àmenosfavorável. BRsóconectaBR;planejamentoUS exigeSSN/ITIN,representante residente eendereço comercialreal semcaixapostal. Esse relato nãofecha nenhuma dúvida tributária nem prova residênciafiscal,dispensa legal,custo,aceite real ouhospedagemUE. Textos anteriores/citações ficam históricos;leitura MAIS onerosa eISS5%segueminteiros.469[SR3]custos/FX275 e468[SR2]contaempresaUS comprovada continuam pendentes;sem consulta/contato/conta/pagamento. MRsubstitui somente opiso60%,nãoimpostos,reservas ouevidência.
