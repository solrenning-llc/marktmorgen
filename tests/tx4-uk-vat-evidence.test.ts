import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {CURRENT_LLC_FIXED_COST_CEILINGS,LLC_FIXED_COST_ALLOCATION} from '../lib/llc-fixed-costs';
const read=()=>readFileSync('docs/tx4-uk-vat-evidence.md','utf8');
test('TX4 UK VAT evidence identifies official dated sources and keeps applicability conditional',()=>{
 const text=read();
 for(const url of ['https://www.gov.uk/submit-vat-return','https://www.gov.uk/charge-reclaim-record-vat/keeping-vat-records','https://www.gov.uk/guidance/record-keeping-for-vat-notice-70021','https://www.gov.uk/register-for-vat'])assert.ok(text.includes(url),url);
 assert.match(text,/04\/11\/2026/);
 assert.match(text,/não comprova.*enquadramento.*LLC/);
 assert.match(text,/não transforma.*limite doméstico/);
 assert.match(text,/não substitui.*revisão jurídica/);
});
test('TX4 UK VAT evidence preserves qualified deadlines, digital records and post-deregistration retention',()=>{
 const text=read();
 for(const fact of ['normalmente','três meses','sem imposto','um mês civil e sete dias','fim de semana','conta fiscal','pelo menos seis anos','dez anos','Making Tax Digital','isenção','vínculo digital','cancelamento da inscrição'])assert.ok(text.includes(fact),fact);
 assert.match(text,/não altera.*retenção.*código/);
});
test('TX4 UK VAT evidence keeps the complete cost and reserve unknown with entire LLC allocation',()=>{
 const text=read();
 const row=CURRENT_LLC_FIXED_COST_CEILINGS.find(x=>x.id==='vat-oss-and-local-compliance');
 assert.ok(row);assert.equal(row.fullMonthlyUsdCents,null);assert.equal(row.fullAnnualUsdCents,null);assert.equal(row.reserveReviewed,false);
 assert.deepEqual([LLC_FIXED_COST_ALLOCATION.marktmorgenBps,LLC_FIXED_COST_ALLOCATION.hazelsongBps],[10000,0]);
 for(const fact of ['vat-oss-and-local-compliance','desconhecido','orçamento','câmbio','após o encerramento','100% ao Marktmorgen','nenhum cadastro, submissão, pagamento ou contato'])assert.ok(text.includes(fact),fact);
 assert.doesNotMatch(text,/(?:US\$|USD|£|GBP)\s*0(?:[,.]0+)?\b/i);
});
