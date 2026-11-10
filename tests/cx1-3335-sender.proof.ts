/** Sender identity is optional for old records, exact and bounded for new ones. */
import {readPendingPayoutBatches} from '@/lib/pending-payouts';
import {autoPayEmail} from '@/lib/affiliate-payday';
import {is,done,part} from './check';
const batch={at:1,currency:'usd',lines:[{a:'aaaaaaaaaaaa',c:3000}]};
const read=(s:unknown)=>readPendingPayoutBatches([['BATCH1',JSON.stringify({...batch,s})]]);
part('Known and legacy sender identities');
is('old record has no new required field',readPendingPayoutBatches([['BATCH1',JSON.stringify(batch)]]).get('BATCH1')?.s,undefined);
for(const s of ['nl-synthetic-123','x'.repeat(127)])is('a known sender survives exactly',read(s).get('BATCH1')?.s,s);
part('Unknown senders cannot drive deduplication');
for(const s of [null,'','x'.repeat(128),'with space','with\nnewline',42,[],{}]){
 let rejected=false;try{read(s);}catch{rejected=true;}
 is('invalid sender is unavailable '+JSON.stringify(s),rejected,true);
}
part('The uncertainty notice does not tell the creator to pay again');
const mail=autoPayEmail({ok:false,reason:'pending'},'usd');
is('may still go out is stated',mail.text.includes('may still send it'),true);
is('do not pay another way is stated',mail.text.includes('Do not pay them another way'),true);
is('no claim of nothing left the account',mail.text.includes('Nothing left your PayPal'),false);
done();
