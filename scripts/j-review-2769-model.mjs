import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { testAliases, testEnvironment } from '../tests/test-config.mjs';

// Independent review: change rates only in esbuild's in-memory input.
// No source constant, account, provider setting, or commercial policy is edited.
Object.assign(process.env, testEnvironment(process.env));
const root = resolve('.');
const work = mkdtempSync(join(tmpdir(), 'j-2769-'));
const require = createRequire(import.meta.url);
const rates = ['UPSTASH_MICRO_USD_PER_MILLION_COMMANDS', 'UPSTASH_MICRO_USD_PER_GB_TRANSFER', 'UPSTASH_MICRO_USD_PER_GB_MONTH'];
const tiers = ['creator', 'pro', 'scale'];
const doc = readFileSync(join(root, 'docs/upstash-fixed-plan-decision-2026-11-06.md'), 'utf8');
let checks = 0;
let failures = 0;
const check = (condition, message) => { checks++; if (!condition) { failures++; console.error(`FAIL ${message}`); } };
async function model(zero = []) {
  const outfile = join(work, `model-${zero.join('-') || 'baseline'}.cjs`);
  await build({
    stdin: { contents: `import {worstCost,worstLines} from './tests/plan-cost-model'; import {DATA_ROOM_BYTES} from './lib/store-data-rules'; import {reservePeakBytes} from './tests/store-data-registry'; export const rows=['creator','pro','scale'].map(tier=>({cost:worstCost(tier),lines:worstLines(tier),peak:(DATA_ROOM_BYTES[tier]+reservePeakBytes(tier))/1e9}));`, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile,
    alias: testAliases('plan-margin.test.ts', root, join(root, 'tests')),
    plugins: [{ name: 'review-rates', setup(b) { b.onLoad({filter:/[\\/]lib[\\/]spend-cost-table\.ts$/}, ({path}) => {
      let contents = readFileSync(path, 'utf8');
      for (const name of zero) {
        const re = new RegExp(`(export const ${name} = )([0-9_]+)(;)`, 'g');
        check([...contents.matchAll(re)].length === 1, `one canonical ${name}`);
        contents = contents.replace(re, '$10$3');
      }
      return { contents, loader: 'ts' };
    }); }}], logLevel:'error',
  });
  return require(outfile).rows;
}
try {
  const baseline = await model();
  const components = [];
  for (const rate of rates) {
    const excluded = await model([rate]);
    components.push(baseline.map((v, i) => v.cost - excluded[i].cost));
  }
  const excludedAll = await model(rates);
  const variants = await Promise.all(rates.map(rate=>model([rate])));
  for (const [i,tier] of tiers.entries()) for (const [line,value] of Object.entries(baseline[i].lines)) { const separate=variants.reduce((sum,rows)=>sum+value-rows[i].lines[line],0);const combined=value-excludedAll[i].lines[line];if(Math.abs(separate-combined)>1e-8) console.log({tier,line,value,separate,combined,variants:variants.map(rows=>rows[i].lines[line]),without:excludedAll[i].lines[line]}); }
  for (let i = 0; i < tiers.length; i++) {
    const values = components.map(row => row[i]);
    const total = values.reduce((a,b) => a+b, 0);

    check(Math.abs(total - (baseline[i].cost - excludedAll[i].cost)) < 1e-9, `${tiers[i]} independent sensitivities sum to combined Redis sensitivity`);
    for (const multiplier of [1,12]) {
      for (const value of [...values, total]) check(doc.includes(`$${(value * multiplier).toFixed(6)}`), `${tiers[i]} ${multiplier} months ${value}`);
    }
    const peak = baseline[i].peak;
    check(doc.includes(peak.toFixed(6)), `${tiers[i]} logical peak ${peak}`);
    check(doc.includes((peak * 1.7).toFixed(6)), `${tiers[i]} conditional conversion`);
    const conditionalTier = [0.25,1,5,10,50,100,500].find(size => size >= peak*1.7);
    check(conditionalTier === [1,5,5][i], `${tiers[i]} smallest conditional tier`);
    check(total < [20,100,100][i], `${tiers[i]} isolated PAYG lower`);
    console.log(JSON.stringify({tier:tiers[i],commands:values[0],transfer:values[1],storage:values[2],total,annual:total*12,peak,conditionalTier}));
  }
  console.log(`${checks} independent model checks: ${checks-failures} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
} finally { rmSync(work, {recursive:true,force:true}); }
