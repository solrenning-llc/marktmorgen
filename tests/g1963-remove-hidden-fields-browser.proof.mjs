/** Review-only local fixture. Real React component; all writes intercepted; no account or provider. */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
const {chromium}=createRequire(import.meta.url)('playwright-core');

const source = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {CreatorCardEditor} from './components/creator-card-editor';
import {CONTACT_WORDS} from './lib/buyer-words/contact';
const card={on:true,name:'Original name',title:'',email:'creator@example.com',phone:'',website:'',note:''};
window.syntheticCard=card;
createRoot(document.getElementById('root')).render(<CreatorCardEditor initial={card} handle="synthetic" storeName="Synthetic" words={CONTACT_WORDS.en.card} address="example.com/@synthetic/contact" look={{className:'st-page',style:{},lang:'en'}}/>);`;
const built = await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},logLevel:'error'});
const script=built.outputFiles[0].text;
const server=createServer((req,res)=>{
 if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end(script);return;}
 res.setHeader('content-type','text/html');res.end('<!doctype html><div id="root"></div><script src="/app.js"></script>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
let checks=0, failures=0;
const is=(label,got,want)=>{checks++;if(JSON.stringify(got)===JSON.stringify(want))console.log('PASS',label);else{failures++;console.log('FAIL',label,JSON.stringify({got,want}));}};
try {
 const scenarios=[
  {name:'confirmed',status:200,reply:c=>({ok:true,card:c}),success:true},
  {name:'HTTP error carrying success JSON',status:500,reply:c=>({ok:true,card:c})},
  {name:'truthy ok',status:200,reply:c=>({ok:'true',card:c})},
  {name:'incomplete card',status:200,reply:()=>({ok:true,card:{}})},
  {name:'contradictory error',status:200,reply:c=>({ok:true,card:c,error:'server_error'})},
 ];
 for(const scenario of scenarios){
  const page=await browser.newPage(); const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('BROWSER_ERROR',scenario.name,e.message);});
  await page.route('**/api/store/creator-card',r=>r.fulfill({status:scenario.status,contentType:'application/json',body:JSON.stringify(scenario.reply(JSON.parse(r.request().postData())))}));
  await page.goto(base);await page.locator('input[autocomplete=name]').fill('New typed name');
  await page.getByRole('button',{name:'Save the card',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('form')||document.querySelector('form').getAttribute('aria-busy')==='false');
  const state=await page.evaluate(()=>({name:document.querySelector('input[autocomplete=name]')?.value??null,status:document.querySelector('[role=status]')?.textContent??'',alert:document.querySelector('[role=alert]')?.textContent??''}));
  is(scenario.name+': input retained',state.name,'New typed name');
  is(scenario.name+': success only with confirmation',state.status.includes('Your card is saved'),scenario.success===true);
  is(scenario.name+': incomplete evidence announces uncertainty',Boolean(state.alert),scenario.success!==true);
  is(scenario.name+': no component crash',errors.length,0);
  await page.close();
 }
 const empty={on:false,name:'',title:'',email:'',phone:'',website:'',note:''};
 for(const scenario of [
  {name:'confirmed removal',status:200,card:empty,confirmed:true},
  {name:'removal snapshot retains hidden fields',status:200,card:{...empty,email:'retained@example.test',note:'Retained private words'}},
  {name:'removal HTTP failure',status:500,card:empty},
  {name:'removal incomplete snapshot',status:200,card:{}},
  {name:'removal snapshot still public',status:200,card:{...empty,on:true,name:'Still public'}},
 ]){
  const page=await browser.newPage();
  await page.route('**/api/store/creator-card',r=>r.fulfill({status:scenario.status,contentType:'application/json',body:JSON.stringify({ok:true,card:scenario.card})}));
  await page.goto(base);await page.getByRole('button',{name:'Delete the card',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('form').getAttribute('aria-busy')==='false');
  const status=await page.getByRole('status').innerText();
  is(scenario.name+': deletion announced only if confirmed',status.includes('Your card was deleted'),scenario.confirmed===true);
  is(scenario.name+': uncertainty visible',Boolean(await page.getByRole('alert').innerText()),scenario.confirmed!==true);
  is(scenario.name+': draft words retained',await page.locator('input[autocomplete=name]').inputValue(),'Original name');
  if(scenario.name==='removal snapshot retains hidden fields')is('a retained card keeps the Delete control available',await page.getByRole('button',{name:'Delete the card',exact:true}).count(),1);
  await page.close();
 }
 // A held response is an event barrier: editing here must either be locked or survive that response.
 const page=await browser.newPage();let arrive,release;const arrived=new Promise(r=>arrive=r),released=new Promise(r=>release=r);
 await page.route('**/api/store/creator-card',async r=>{const card=JSON.parse(r.request().postData());arrive();await released;await r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,card})});});
 await page.goto(base);const name=page.locator('input[autocomplete=name]');await name.fill('Submitted name');
 await page.getByRole('button',{name:'Save the card',exact:true}).click();await arrived;
 const editable=await name.isEnabled();if(editable)await name.fill('New unsaved edit');release();
 await page.waitForFunction(()=>document.querySelector('form').getAttribute('aria-busy')==='false');
 is('in-flight input is locked or subsequent edit survives',!editable||await name.inputValue()==='New unsaved edit',true);
 await page.close();
} finally {await browser.close();await new Promise(r=>server.close(r));}
console.log(`${checks} checks, ${failures} failures`);process.exitCode=failures?1:0;
