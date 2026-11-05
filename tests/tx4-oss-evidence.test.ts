import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {CURRENT_LLC_FIXED_COST_CEILINGS, LLC_FIXED_COST_ALLOCATION} from '../lib/llc-fixed-costs';

const read = () => readFileSync('docs/tx4-oss-evidence.md','utf8');

test('TX4 OSS evidence distinguishes official guidance, legal access gaps and conditional applicability',()=>{
 const text=read();
 for(const source of [
  'https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/register-oss_en',
  'https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/declare-and-pay-oss_en',
  'https://www.revenue.ie/en/vat/vat-ecommerce/non-union-scheme/index.aspx',
  'https://www.revenue.ie/en/tax-professionals/tdm/value-added-tax/part10-special-schemes/vat-ecommerce-rules/non-union-scheme-one-stop-shop-oss.pdf',
 ])assert.ok(text.includes(source),source);
 assert.match(text,/04\/11\/2026/);
 assert.match(text,/junho de 2025/i);
 assert.match(text,/19 de junho de 2026/i);
 assert.match(text,/EUR-Lex.*anti-bot/i);
 assert.match(text,/não comprova.*enquadramento.*LLC/i);
 assert.match(text,/opcional.*não dispensa.*IVA/i);
 assert.match(text,/não União.*Union OSS.*IOSS/s);
});

test('TX4 OSS evidence preserves recurring returns, deadlines, currency and long-tail record costs',()=>{
 const text=read();
 for(const fact of ['trimestre civil','sem movimento','30 de abril','31 de julho','31 de outubro','31 de janeiro','fim de semana','dez anos','fim do ano','Banco Central Europeu','último dia','pagamento','comprovante'])assert.ok(text.includes(fact),fact);
 assert.match(text,/não altera.*retenção.*código/i);
 assert.match(text,/não demonstra.*cobrança.*implementad/i);
});

test('TX4 OSS evidence never turns unpriced compliance into a zero fixed cost or a funded reserve',()=>{
 const text=read();
 const line=CURRENT_LLC_FIXED_COST_CEILINGS.find(row=>row.id==='vat-oss-and-local-compliance');
 assert.ok(line);assert.equal(line.fullMonthlyUsdCents,null);assert.equal(line.fullAnnualUsdCents,null);assert.equal(line.reserveReviewed,false);
 assert.deepEqual([LLC_FIXED_COST_ALLOCATION.marktmorgenBps,LLC_FIXED_COST_ALLOCATION.hazelsongBps],[10000,0]);
 for(const fact of ['vat-oss-and-local-compliance','desconhecido','orçamento','câmbio','armazenamento','após o encerramento','Depende do dono'])assert.ok(text.includes(fact),fact);
 assert.match(text,/nenhum cadastro.*submissão.*pagamento.*contato/s);
 assert.match(text,/100%.*Marktmorgen/);
 assert.doesNotMatch(text,/(?:US\$|USD|€|EUR)\s*0(?:[,.]0+)?\b/i);
});
