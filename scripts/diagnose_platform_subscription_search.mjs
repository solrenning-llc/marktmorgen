// Read-only CX-55 diagnostic of the existing cost model.
// No provider access, financial approval, price change or deployment.
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),require=createRequire(join(root,'package.json'));
const {build}=require('esbuild');
const {testAliases,testEnvironment}=await import(join(root,'tests/test-config.mjs'));
const dir=mkdtempSync('/tmp/cx55-numbers-'),out=join(dir,'numbers.cjs');
if(process.argv.includes('--checks')){
 try{
  let failed=false;
  for(const file of ['plan-cost-registry.test.ts','plan-margin.test.ts']){
   await build({entryPoints:[join(root,'tests',file)],bundle:true,platform:'node',format:'cjs',outfile:out,alias:testAliases(file,root,join(root,'tests')),logLevel:'error'});
   const r=spawnSync(process.execPath,[out],{cwd:root,env:testEnvironment(process.env),stdio:'inherit'});
   if(r.status!==0)failed=true;
  }
  process.exitCode=failed?1:0;
 }finally{rmSync(dir,{recursive:true,force:true});}
}else{
try{
 await build({stdin:{contents:`
 import {PLATFORM_SUBSCRIPTION_SEARCH as p, PLATFORM_SUBSCRIPTION_SEARCH_EVENT_USD as event,COST_LINES,perPaymentCost} from './tests/plan-cost-registry';
 import {worstCost,netOf} from './tests/plan-cost-model';
 import {PLAN_PRICES,TIERS} from '@/lib/plan';
 const added=COST_LINES.find(x=>x.id==='platform-subscription-search')!;
 console.log(JSON.stringify({profile:p,event,essentialWindow:event*p.essentialEventsPerWindow,closingWindow:event*p.closingEventsPerWindow,units:TIERS.flatMap(tier=>['month','year'].map(cycle=>{
 const m=cycle==='year'?12:1,old=(worstCost(tier)-added.monthlyUsd(tier))*m+perPaymentCost(tier),net=netOf(tier,cycle)*m;
 return{tier,cycle,price:PLAN_PRICES[tier][cycle]/100,baselineCost:old,net,added:added.monthlyUsd(tier)*m,baselineProfit:net-old,afterProfit:net-old-added.monthlyUsd(tier)*m};
 }))},null,2));`,resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:out,alias:testAliases('plan-margin.test.ts',root,join(root,'tests')),logLevel:'error'});
 const r=spawnSync(process.execPath,[out],{cwd:root,env:testEnvironment(process.env),encoding:'utf8'});
 process.stdout.write(r.stdout+r.stderr);process.exitCode=r.status??1;
}finally{rmSync(dir,{recursive:true,force:true});}
}
