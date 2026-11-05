import assert from "node:assert/strict";
import test from "node:test";
import { companyMonthlyMarginPresentation } from "../lib/company-margin-report";
import { COMMERCIAL_PROFIT_SOURCES, type CommercialProfitMixInput, type ProfitSourceAmounts } from "../lib/commercial-margin";

const NOW = Date.UTC(2026, 10, 1);
const month = "2026-10";
function fixture(): CommercialProfitMixInput {
  return {
    basis: "reconciled_actual", interval: "month", period: month, currency: "USD", companyFixedCostsCents: 900,
    sources: Object.fromEntries(COMMERCIAL_PROFIT_SOURCES.map(source => [source, {
      revenueCents: 1000, variableCostsCents: 100, allocatedFixedCostsCents: 100,
      taxesCents: 200, refundsCents: 50, reservesCents: 50, evidence: "SYNTHETIC ONLY",
    }])) as Record<typeof COMMERCIAL_PROFIT_SOURCES[number], ProfitSourceAmounts>,
  };
}
const row = { month, queued: 0, done: 0, gaveUp: 0, waitingNow: 0, keptNow: 0 };
const packet = { schema: 1, month, storeForget: row, keptStarTimes: 0 };
const serialized = JSON.stringify(packet);
const text = (value: unknown) => companyMonthlyMarginPresentation(fixture(), NOW, null, value as string | null)!.text;
function unknown(value: unknown) {
  const result = text(value);
  assert.match(result, /não foi possível ler a fila neste mês; o estado é desconhecido/);
  assert.match(result, /não foi possível ler a contagem deste mês; o estado é desconhecido/);
}

test("D2: duplicate root member cannot replace an unknown observation with zero", () => {
  unknown(serialized.replace('"keptStarTimes":0', '"keptStarTimes":null,"keptStarTimes":0'));
});
test("D2: duplicate nested member cannot conceal a positive retained-data count", () => {
  unknown(serialized.replace('"keptNow":0', '"keptNow":17,"keptNow":0'));
});
test("D2: escaped duplicate key cannot bypass canonicalization", () => {
  unknown(serialized.replace('"keptStarTimes":0', '"keptStarTimes":null,"keptStarTime\\u0073":0'));
});
test("D2: invalid star count discards the whole packet, not just the star row", () => {
  unknown(JSON.stringify({ ...packet, keptStarTimes: Number.MAX_SAFE_INTEGER + 1 }));
  unknown(JSON.stringify({ ...packet, keptStarTimes: -1 }));
  unknown(JSON.stringify({ ...packet, keptStarTimes: "0" }));
});
test("D2: partial, additional and mismatched nested evidence remains unknown", () => {
  unknown(JSON.stringify({ ...packet, storeForget: { ...row, month: "2026-09" } }));
  unknown(JSON.stringify({ ...packet, storeForget: { ...row, privateField: "SYNTHETIC-SECRET" } }));
  const partial: Partial<typeof row> = { ...row }; delete partial.done;
  unknown(JSON.stringify({ ...packet, storeForget: partial }));
});
test("D2: arrays, encoded strings and oversized source are not records", () => {
  unknown(JSON.stringify([packet])); unknown(JSON.stringify(serialized)); unknown(" ".repeat(4097));
});
test("D2: revoked and coercible objects never run user code", () => {
  const proxy = Proxy.revocable({}, {}); proxy.revoke(); unknown(proxy.proxy);
  let calls = 0;
  unknown({ toString() { calls++; return serialized; }, [Symbol.toPrimitive]() { calls++; return serialized; } });
  assert.equal(calls, 0);
});
test("D2: all-zero evidence and omitted source preserve the old presentation", () => {
  assert.equal(text(serialized), text(undefined));
  assert.doesNotMatch(text(serialized), /Apagamento de webhooks|Sessões travadas mantidas/);
});
test("D2: explicit missing evidence stays visible, including a nullable valid source", () => {
  unknown(null); unknown(JSON.stringify({ ...packet, storeForget: null, keptStarTimes: null }));
});
test("D2: nonzero observations retain both warnings and never copy unrelated text", () => {
  const result = text(JSON.stringify({ ...packet, storeForget: { ...row, keptNow: 2 }, keptStarTimes: 3 }));
  assert.match(result, /2 com dados ainda guardados/);
  assert.match(result, /em 3 leituras ilegíveis/);
  assert.doesNotMatch(result, /SYNTHETIC ONLY/);
});
test("D2: operations never authenticate absent or incomplete financial accounting", () => {
  assert.equal(companyMonthlyMarginPresentation(null, NOW, null, serialized), null);
  const data = fixture(); Reflect.deleteProperty(data.sources, COMMERCIAL_PROFIT_SOURCES[0]);
  assert.equal(companyMonthlyMarginPresentation(data, NOW, null, serialized), null);
});
test("D2: presentation performs no fetch and freezes its output", () => {
  const previous = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("network forbidden in this proof"); };
  try {
    const result = companyMonthlyMarginPresentation(fixture(), NOW, null, serialized);
    assert.ok(result); assert.ok(Object.isFrozen(result)); assert.equal(requests, 0);
  } finally { globalThis.fetch = previous; }
});
