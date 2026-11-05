import { recoveredFrom } from '@/lib/payment-recovery-report';
import { done, is } from './check';
const now=Date.parse('2026-11-05T04:00:00Z');
const row={id:'in_Greturn',currency:'usd',amount_paid:1234,attempt_count:2,paid_out_of_band:false,billing_reason:'subscription_cycle',status_transitions:{paid_at:now/1000-60},parent:{subscription_details:{metadata:{store:'gproof'}}}};
const handles=new Set(['gproof']);
for(const reason of ['automatic_pending_invoice_item_invoice','manual','quote_accept','subscription','subscription_create','subscription_cycle','subscription_threshold','subscription_update','upcoming']) {
 const got=recoveredFrom([{...row,billing_reason:reason}],handles,'usd',new Set([row.id]),now);
 const count=reason==='subscription_cycle'?1:0;
 is(`recognized reason ${reason} is not confused with cycle recovery`,[got.recovered,got.cents,got.afterEmail],[count,count*1234,count]);
}
const elsewhere=recoveredFrom([{...row,currency:'eur'}],handles,'usd',new Set([row.id]),now);
is('another currency is counted separately without combining monetary values',[elsewhere.recovered,elsewhere.cents,elsewhere.elsewhere],[0,0,1]);
is('explicit out-of-band payment remains excluded even with an email receipt',recoveredFrom([{...row,paid_out_of_band:true}],handles,'usd',new Set([row.id]),now).recovered,0);
done();
