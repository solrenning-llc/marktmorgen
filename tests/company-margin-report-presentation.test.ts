import { test } from "node:test";
import assert from "node:assert/strict";
import { companyMonthlyMarginPresentation } from "../lib/company-margin-report";
import {
  COMMERCIAL_PROFIT_SOURCES,
  commercialPlansMayOpen,
  type CommercialProfitMixInput,
  type ProfitSourceAmounts,
} from "../lib/commercial-margin";

const NOW = Date.UTC(2026, 10, 1);

function fixture(): CommercialProfitMixInput {
  return {
    basis: "reconciled_actual",
    interval: "month",
    period: "2026-10",
    currency: "USD",
    companyFixedCostsCents: 900,
    sources: Object.fromEntries(COMMERCIAL_PROFIT_SOURCES.map(source => [source, {
      revenueCents: 1_000,
      variableCostsCents: 100,
      allocatedFixedCostsCents: 100,
      taxesCents: 200,
      refundsCents: 50,
      reservesCents: 50,
      evidence: "SYNTHETIC ONLY; synthetic-person@example.com; synthetic-account-id",
    }])) as Record<typeof COMMERCIAL_PROFIT_SOURCES[number], ProfitSourceAmounts>,
  };
}

test("a complete reconciled month has one deterministic private owner presentation", () => {
  const input = fixture();
  const held = { month: "2026-10", count: 2, peak: 5, privateEmail: "held-person@example.com" };
  const presentation = companyMonthlyMarginPresentation(input, NOW, held);
  assert.deepEqual(presentation, {
    schema: 1,
    reportId: "company-margin:2026-10:v1",
    month: "2026-10",
    currency: "USD",
    basis: "reconciled_actual",
    subject: "Margem da empresa Marktmorgen — outubro de 2026",
    text: [
      "Margem da empresa Marktmorgen — outubro de 2026",
      "ID do relatório: company-margin:2026-10:v1",
      "Base: dados reais reconciliados do mês-calendário UTC completo.",
      "Receita: US$ 90,00",
      "Custos variáveis: US$ 9,00",
      "Custos fixos: US$ 9,00",
      "Impostos: US$ 18,00",
      "Reembolsos: US$ 4,50",
      "Reservas: US$ 4,50",
      "Lucro líquido: US$ 45,00",
      "Margem líquida: 50,00%",
      "Meta: 60,00% — não atingida.",
      "Lojas retidas para recuperação: 2 no fim do mês; pico mensal 5.",
      "Somente informativo: este relatório não abre vendas nem altera preço, limite, comissão, sinalizador ou trava.",
    ].join("\n"),
  });
  assert.equal(Object.isFrozen(presentation), true);
  assert.deepEqual(companyMonthlyMarginPresentation(input, NOW, held), presentation);
  assert.doesNotMatch(JSON.stringify(presentation), /example\.com|synthetic-account|evidence|privateEmail|SYNTHETIC/);
  assert.doesNotMatch(presentation!.text, /Report ID|Basis:|Revenue:|Variable costs|Fixed costs|Taxes:|Refunds:|Net profit|Net margin|Target:|Stores held|Informational only/);
  assert.match(companyMonthlyMarginPresentation(input, NOW)!.text, /Lojas retidas para recuperação: desconhecido \(não zero\)\./);
});

test("losses, zero revenue and the exact target remain truthful presentation states", () => {
  const lossInput = fixture();
  for (const source of COMMERCIAL_PROFIT_SOURCES) lossInput.sources[source]!.revenueCents = 0;
  const loss = companyMonthlyMarginPresentation(lossInput, NOW);
  assert.match(loss!.text, /Receita: US\$ 0,00/);
  assert.match(loss!.text, /Lucro líquido: -US\$ 45,00/);
  assert.match(loss!.text, /Margem líquida: não mensurável porque a receita foi US\$ 0,00\./);
  assert.match(loss!.text, /Meta: 60,00% — não mensurável porque a receita foi US\$ 0,00\./);
  assert.doesNotMatch(loss!.text, /atingida\./);

  const exactTarget = fixture();
  for (const source of COMMERCIAL_PROFIT_SOURCES) exactTarget.sources[source]!.revenueCents = 1_250;
  assert.match(companyMonthlyMarginPresentation(exactTarget, NOW)!.text, /Margem líquida: 60,00%\nMeta: 60,00% — atingida\./);
  exactTarget.sources.training!.reservesCents = 51;
  assert.match(companyMonthlyMarginPresentation(exactTarget, NOW)!.text, /Margem líquida: 59,99%\nMeta: 60,00% — não atingida\./);
  assert.equal(commercialPlansMayOpen(true), false);
});

test("unknown, malformed or uninspectable accounting never gets a presentation", () => {
  assert.equal(companyMonthlyMarginPresentation(null, NOW), null);
  const missing = fixture(); missing.sources.training!.taxesCents = null;
  assert.equal(companyMonthlyMarginPresentation(missing, NOW), null);
  const wrongMonth = fixture(); wrongMonth.period = "2026-09";
  assert.equal(companyMonthlyMarginPresentation(wrongMonth, NOW), null);
  assert.equal(companyMonthlyMarginPresentation(fixture(), Number.NaN), null);

  let reads = 0;
  const accessor = fixture();
  Object.defineProperty(accessor.sources.training, "revenueCents", {
    enumerable: true,
    get() { reads++; throw new Error("getter"); },
  });
  assert.equal(companyMonthlyMarginPresentation(accessor, NOW), null);
  assert.equal(reads, 0);

  const revoked = Proxy.revocable(fixture(), {}); revoked.revoke();
  assert.equal(companyMonthlyMarginPresentation(revoked.proxy, NOW), null);

  let heldReads = 0;
  const unreadableHeld = { month: "2026-10", peak: 5, get count() { heldReads++; return 2; } };
  assert.match(companyMonthlyMarginPresentation(fixture(), NOW, unreadableHeld)!.text, /retidas para recuperação: desconhecido \(não zero\)/);
  assert.equal(heldReads, 0);
});

test("the month and idempotency key come only from the complete UTC period", () => {
  const october = companyMonthlyMarginPresentation(fixture(), NOW)!;
  const novemberInput = fixture(); novemberInput.period = "2026-11";
  const november = companyMonthlyMarginPresentation(novemberInput, Date.UTC(2026, 11, 1))!;
  assert.equal(october.reportId, "company-margin:2026-10:v1");
  assert.equal(november.reportId, "company-margin:2026-11:v1");
  assert.equal(november.subject, "Margem da empresa Marktmorgen — novembro de 2026");
  assert.notEqual(october.reportId, november.reportId);
});
