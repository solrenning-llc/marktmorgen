import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {CURRENT_LLC_FIXED_COST_CEILINGS, LLC_FIXED_COST_ALLOCATION} from '../lib/llc-fixed-costs';

const read = () => readFileSync('docs/tx4-norway-voec-evidence.md', 'utf8');

test('TX4 Norway evidence distinguishes official VOEC guidance from conditional LLC applicability', () => {
  const text = read();
  for (const source of [
    'https://www.skatteetaten.no/en/business-and-organisation/vat-and-duties/vat/foreign/e-commerce-voec/',
    'https://www.skatteetaten.no/en/rates/vat-rates-for-remotely-deliverable-services-purchased-from-abroad/',
    'https://www.skatteetaten.no/rettskilder/type/handboker/merverdiavgiftshandboken/gjeldende/M-2/M-2-1/',
  ]) assert.ok(text.includes(source), source);
  assert.match(text, /05\/11\/2026/);
  assert.match(text, /fornecedores estrangeiros[\s\S]*serviços prestados remotamente/i);
  assert.match(text, /50\.000 coroas norueguesas[\s\S]*doze meses/i);
  assert.match(text, /marketplace[\s\S]*intermediário[\s\S]*análise/i);
  assert.match(text, /não comprova[\s\S]*LLC[\s\S]*obrigada/i);
});

test('TX4 Norway evidence preserves recurring returns, corrections, payment and currency work', () => {
  const text = read();
  for (const source of [
    'https://www.skatteetaten.no/en/business-and-organisation/vat-and-duties/vat/foreign/e-commerce-voec/submit-vat-return/',
    'https://www.skatteetaten.no/en/business-and-organisation/vat-and-duties/vat/foreign/e-commerce-voec/sending-goods-under-the-voec-scheme/',
    'https://www.skatteetaten.no/en/person/to-from-norway/from/conversion-foreign-currency-to-nok/',
  ]) assert.ok(text.includes(source), source);
  for (const fact of [
    'trimestre',
    'sem vendas',
    '20 de janeiro',
    '20 de abril',
    '20 de julho',
    '20 de outubro',
    'sábado ou domingo',
    'correção',
    'pagamento',
    'coroas norueguesas',
    'Norges Bank',
  ]) assert.ok(text.includes(fact), fact);
  assert.match(text, /retenção[\s\S]*permanece[\s\S]*por confirmar/i);
  assert.match(text, /não altera[\s\S]*código[\s\S]*cobrança/i);
});

test('TX4 Norway evidence never turns unpriced compliance into zero or a funded reserve', () => {
  const text = read();
  const line = CURRENT_LLC_FIXED_COST_CEILINGS.find(row => row.id === 'vat-oss-and-local-compliance');
  assert.ok(line);
  assert.equal(line.fullMonthlyUsdCents, null);
  assert.equal(line.fullAnnualUsdCents, null);
  assert.equal(line.reserveReviewed, false);
  assert.deepEqual(
    [LLC_FIXED_COST_ALLOCATION.marktmorgenBps, LLC_FIXED_COST_ALLOCATION.hazelsongBps],
    [10000, 0],
  );
  for (const fact of [
    'vat-oss-and-local-compliance',
    'desconhecido',
    'aplicabilidade',
    'preparação',
    'câmbio',
    'retenção',
    'revisão',
    'Depende do dono',
  ]) assert.ok(text.includes(fact), fact);
  assert.match(text, /nenhum cadastro[\s\S]*declaração[\s\S]*pagamento[\s\S]*contato/);
  assert.match(text, /100%[\s\S]*Marktmorgen/);
  assert.doesNotMatch(text, /(?:US\$|USD|NOK)\s*0(?:[,.]0+)?\b/i);
});
