import {createHash} from 'node:crypto';
import {isValidElement,type ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NextRequest,answering} from './m-cx118-studio-session-world';
import StudioPage from '@/app/studio/page';
import {AppCodeInvite} from '@/components/app-code-invite';
import {PasskeyManager} from '@/components/passkey-manager';
import {TwoStepManager} from '@/components/two-step-manager';
import {SESSION_COOKIE,openSession} from '@/lib/auth';
import {claimHandle,ensureStatsId,ensureStoreId,storeForEmail} from '@/lib/store';
import {liveSecondStep,mayAddSecondStep} from '@/lib/second-step-gate';
import {secondStepWay,putMember,setRequireTwoStep} from '@/lib/team';
import {listPasskeys,pendingRemoval,scheduleRemoval} from '@/lib/passkeys';
import {POST as callback} from '@/app/api/auth/callback/route';
import {POST as startRoute} from '@/app/api/auth/two-step/route';
import {POST as passkeyRoute} from '@/app/api/auth/passkey/route';
import {makePasskey} from '@/tests/passkey-world';
import {store as redis} from '@/tests/redis-stub';
import {MemoryRedis} from '@/lib/redis-memory';
import {done,is,part} from '@/tests/check';

process.env.NIMBUS_DATA_KEY??='tests-only-not-a-real-deployment-secret';
process.env.RESEND_API_KEY='re_test_second_step_gate_only';
const ORIGIN='https://marktmorgen.com';
const CAP={scenarios:8,assertions:40,commands:2000,routes:4,body:4096,mails:4};
let commands=0,routes=0,mails=0,checks=0;
const check=(name:string,got:unknown,want:unknown)=>{if(++checks>CAP.assertions)throw Error('Assertion cap');is(name,got,want);};
const runCommand=MemoryRedis.prototype.run;
// Count every executed stand-in command, including internal simulator calls.
MemoryRedis.prototype.run=function(command){if(commands+1>CAP.commands)throw Error('Command cap before invocation');commands++;return runCommand.call(this,command);};
globalThis.fetch=(async(input:RequestInfo|URL)=>{if(!String(input).includes('resend'))throw Error('External network forbidden');if(mails+1>CAP.mails)throw Error('Synthetic mail cap before invocation');mails++;return Response.json({id:'synthetic-only-no-provider'});}) as typeof fetch;
function nodes(tree:unknown,type:unknown):ReactElement<Record<string,unknown>>[]{
 if(Array.isArray(tree))return tree.flatMap(x=>nodes(x,type));
 if(!isValidElement<Record<string,unknown>>(tree))return [];
 return [...(tree.type===type?[tree]:[]),...nodes(tree.props.children,type)];
}
async function local(route:(r:NextRequest)=>Promise<Response>,path:string,body:string,cookie:string,content='application/json'){
 if(Buffer.byteLength(body)>CAP.body||routes+1>CAP.routes)throw Error('Local route cap before invocation');routes++;
 return route(new NextRequest(ORIGIN+path,{method:'POST',headers:{'content-type':content,cookie},body}));
}
async function link(email:string){
 const token=createHash('sha256').update('cx118-'+email).digest('hex');
 const hash=createHash('sha256').update('nimbus-auth-link:'+token).digest('hex').slice(0,40);
 await redis.pipeline([['SET','nl:auth:link:'+hash,email,'EX',900]]);
 const r=await local(callback,'/api/auth/callback',new URLSearchParams({token}).toString(),'','application/x-www-form-urlencoded');
 const s=(r.headers.get('set-cookie')||'').match(/nl_session=([^;]*)/)?.[1];if(!s)throw Error('Real link callback did not open session');return s;
}
async function page(session:string,store?:string){
 answering(new NextRequest(ORIGIN+'/studio',{headers:{cookie:`${SESSION_COOKIE}=${session}`}}));
 return StudioPage({searchParams:Promise.resolve(store?{store}:{})});
}
async function main(){
 const scenarios=['link','passkey','team-no-factor','team-all-pending'] as const;
 if(scenarios.length>CAP.scenarios)throw Error('Scenario cap');
 for(const scenario of scenarios){
  redis.clear();commands=0;
  const routesBefore=routes;
  part(scenario);
  const email=`cx118-${scenario}@example.test`;
  let sid:string|undefined;
  let session:string;
  if(scenario.startsWith('team')){
   const owner='cx118-owner@example.test';await claimHandle(owner,'cx118-team','Synthetic team','');
   const shop=(await ensureStoreId(owner))||await storeForEmail(owner);if(!shop?.sid)throw Error('Synthetic team store missing');
   await putMember(shop,email,'editor');await setRequireTwoStep(shop,true,owner);sid=shop.sid;
   // Real unmarked session: same authorization class as link, without another callback.
   session=await openSession(email);
  }else{
   await claimHandle(email,`cx118-${scenario}`,'Synthetic invite','');await ensureStatsId(email);
   const key=makePasskey(email,'cx118-key');await key.keep();
   session=scenario==='passkey'?await openSession(email,'passkey','cx118-key'):await link(email);
  }
  if(scenario==='team-all-pending'){
   const key=makePasskey(email,'cx118-pending');await key.keep();
   await scheduleRemoval(email,'cx118-pending',session,false);
  }
  const beforeRoutesMails=mails;
  const tree=await page(session,sid);
  const canAdd=await mayAddSecondStep(email,session);
  const step=await liveSecondStep(email,session);
  const invites=nodes(tree,AppCodeInvite);
  const managers=nodes(tree,PasskeyManager);
  const apps=nodes(tree,TwoStepManager);
  check('real page returns one passkey and app manager',[managers.length,apps.length],[1,1]);
  check('real gate matches session authorization',canAdd,scenario==='passkey'||scenario==='team-no-factor');
  check('real live step identifies the session',step,scenario==='passkey'?'passkey':null);
  if(scenario==='link'||scenario==='passkey'){
   check('real page includes the invitation for the account inventory',invites.length,1);
   check('an invitation to immediate setup requires the session to be able to add',invites.length===0||canAdd,true);
   if(scenario==='link'){
    const r=await local(startRoute,'/api/auth/two-step',JSON.stringify({action:'start',backup:'cx118-backup@example.test'}),`${SESSION_COOKIE}=${session}`);
    check('real start route preserves second-step security',[r.status,await r.json()],[403,{ok:false,error:'second_step'}]);
    check('refused start never sends mail',mails,beforeRoutesMails);
   }
  }else{
   check('team gate gives the real setup path',await secondStepWay(email),'set_up');
   const managerHtml=renderToStaticMarkup(managers[0]);
   const appHtml=renderToStaticMarkup(apps[0]);
   if(scenario==='team-no-factor'){
    check('healthy setup renders both real enrollment controls',[managerHtml.includes('Add a passkey'),appHtml.includes('Turn on two-step login')],[true,true]);
    const r=await local(passkeyRoute,'/api/auth/passkey',JSON.stringify({action:'options'}),`${SESSION_COOKIE}=${session}`);
    const body=await r.json();check('healthy real enrollment route returns options',[r.status,body.ok,typeof body.options?.challenge],[200,true,'string']);
    check('healthy no-factor setup sends no mail',mails,0);
   }else{
    check('pending key and schedule remain intact',[(await listPasskeys(email)).map(x=>x.id),(await pendingRemoval(email))?.ids],[['cx118-pending'],['cx118-pending']]);
    check('real pending manager explains waiting and keeps add blocked',[managerHtml.includes('days'),managerHtml.includes('Log in again with a passkey or a code'),managerHtml.includes('Add a passkey')],[true,true,false]);
   }
  }
  console.log('RESULT '+JSON.stringify({scenario,canAdd,step,invites:invites.length,passkeyNeedsStep:managers[0]?.props.needsStep,commands,routes:routes-routesBefore,routesTotal:routes,mailsTotal:mails,checks}));
 }
 MemoryRedis.prototype.run=runCommand;answering(null);done();
}
main().catch(error=>{console.error(error);process.exit(2);});
