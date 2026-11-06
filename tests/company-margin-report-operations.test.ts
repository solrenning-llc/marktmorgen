import { test } from "node:test";
import assert from "node:assert/strict";
import { companyMonthlyMarginPresentation } from "../lib/company-margin-report";
import {
  COMMERCIAL_PROFIT_SOURCES,
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
      evidence: "SYNTHETIC ONLY; no actual invoice",
    }])) as Record<typeof COMMERCIAL_PROFIT_SOURCES[number], ProfitSourceAmounts>,
  };
}

const complete = JSON.stringify({
  schema: 1,
  month: "2026-10",
  storeForget: { month: "2026-10", queued: 2, done: 1, gaveUp: 1, waitingNow: 1, keptNow: 1 },
  keptStarTimes: 3,
});

test("the private presentation names both completed operational exception observations", () => {
  const text = companyMonthlyMarginPresentation(fixture(), NOW, null, complete)!.text;
  assert.match(text, /Apagamento de webhooks e chaves de lojas excluídas em 2026-10: 2 entraram na fila/);
  assert.match(text, /1 com dados ainda guardados depois de todas as tentativas/);
  assert.match(text, /Sessões travadas mantidas em 2026-10: em 3 leituras ilegíveis/);
  assert.doesNotMatch(text, /não foi possível ler a fila|não foi possível ler a contagem/);
});

test("missing, malformed, noncanonical or wrong-month observations stay explicitly unknown", () => {
  const cases: unknown[] = [
    null,
    "",
    "not-json",
    JSON.stringify({ schema: 1, month: "2026-09", storeForget: null, keptStarTimes: null }),
    JSON.stringify({ schema: 1, month: "2026-10", storeForget: null, keptStarTimes: null, extra: 0 }),
    JSON.stringify({ schema: 1, month: "2026-10", storeForget: { month: "2026-10", queued: -1, done: 0, gaveUp: 0, waitingNow: 0, keptNow: 0 }, keptStarTimes: 0 }),
    ` ${JSON.stringify({ schema: 1, month: "2026-10", storeForget: null, keptStarTimes: null })}`,
    "x".repeat(4_097),
  ];
  for (const observation of cases) {
    const text = companyMonthlyMarginPresentation(fixture(), NOW, null, observation as string | null)!.text;
    assert.match(text, /Apagamento de webhooks e chaves de lojas excluídas: não foi possível ler a fila neste mês; o estado é desconhecido\./);
    assert.match(text, /Sessões travadas mantidas: não foi possível ler a contagem deste mês; o estado é desconhecido\./);
  }
});

test("known zero is distinct from unknown and supplied text or executable values never leak or run", () => {
  const zero = JSON.stringify({
    schema: 1,
    month: "2026-10",
    storeForget: { month: "2026-10", queued: 0, done: 0, gaveUp: 0, waitingNow: 0, keptNow: 0 },
    keptStarTimes: 0,
  });
  const clean = companyMonthlyMarginPresentation(fixture(), NOW, null, zero)!.text;
  assert.doesNotMatch(clean, /não foi possível ler|Apagamento de webhooks|Sessões travadas mantidas/);

  let reads = 0;
  const executable = new Proxy({ value: "synthetic-secret" }, {
    get() { reads++; throw new Error("proxy must not execute"); },
  });
  const text = companyMonthlyMarginPresentation(fixture(), NOW, null, executable as unknown as string)!.text;
  assert.equal(reads, 0);
  assert.doesNotMatch(text, /synthetic-secret/);
  assert.match(text, /estado é desconhecido/);
});
