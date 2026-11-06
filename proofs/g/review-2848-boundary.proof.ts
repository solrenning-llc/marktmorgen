/** Independent runtime pagination controls. No provider or auth boundary is exercised. */
import {readFileSync} from 'node:fs';
import {filesHeld} from '@/lib/file-store';
import {fits,storageUsed} from '@/lib/storage-quota';
import {COST_LINES,BLOB_PUT_TRIES,BLOB_ADVANCED_OP} from '../../tests/plan-cost-registry';
import {PAID_UPLOAD_OPENS} from '@/lib/upload-budget-policy';
import {is,part,done} from '../../tests/check';
import {reset,observed} from './review-2848-world';
const folder='a'.repeat(32),path=(p:number,i=0)=>`stores/${folder}/${p}-${i}`;
const page=(p:number,more:boolean)=>({blobs:[{pathname:path(p),size:1}],hasMore:more,...(more?{cursor:String(p+1)}:{})});
const realFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('External transport prohibited');};
async function main(){
 const logged=console.error;console.error=()=>undefined;
 try{
 part('Empty and complete boundaries use exactly the necessary paid lists');
 reset([]);is('empty storage still lists once',await filesHeld(folder),0);is('one list for empty',observed.list.length,1);is('empty exact still measures vault',observed.vault,1);
 reset(Array.from({length:20},(_,p)=>({blobs:Array.from({length:1000},(_,i)=>({pathname:path(p,i),size:1})),hasMore:p<19,...(p<19?{cursor:String(p+1)}:{})})),7,13);
 const complete=await storageUsed(folder,20021);
 is('20 full pages plus both providers counted',[complete.bytes,complete.available,fits(complete,1)],[20020,true,true]);
 is('twenty actual list calls',observed.list.length,20);is('one vault and one video read',[observed.vault,observed.stream],[1,1]);
 is('every list stays in own folder and 1000 limit',observed.list.every(x=>x.prefix===`stores/${folder}/`&&x.limit===1000),true);
 is('cursor follows every preceding page',observed.list.map(x=>x.cursor??'').join(','),['',...Array.from({length:19},(_,i)=>String(i+1))].join(','));
 part('21st page never called; failed prefixes cannot authorize a file');
 reset(Array.from({length:21},(_,p)=>page(p,true)));
 const incomplete=await storageUsed(folder,100);
 is('21-page answer unavailable',incomplete.available,false);is('no partial admission',fits(incomplete,1),false);is('no 21st list',observed.list.length,20);is('no later provider after cap',[observed.vault,observed.stream],[0,0]);
 for(const tier of ['creator','pro','scale'] as const){
  const modeled=COST_LINES.find(l=>l.id==='blob-list')?.monthlyUsd(tier);
  const bound=PAID_UPLOAD_OPENS[tier]*observed.list.length*BLOB_PUT_TRIES*BLOB_ADVANCED_OP;
  is(`${tier}: measured call cap funded with every try`,typeof modeled==='number'&&Math.abs(modeled-bound)<1e-12,true);
 }
 part('Provider failure and malformed pagination stop before more paid work');
 reset([page(0,true),page(1,true),new Error('synthetic outage before page3 return'),page(3,false)]);
 const failed=await storageUsed(folder,100);is('provider failure unavailable',failed.available,false);is('only three attempted pages',observed.list.length,3);is('provider failure no vault/video',[observed.vault,observed.stream],[0,0]);
 reset([page(0,true),{...page(1,true),cursor:'1'},page(2,false)]);
 is('repeated cursor rejects',await storageUsed(folder,100).then(x=>x.available),false);is('repeated cursor only two calls',observed.list.length,2);
 reset([{blobs:[],hasMore:'false'},page(2,false)]);is('unknown hasMore unavailable',await storageUsed(folder,100).then(x=>x.available),false);is('unknown hasMore no second list',observed.list.length,1);
 reset([page(0,false)],Number.MAX_SAFE_INTEGER);is('unsafe aggregate never authorizes',await storageUsed(folder,Number.MAX_SAFE_INTEGER).then(x=>fits(x,1)),false);
 part('Installed SDK binding, not a provider-request test');
 const pkg=JSON.parse(readFileSync('node_modules/@vercel/blob/package.json','utf8'));
 is('reviewed installed SDK version',pkg.version,'2.8.0');
 const sdk=readFileSync('node_modules/@vercel/blob/dist/index.cjs','utf8');
 const chunk=readFileSync('node_modules/@vercel/blob/dist/chunk-QMTUXFZH.cjs','utf8');
 is('list uses requestApi',/async function list\(options\)[\s\S]*?requestApi/.test(sdk),true);
 is('requestApi default ten retries','VERCEL_BLOB_RETRIES' in process.env?false:/VERCEL_BLOB_RETRIES \|\| "10"/.test(chunk),true);
 is('retry controller uses getRetries',/retries: getRetries\(\)/.test(chunk),true);
 is('registry counts initial plus retries',BLOB_PUT_TRIES,11);
 }finally{console.error=logged;globalThis.fetch=realFetch;}
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
