# TX2a — Separate annual profit and incoming exchange bases

Source check: 31 October 2026. Owner decisions: queue item 472, DR and AV8, including the 31 October IOF and IN RFB 1.037 article 2 VII corrections. It began as a bounded arithmetic scenario (TX2a). Since then this reading has become the binding one (next section). It is still not a legal or commercial review, a registration or permission to sell.

## Implemented arithmetic

`MOST_CORRECT_READING` describes the requested scenario: IRPF 15%, revenue tax 0%, buyer tax outside the price up to 27% where legally due, and a separate incoming-exchange IOF rate of 0.38%. Its zero revenue-tax coefficient is scenario metadata, not evidence that every tax is inapplicable to the real business. Consumption classification, state income/franchise nexus, registrations, actual facts and other country taxes still require their own complete evidence.

`mostCorrectTaxesOf` accepts annual accounting profit and a complete explicit list of incoming exchange operations. Both bases must already be BRL cents; unknown currency/conversion, profit or exchange coverage returns null. An explicit empty exchange list represents no entry; it never removes annual IRPF. A distribution of profit already taxed is not another annual profit, but its exchange operation still belongs in the incoming list. Annual losses create no credit here against IOF. Prior-year loss compensation, credits and real return preparation are outside this calculator.

The calculator accepts at most10,000 explicit exchange operations for one supplied annual book. Larger books return null before reading or enumerating any operation; no prefix, partial tax or zero-tax result is returned. This bounds evidence-processing work even for proxy-backed arrays with virtual entries. It is an internal calculator bound, not a limit on financial operations, a legal threshold or permission to omit operations. Larger real books require a separately reviewed complete accounting path; they must not be split into calls that duplicate annual IRPF or discard coverage.

IRPF is rounded upward to a whole cent. IOF is rounded upward for each separately supplied operation, then summed with exact integer arithmetic; these are conservative modeled ceilings, not actual payment instructions or a claim about a bank's final assessment. Unsafe amounts, sparse/inherited entries, accessors and unreadable evidence refuse. No exchange rate or entry amount is inferred from annual profit, including no assumption that IRPF is paid before remitting profit.

Example: BRL10,000 annual profit with no entry has modeled IRPF BRL1,500 and IOF0. An explicit BRL5,000 entry gives IOF BRL19. An explicit entry of the entire BRL10,000 gives IOF BRL38, in addition to the annual IRPF. None of these modeled amounts certifies real accounts or excludes other applicable taxes.

## Primary sources and limits

- [Lei 14.754/2023, updated Chamber text](https://www2.camara.leg.br/legin/fed/lei/2023/lei-14754-12-dezembro-2023-795058-normaatualizada-pl.html), articles 2 paragraph1 and 5 caput, paragraphs5,10 and11: the annual15% mechanism,31December accounting, distribution independence and no repeated IRPF on previously taxed distributed profit. Read on31October2026.
- [Decreto 6.306/2007, updated Chamber text](https://www2.camara.leg.br/legin/fed/decret/2007/decreto-6306-14-dezembro-2007-566561-normaatualizada-pe.html), articles14 and15-BXXV: exchange-operation base and0.38% for the specified remaining incoming operations. The compiled text links the2025 amendments, DL176/2025 and ADC96; no exemption is presumed. Read on31October2026. The owner explicitly adopted this classification for the described LLC profit entries.
- [Official Receita IN1.037 record](https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/16002): the queue's owner decision adopts article2VII for the described state LLC owned by a Brazil-resident sole member and not subject to US federal income tax. This reading attempt returned no readable text on31October; this document does not claim a fresh full-text retrieval. The [official Receita index](https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action?anoAtoFacet=&ano_ato=&dt_fim=&dt_inicio=&facetsExistentes=&lblTiposAtosSelecionados=SC%3B+SCI%3B+SD&numero_ato=&optOrdem=relevancia&ordemColuna=Publicacao&ordemDirecao=DESC&orgaosSelecionados=Cosit&p=1&siglaOrgaoFacet=&somente_atos_vigentes=on&termoBusca=%22Assunto%3A+Imposto+sobre+a+Renda+Retido+na+Fonte%22+OR+%22Assunto%3A+Imposto+sobre+Produtos+Industrializados%22+OR+%22Assunto%3A+Imposto+sobre+a+Propriedade+Territorial+Rural%22+OR+%22Assunto%3A+Imposto+sobre+Opera%C3%A7%C3%B5es+de+Cr%C3%A9dito%2C+C%C3%A2mbio+e+Seguros+ou+relativas+a+T%C3%ADtulos+ou+Valores+Mobili%C3%A1rios%22&tipoAtoFacet=&tipoConsulta=formulario&tipoData=2&tiposAtosSelecionados=72%3B+75%3B+73) identifies Cosit56/2026 and article2VII for transparent LLCs owned by non-US residents. Changed LLC facts require a new classification; this calculator does not authenticate real company records.

## The binding reading today (updated 19 November 2026)

Read on main on 19 November 2026. The earlier text of this section, "the binding gate remains `MOST_TAX_READING`; the 27.5% stress/sizing floor remains", described 31 October and is no longer true:

- `lib/tax-gate.ts`: `GATE_READING_ID` is `"most-correct"` and `gateReading()` returns `MOST_CORRECT_READING`. Neither depends on `EU_HOSTING_CONFIRMED` or `CONSULTATION_ANSWERS` (PR #1106, then PR #1490).
- `lib/receiving-costs.ts`: `READINGS` holds only `MOST_CORRECT_READING`. The unit model reads it: IRPF 15% on the yearly profit, IOF 0.38% per incoming exchange, buyer tax on top up to 27%, revenue tax 0 and no US federal income tax. No 27.5% floor applies to it (`FLOOR_BPS` 0; positive net, rule MR).
- `tests/plan-cost-model.ts` (`netOf`) and the generators use it. `docs/margin-alignment-2026-10-18.md` states it.
- The 27.5% stress floor, `SIZING_READING`, `MOST_TAX_READING` (78.18% on profit, 5% ISS on revenue) and the EU-hosting readings survive only in `tests/historical-receiving-model.ts` and `tests/historical-margin-model.ts`. They feed the labeled "was" columns of the generated documents, and `tests/historical-margin-isolation.test.ts` keeps them out of every live calculation.

What is still open in queue item 472:

- **TX point 9:** US state income and franchise tax, 0% below each state's doing-business threshold, with sales counted per state and collection turned on before each threshold. No such automation exists yet. `lib/customer-tax-review.ts` accepts the `usStates` component only as a reviewed ceiling, and `lib/tax-threshold.ts` holds only the Canadian and Norwegian rules. Until a state's rule has an official dated source and its tests, that state stays unknown, and unknown refuses.
- Every unknown cost or tax still refuses admission. Consultation records stay empty, EU hosting false, the commercial review null, and the sales and opening flags false. Receiving fees, the remittance allowance, reserves, prices, visible limits, rights, content and Hazelsong are unchanged.

## Costs and verification

No productive network call, command, key, stored record, paid service or dependency is added. Incremental productive monthly/annual cost: Store0/0,Studio0/0,Scale0/0 in each interval, because this is local pure arithmetic only. Existing costs and paid research/CI/hosting invoices remain unknown, never zero, allocated100%to Marktmorgen/FX275; no cost ceiling, funded reserve or entitlement is lowered.

Synthetic tests cover retained profit, partial/full entry, previously taxed distributions, losses with entries, per-operation rounding, safe-integer limits, currency and unknown evidence, non-executed accessors, and preservation of the binding gate/floors/flags/reviews. Hosted complete-suite39+Vercel verification is required on the PR head; no local tests or real financial actions are used. A green result is code verification only.
