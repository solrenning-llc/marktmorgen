/** Identified G2 DOM-in-Node variant of the preserved Chromium proof. Same 33 assertion statements/scenarios. No native browser, CSS or geometry claim. */
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const {JSDOM,VirtualConsole}=createRequire(import.meta.url)(process.env.G2_JSDOM_PACKAGE ?? 'jsdom');
const source = `import React from 'react';
import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
import {CreatorCardEditor} from './components/creator-card-editor';
import {CONTACT_WORDS} from './lib/buyer-words/contact';
const card={on:true,name:'Original name',title:'',email:'creator@example.com',phone:'',website:'',note:''};
window.syntheticCard=card;
const root=createRoot(document.getElementById('root')); window.g2Flush=flushSync; window.g2Unmount=()=>flushSync(()=>root.unmount()); flushSync(()=>root.render(<CreatorCardEditor initial={card} handle="synthetic" storeName="Synthetic" words={CONTACT_WORDS.en.card} address="example.com/@synthetic/contact" look={{className:'st-page',style:{},lang:'en'}}/>));`;
const built = await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},logLevel:'error'});
const script=built.outputFiles[0].text;

const pages=new Set();
const browser={
 async newPage(){
  const console=new VirtualConsole();const errors=[];console.on('jsdomError',e=>errors.push(e));
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://synthetic.invalid/',runScripts:'outside-only',virtualConsole:console});
  const w=dom.window;let handler;const callbacks=[];
  w.addEventListener('error',e=>{callbacks.forEach(fn=>fn({message:e.message}));e.preventDefault();});
  w.fetch=(url,options)=>new Promise((resolve,reject)=>{
   if(url!=='/api/store/creator-card'||!handler){reject(Error('External transport prohibited in G2 DOM review'));return;}
   Promise.resolve(handler({request:()=>({postData:()=>options.body}),fulfill:async({status,body})=>resolve({status,json:async()=>JSON.parse(body)})})).catch(reject);
  });
  function locator(find){return{
   async fill(value){const el=find();if(!el)throw Error('Missing input');w.g2Flush(()=>{Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new w.Event('input',{bubbles:true}));el.dispatchEvent(new w.Event('change',{bubbles:true}));});},
   async click(){const el=find();if(!el)throw Error('Missing button');w.g2Flush(()=>el.click());},
   async inputValue(){return find()?.value;},async isEnabled(){return !find()?.disabled;},async innerText(){return find()?.textContent??'';}
  };}
  const page={
   on(event,fn){if(event==='pageerror')callbacks.push(fn);},async route(_pattern,fn){handler=fn;},
   async goto(){w.eval(script);},
   locator(selector){return locator(()=>w.document.querySelector(selector));},
   getByRole(role,options={}){return locator(()=>role==='button'?[...w.document.querySelectorAll('button')].find(el=>el.textContent.trim()===options.name):w.document.querySelector(`[role="${role}"]`));},
   async evaluate(fn){return w.eval('('+fn.toString()+')()');},
   async waitForFunction(fn){
    const check=()=>w.eval('('+fn.toString()+')()');if(check())return;
    await new Promise((resolve,reject)=>{const observer=new w.MutationObserver(()=>{try{if(check()){observer.disconnect();clearTimeout(timer);resolve();}}catch(error){observer.disconnect();clearTimeout(timer);reject(error);}});const timer=setTimeout(()=>{observer.disconnect();reject(Error('DOM condition not observed'));},5000);observer.observe(w.document,{subtree:true,childList:true,attributes:true,characterData:true});});
   },
   async close(){if(w.g2Unmount)w.g2Unmount();w.close();pages.delete(page);}
  };pages.add(page);return page;
 },async close(){for(const page of [...pages])await page.close();}
};
const base='https://synthetic.invalid/';
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
} finally {await browser.close();}
console.log(`${checks} checks, ${failures} failures`);process.exitCode=failures?1:0;
