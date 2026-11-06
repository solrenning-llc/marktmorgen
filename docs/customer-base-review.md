# Minimum customer base in commercial review

> **MR vigente — dono27/10/2026 07h42 Fortaleza,464[MR1]:** [REGRA DE MARGEM](../AGENTS.md#mr--regra-de-margem-vigente-27-de-outubro-de-2026) substitui todos os pisos históricos de60% neste documento e suas referências. Exigir lucro líquido por unidade maior que zero no pior caso com a folga existente do spend floor,100% direitos mensal/anual e complementos; empresa sem prejuízo a partir de base mínima calculada com100%FX275 e exposições.60% é meta real mensal da empresa. Preservados ISS5%, leitura mais onerosa, recebimento mais caro, reservas/tetos/gates; desconhecido reprova, não é zero. Texto/citações/números antigos abaixo são histórico, não recalculados nem certificados. Código/relatório/regeneração pertencem a MR2; resultados atuais a MR3. Sem mudança de preços/limites/comissão/vendas.


A profitable individual plan does not automatically fund company overhead. The release review now requires explicit worst-month fixed-cost and fixed-tax ceilings, evidence, and a reviewed number of paying customers. Missing values are not zero. The actual commercial review remains null and paid plans stay closed.

For each of the six locked plan/cycle cases, let P be subscription revenue for the paid period, N the worst-case net amount after all unit costs and taxes, and m the number of months (1 or 12). Monthly surplus above the owner's 60% floor is H = (N - 0.60 P) / m. No creator sales commission is required for this calculation. The conservative minimum for any plan mix is max over all six cases of ceil(F / H), where F includes the reviewed worst-month fixed costs and fixed taxes without assuming any tax deduction. BigInt arithmetic keeps the annual division exact until the final whole-customer ceiling.

If any unit fails 60%, a larger company cannot repair it. If a unit has exactly 60% and F is positive, there is no finite minimum for an arbitrary plan mix. A cost ceiling or tax review missing from any unit blocks the calculation. Annual scenarios must cover twelve months with every entitlement fully used each month; dividing an annual invoice into monthly revenue must not reduce the associated rights or expenses.

Fixed costs include infrastructure subscriptions, registered agent, compliance, accounting in both jurisdictions, compensation, tools, support overhead and any unallocated liability reserve. A zero in the test fixture is hypothetical, never an approved company budget. A reviewer must account for all applicable US and Brazilian taxes and any already-issued referral obligations. Unit cost fields that already contain allocated fixed expenses must not be mistaken for proof that all company expenses were covered.

This is an additional release-review requirement. It does not replace the existing individual-scenario checks, automatically reclassify trials/refunds as acquisition budgets or approve those legacy scenarios. The older isolated-fixed-cost requirement remains restrictive and still needs reconciliation with the owner's authorization for a separately funded acquisition budget and a minimum operating base. This draft does not silently remove that blocker.

The reviewed customer count is a snapshot. There is no live collection/retention monitor, automatic funding migration, provider account cap or solvency guarantee in this change. A lower count or higher cost requires a new review; runtime response to customer loss remains work to implement. Cash reserves for incorporation, annual invoices, refunds and trial acquisition require separate provisioning. Revenue recognition and worst-month expense recognition must be reviewed; do not divide an annual cash payment by twelve without a funded accrual/reserve policy.

No prices, commission rates, plan count, quotas, billing collection or launch switches change. A change to the minimum-base rules invalidates an older price-and-rights review.

Validation: 12 new cases cover exact cent boundaries, annual fractions, worst mixtures, missing taxes, impossible bases, invalid inputs and integration with commercialMarginReady. The 97 existing customer-margin checks and 116 commercial-snapshot checks also pass; changed modules/tests pass strict TypeScript with the repository's ES2017 target. No full application build or live billing test was run.


## FX275 — full company costs,22 October2026

Owner22/10/2026 05:10Fortaleza: "esqueça Hazelsong". Every full LLC fixed cost and fixed tax is100% Marktmorgen; no Hazelsong allocation reduces F. lib/llc-fixed-costs.ts sums full reviewed monthly/annual ceilings and rejects any missing required line. Current ceilings remain unknown, current commercial review null, so minimum paying base is not established and consolidated margin not approved. Most-tax individual failures cannot be repaired by more customers. Native prices, taxes, FX and reserve gaps: [dated evidence](llc-fixed-costs-2026-10-22.md). No commercial-review/gate code changed. Prior validation paragraphs are historical, not verification of this new head.


## FX1 — inventory bound to actual commercial admission,30October2026

The earlier report-only status is superseded narrowly by [the full LLC gate](llc-cost-gate.md): commercialMarginReady now consumes allocateEntireLlcFixedCosts and refuses incomplete current records. Its fixed-cost plus fixed-tax aggregate must include the complete monthly LLC total before separately funded exposure is added, without adding those costs twice. Both monthly and annual ceilings and each line's reserve/evidence remain mandatory. The new deployment-artifact-retention category and all existing categories remain unknown in production.

Schema24binds inventory/allocation/ceilings to the review snapshot. No actual ceiling, review, reserve, customer count, provider cap or tax classification becomes approved. Full six-case cost/base and cash/funding work still remains; all previous history above stays preserved.


### Annual inclusion follow-up
The actual gate additionally compares twelve fixed monthly budgets with the complete annual LLC ceiling (snapshot schema25). A known annual amount cannot disappear behind a smaller monthly amount or integer division; one missing cent rejects. This does not establish worst-month recognition, invoice timing, a funded reserve or permission to amortize. All actual ceilings/reviews remain absent/unknown and plans stay closed. Historical schema24 text above records the prior integration.
