import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileCompanyMonthlyEvidence } from "../lib/company-margin-reconciliation";
import { COMMERCIAL_PROFIT_SOURCES, commercialProfitMix, type CommercialProfitSource } from "../lib/commercial-margin";

const NOW = Date.UTC(2026, 10, 1);
function fixture() {
  return { period: "2026-10", currency: "USD", companyFixedCostsCents: 900,
    sources: Object.fromEntries(COMMERCIAL_PROFIT_SOURCES.map(source => [source, {
      period: "2026-10", currency: "USD", complete: true,
      amounts: { revenueCents: 1000, variableCostsCents: 100, allocatedFixedCostsCents: 100,
        taxesCents: 200, refundsCents: 50, reservesCents: 50, evidence: "SYNTHETIC ONLY; complete source reconciliation" },
    }])) as unknown as Record<CommercialProfitSource, { period: string; currency: string; complete: boolean; amounts: Record<string, unknown> }>,
  };
}

test("all nine complete source packets produce a detached same-month accounting input", () => {
  const input = fixture();
  const result = reconcileCompanyMonthlyEvidence(input, NOW)!;
  assert.equal(result.basis, "reconciled_actual");
  assert.equal(result.interval, "month");
  assert.equal(result.period, "2026-10");
  assert.deepEqual(Object.keys(result.sources).sort(), [...COMMERCIAL_PROFIT_SOURCES].sort());
  assert.equal(commercialProfitMix(result).totalNetProfitCents, 4500);
  input.sources.training.amounts.taxesCents = 0;
  assert.equal(result.sources.training!.taxesCents, 200);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.sources), true);
  assert.equal(Object.isFrozen(result.sources.training), true);
});

test("missing, partial, differently denominated and differently dated sources never reconcile", () => {
  for (const source of COMMERCIAL_PROFIT_SOURCES) {
    const missing = fixture(); delete (missing.sources as Partial<typeof missing.sources>)[source];
    assert.equal(reconcileCompanyMonthlyEvidence(missing, NOW), null);
    for (const patch of [{ complete: false }, { period: "2026-09" }, { currency: "EUR" }, { amounts: null }]) {
      const input = fixture(); Object.assign(input.sources[source], patch);
      assert.equal(reconcileCompanyMonthlyEvidence(input, NOW), null);
    }
    for (const key of ["revenueCents", "variableCostsCents", "allocatedFixedCostsCents", "taxesCents", "refundsCents", "reservesCents", "evidence"]) {
      const input = fixture(); input.sources[source].amounts[key] = null;
      assert.equal(reconcileCompanyMonthlyEvidence(input, NOW), null);
    }
  }
});

test("unmodelled root, packet and amount fields cannot conceal unpriced costs", () => {
  assert.equal(reconcileCompanyMonthlyEvidence(Object.assign(fixture(), { unpriced: null }), NOW), null);
  const packet = fixture(); Object.assign(packet.sources.training, { unpriced: null });
  assert.equal(reconcileCompanyMonthlyEvidence(packet, NOW), null);
  for (const value of [null, 0, 100_000]) {
    const input = fixture(); input.sources.training.amounts.unpriced = value;
    assert.equal(reconcileCompanyMonthlyEvidence(input, NOW), null);
  }
});

test("proxies, revoked proxies and inherited packets are unknown without executing getters", () => {
  for (const level of ["root", "sources", "packet", "amounts"]) {
    const input = fixture();
    const value = level === "root" ? input : level === "sources" ? input.sources : level === "packet" ? input.sources.training : input.sources.training.amounts;
    const wrapped = Proxy.revocable(value, {});
    if (level === "sources") input.sources = wrapped.proxy as typeof input.sources;
    if (level === "packet") input.sources.training = wrapped.proxy as typeof input.sources.training;
    if (level === "amounts") input.sources.training.amounts = wrapped.proxy as typeof input.sources.training.amounts;
    const supplied = level === "root" ? wrapped.proxy : input;
    assert.equal(reconcileCompanyMonthlyEvidence(supplied, NOW), null);
    wrapped.revoke(); assert.equal(reconcileCompanyMonthlyEvidence(supplied, NOW), null);
  }
  const inherited = fixture(); inherited.sources.training = Object.create(inherited.sources.training);
  assert.equal(reconcileCompanyMonthlyEvidence(inherited, NOW), null);
  let reads = 0;
  for (const level of ["packet", "amounts"]) {
    const input = fixture();
    Object.defineProperty(level === "packet" ? input.sources.training : input.sources.training.amounts,
      level === "packet" ? "complete" : "revenueCents", { enumerable: true, get() { reads++; return true; } });
    assert.equal(reconcileCompanyMonthlyEvidence(input, NOW), null);
  }
  assert.equal(reads, 0);
});

test("self-detaching packet and amount proxies cannot turn incomplete evidence into complete", () => {
  for (const level of ["packet", "amounts"]) {
    const input = fixture(), original = input.sources.training;
    const amounts = original.amounts;
    const proxy = new Proxy(level === "packet" ? original : amounts, {
      ownKeys(target) {
        if (level === "packet") input.sources.training = { ...original };
        else original.amounts = { ...amounts };
        return Reflect.ownKeys(target);
      },
    });
    if (level === "packet") input.sources.training = proxy as typeof original;
    else original.amounts = proxy;
    assert.equal(reconcileCompanyMonthlyEvidence(input, NOW), null);
  }
});

test("an envelope Proxy cannot arrange a getter to run during native clone inspection", () => {
  const input = fixture();
  let reads = 0;
  input.sources.training = new Proxy(input.sources.training, {
    ownKeys(target) {
      Object.defineProperty(input.sources.plan_subscriptions, "complete", {
        enumerable: true, configurable: true, get() { reads++; return true; },
      });
      return Reflect.ownKeys(target);
    },
  });
  assert.equal(reconcileCompanyMonthlyEvidence(input, NOW), null);
  assert.equal(reads, 0);
});

test("only the last complete UTC month and safe fully allocated amounts reconcile", () => {
  for (const now of [NaN, -1, Infinity, 0.5]) assert.equal(reconcileCompanyMonthlyEvidence(fixture(), now), null);
  for (const period of ["", "2026-09", "2026-11", "2026-1", "2026-10-01"]) {
    const input = fixture(); input.period = period;
    assert.equal(reconcileCompanyMonthlyEvidence(input, NOW), null);
  }
  for (const value of [null, "900", 901, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const input = fixture(); Object.assign(input, { companyFixedCostsCents: value });
    assert.equal(reconcileCompanyMonthlyEvidence(input, NOW), null);
  }
  assert.equal(reconcileCompanyMonthlyEvidence(null, NOW), null);
});

test("evidenced zero and known losses remain data, never sales permission", () => {
  const input = fixture();
  for (const source of COMMERCIAL_PROFIT_SOURCES) input.sources[source].amounts.revenueCents = 0;
  assert.equal(commercialProfitMix(reconcileCompanyMonthlyEvidence(input, NOW)).totalNetProfitCents, -4500);
  for (const source of COMMERCIAL_PROFIT_SOURCES) {
    for (const key of ["variableCostsCents", "allocatedFixedCostsCents", "taxesCents", "refundsCents", "reservesCents"]) input.sources[source].amounts[key] = 0;
    input.sources[source].amounts = Object.assign(Object.create(null), input.sources[source].amounts);
  }
  input.companyFixedCostsCents = 0;
  assert.equal(commercialProfitMix(reconcileCompanyMonthlyEvidence(input, NOW)).totalNetProfitCents, 0);
});
