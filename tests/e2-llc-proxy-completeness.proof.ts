import assert from 'node:assert/strict';
import { allocateEntireLlcFixedCosts, LLC_FIXED_COST_IDS, type FixedCostCeiling } from '../lib/llc-fixed-costs';

let failed = 0;
let checks = 0;
function check(name: string, run: () => void) {
  checks += 1;
  try { run(); console.log('PASS', name); }
  catch (error) { failed += 1; console.error('FAIL', name, error); }
}
const complete = (): FixedCostCeiling[] => LLC_FIXED_COST_IDS.map(id => ({
  id, fullMonthlyUsdCents: 1, fullAnnualUsdCents: 12,
  evidence: 'synthetic reviewed ceiling', reserveReviewed: true,
}));
check('ordinary complete costs remain known', () => {
  assert.equal(allocateEntireLlcFixedCosts(complete())?.monthlyUsdCents, LLC_FIXED_COST_IDS.length);
});
check('ordinary additional unknown cost refuses the total', () => {
  const rows = complete();
  rows.push({ ...rows[0], fullMonthlyUsdCents: null });
  assert.equal(allocateEntireLlcFixedCosts(rows), null);
});
check('array Proxy cannot hide the same additional unknown liability', () => {
  const rows = complete();
  const expectedLength = rows.length;
  rows.push({ ...rows[0], fullMonthlyUsdCents: null });
  const view = new Proxy(rows, {
    ownKeys(target) { return Reflect.ownKeys(target).filter(key => key !== String(expectedLength)); },
    getOwnPropertyDescriptor(target, key) {
      const field = Reflect.getOwnPropertyDescriptor(target, key);
      return key === 'length' && field ? { ...field, value: expectedLength } : field;
    },
  });
  assert.equal(allocateEntireLlcFixedCosts(rows), null);
  assert.equal(allocateEntireLlcFixedCosts(view), null);
});
check('ordinary extra unreviewed category refuses the total', () => {
  const rows = complete();
  Object.assign(rows[0], { unreviewedCostCents: null });
  assert.equal(allocateEntireLlcFixedCosts(rows), null);
});
check('record Proxy cannot hide the same unreviewed category', () => {
  const rows = complete();
  const record = Object.assign(rows[0], { unreviewedCostCents: null });
  assert.equal(allocateEntireLlcFixedCosts(rows), null);
  rows[0] = new Proxy(record, {
    ownKeys(target) { return Reflect.ownKeys(target).filter(key => key !== 'unreviewedCostCents'); },
  });
  assert.equal(allocateEntireLlcFixedCosts(rows), null);
});
console.log(`${checks} checks, ${failed} failures`);
process.exitCode = failed ? 1 : 0;
