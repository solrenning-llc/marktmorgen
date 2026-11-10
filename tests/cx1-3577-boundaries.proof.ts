/** Independent reader boundary/control proof; every provider answer is synthetic. */
import {readPaidInvoice,readPaidInvoices,MAX_LINE_PAGES,type StripeGet} from '@/lib/charge-check-read';
import {is,part,done} from './check';
const far=Number.MAX_SAFE_INTEGER,now=1790000000;
const row=(id:string)=>({id,amount:4000});
const page=(data:unknown[],more=false)=>({object:'list',data,has_more:more});
const invoice=(data:unknown[],more=false)=>({id:'in_cx1',status:'paid',lines:{...page(data,more),url:'/v1/invoices/in_cx1/lines'}});
let mockCalls=0;
function provider(answers:unknown[]):StripeGet{return async()=>{mockCalls++;if(!answers.length)throw Error('extra mock call');return answers.shift() as Record<string,unknown>;};}
async function main(){
 part('Duplicates anywhere in the pagination do not reach a decision');
 for(const [label,answers]of [
  ['third page repeats the first',[invoice([row('il_1')],true),page([row('il_2')],true),page([row('il_1')])]],
  ['duplicate within next page',[invoice([row('il_1')],true),page([row('il_2'),row('il_2')])]],
  ['unnamed later line',[invoice([row('il_1')],true),page([{amount:4000}])]],
  ['numeric later id',[invoice([row('il_1')],true),page([{id:42,amount:4000}])]],
 ] as const){
  const r=await readPaidInvoice({get:provider([...answers]),id:'in_cx1',until:far,maxCalls:6});
  is(label+': unknown','reason'in r?r.reason:'invoice','lines_unreadable');
  is(label+': remains retryable','final'in r?r.final:true,false);
 }
 part('Healthy terminal boundary and provider immutability');
 const frozen=Object.freeze(invoice([Object.freeze(row('il_1'))],true));
 const r=await readPaidInvoice({get:provider([frozen,page([row('il_2')])]),id:'in_cx1',until:far,maxCalls:6});
 is('unique next page is retained','invoice'in r?(r.invoice.lines as {data:unknown[]}).data.length:0,2);
 is('input first page was not mutated',frozen.lines.data.length,1);
 const before=mockCalls;
 const zero=await readPaidInvoice({get:provider([]),id:'in_cx1',until:far,maxCalls:0});
 is('no budget means no read',[zero,mockCalls-before],[{reason:'budget',final:false,calls:0},0]);
 part('Per-invoice unknown stays separate from confirmed good work');
 const bad=invoice([row('il_1'),row('il_1')]);
 const good={...invoice([row('il_3')]),id:'in_good'};
 const mix=await readPaidInvoices({get:provider([page([bad,good])]),now,until:far});
 is('bad id is available for retry',mix.unread,[{id:'in_cx1',reason:'lines_unreadable'}]);
 is('good invoice remains available',mix.invoices.map(i=>i.id),['in_good']);
 is('one list read only',mix.calls,1);
 part('The existing line-page cap still precedes an extra request');
 const answers=[invoice([row('il_0')],true),...Array.from({length:MAX_LINE_PAGES},(_,i)=>page([row('il_'+(i+1))],true))];
 const cap=await readPaidInvoice({get:provider(answers),id:'in_cx1',until:far,maxCalls:100});
 is('the existing cap is honored','reason'in cap?cap.reason:'invoice','too_many_lines');
 is('no request beyond the existing cap',cap.calls,MAX_LINE_PAGES+1);
 console.log('CX1 measured simulated get calls',mockCalls);
 done();
}
void main();
