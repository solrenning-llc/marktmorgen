import {createHash} from 'node:crypto';
import {isValidElement,type ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NextRequest} from 'next/server.js';
import {answering} from '@/tests/security/next-headers';
import PageHead from '@/app/studio/page';
// Controlled substitution of Page only; this is not the complete base tree.
import PageBase from '../source-base/app/studio/page';
import {StudioStart,type StartStep} from '@/components/studio-start';
import {AppCodeInvite} from '@/components/app-code-invite';
import {APP_CODE_INVITE_HREF} from '@/lib/app-code-invite-words';
import {PasskeyManager} from '@/components/passkey-manager';
import {RecoveryAddressManager} from '@/components/recovery-address-manager';
import {TwoStepManager} from '@/components/two-step-manager';
import {SESSION_COOKIE,openSession} from '@/lib/auth';
import {claimHandle,ensureStatsId} from '@/lib/store';
import {mayAddSecondStep} from '@/lib/second-step-gate';
import {makePasskey} from '@/tests/passkey-world';
import {store as redis} from '@/tests/redis-stub';
import {done,is,part} from '@/tests/check';

type Meter={caseCommands:number;totalCommands:number;faultKey:string|null;faultHits:number;protectedKeys:string[];securityWrites:number;mails:number;networkAttempts:number};
const meter=(globalThis as unknown as {__m2945:Meter}).__m2945;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,40);
function nodes(tree:unknown,type:unknown):ReactElement<Record<string,unknown>>[]{
 if(Array.isArray(tree))return tree.flatMap(x=>nodes(x,type));
 if(!isValidElement<Record<string,unknown>>(tree))return [];
 return [...(tree.type===type?[tree]:[]),...nodes(tree.props.children,type)];
}
const cases=['known-none','known-passkey','recovery-unknown','app-unknown','invite-destination','passkeys-unknown'] as const;
type Case=typeof cases[number];
type Observation={step:'omitted'|'done'|'todo';invite:number;managers:number[];target:boolean;notice:boolean;needsStep:unknown;gate:boolean|string};
async function variant(which:'base'|'head',scenario:Case){
 meter.faultKey=null;redis.clear();
 const email=`m2945-${scenario}@example.test`;
 const keyId='m2945-key';
 await claimHandle(email,`m2945-${scenario}`,'Synthetic security review','');
 await ensureStatsId(email);
 const hasKey=!['known-none','recovery-unknown'].includes(scenario);
 if(hasKey)await makePasskey(email,keyId).keep();
 const session=await openSession(email,hasKey?'passkey':undefined,hasKey?keyId:undefined);
 const keys=[`nl:pk:${sha('nimbus-passkeys:'+email)}`,`nl:pk:cred:${sha('nimbus-passkey-id:'+keyId)}`,`nl:auth:rec:${sha('nimbus-rec:'+email)}`,`nl:2fa:${sha('nimbus-2fa:'+email)}`];
 const before=await redis.pipeline(keys.map(k=>['GET',k]));
 meter.protectedKeys=keys;meter.securityWrites=0;
 meter.faultKey=scenario==='app-unknown'?keys[3]:['recovery-unknown','invite-destination'].includes(scenario)?keys[2]:scenario==='passkeys-unknown'?keys[0]:null;
 const hitsBefore=meter.faultHits;
 answering(new NextRequest('https://marktmorgen.com/studio',{headers:{cookie:`${SESSION_COOKIE}=${session}`}}));
 const tree=await (which==='head'?PageHead:PageBase)({searchParams:Promise.resolve({})});
 const gate=await mayAddSecondStep(email,session).catch((error:unknown)=>error instanceof Error?error.name:'Unknown');
 const starts=nodes(tree,StudioStart);
 if(starts.length!==1)throw Error('HARNESS_CONTROL: real StudioStart missing');
 const step=(starts[0].props.steps as StartStep[]).find(x=>x.key==='recovery');
 const apps=nodes(tree,TwoStepManager);
 const recovery=nodes(tree,RecoveryAddressManager);
 const passkeys=nodes(tree,PasskeyManager);
 if(passkeys.length!==1)throw Error('HARNESS_CONTROL: real PasskeyManager missing');
 const appHtml=apps.map(x=>renderToStaticMarkup(x)).join('');
 const observation:Observation={step:step?step.done?'done':'todo':'omitted',invite:nodes(tree,AppCodeInvite).length,managers:[recovery.length,apps.length],target:appHtml.includes('id="two-step"'),notice:nodes(tree,'p').some(x=>String(x.props.children).includes('Your two-step login and recovery address could not be read just now.')),needsStep:passkeys[0].props.needsStep,gate};
 const injected=meter.faultKey!==null;
 if(injected&&meter.faultHits===hitsBefore)throw Error('HARNESS_CONTROL: fault never reached real GET');
 meter.faultKey=null;
 const after=await redis.pipeline(keys.map(k=>['GET',k]));
 const intact=JSON.stringify(before)===JSON.stringify(after)&&meter.securityWrites===0;
 if(hasKey&&typeof after[0]!=='string')throw Error('HARNESS_CONTROL: stored credential disappeared');
 answering(null);
 return {observation,intact,faultHits:meter.faultHits-hitsBefore,securityWrites:meter.securityWrites};
}
function expected(scenario:Case,which:'base'|'head'):Observation{
 const key=!['known-none','recovery-unknown'].includes(scenario);
 const unread=['recovery-unknown','app-unknown','invite-destination'].includes(scenario);
 return {step:scenario==='recovery-unknown'&&which==='head'?'omitted':key&&scenario!=='passkeys-unknown'?'done':'todo',invite:key&&scenario!=='passkeys-unknown'&&!(scenario==='app-unknown'&&which==='head')?1:0,managers:unread?[0,0]:[1,1],target:!unread,notice:unread,needsStep:scenario==='passkeys-unknown',gate:scenario==='passkeys-unknown'?'Error':true};
}
async function main(){
 if(cases.length!==6)throw Error('HARNESS_CONTROL: case count');
 console.log('BOUNDARY React server tree plus selected real TwoStepManager static markup; no DOM, hydration, real WebAuthn login, complete base-tree claim, or provider');
 console.log('NEXT_ADAPTERS cookies/headers=canonical request fixture; after=discarded; redirect/notFound=throw; navigation hooks=fixed no-op test values');
 for(const scenario of cases){
  // Accumulated across setup + base + head + verification; total never reset.
  meter.caseCommands=0;meter.faultHits=0;
  part(scenario);
  const base=await variant('base',scenario);const head=await variant('head',scenario);
  is('CONTROL exact real observations base/head',[base.observation,head.observation],[expected(scenario,'base'),expected(scenario,'head')]);
  is('CONTROL security records remain intact and no network escaped',[base.intact,head.intact,meter.networkAttempts,meter.mails],[true,true,0,0]);
  const safe=scenario==='invite-destination'
   ? [base.observation,head.observation].every(o=>o.invite===0||o.target)
   : scenario==='passkeys-unknown'
    ? [base.observation,head.observation].every(o=>o.step!=='todo')
    : scenario==='recovery-unknown'?head.observation.step==='omitted'
    : scenario==='app-unknown'?head.observation.invite===0
    : head.observation.target;
  is('BEHAVIOR recommendation and recovery tick have known support',safe,true);
  console.log('RESULT '+JSON.stringify({scenario,base,head,commands:meter.caseCommands,totalCommands:meter.totalCommands,mails:meter.mails,networkAttempts:meter.networkAttempts,inviteHref:APP_CODE_INVITE_HREF}));
 }
 done();
}
main().catch(error=>{console.error('HARNESS_CONTROL',error);process.exit(2);});
