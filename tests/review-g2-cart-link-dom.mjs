/** Identified G2 DOM-in-Node variant of original cart proof: same assertion statements/scenarios; optional extra contradictory-answer case. No native browser/CSS/geometry claim. */
import {build} from 'esbuild';import{createRequire}from'node:module';const{JSDOM,VirtualConsole}=createRequire(import.meta.url)(process.env.G2_JSDOM_PACKAGE??'jsdom');
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {CartLinkBuilder} from './components/cart-link-builder';const root=createRoot(document.getElementById('root'));window.g2Flush=flushSync;window.g2Unmount=()=>flushSync(()=>root.unmount());flushSync(()=>root.render(<CartLinkBuilder address="https://example.test/@synthetic" products={[{id:'aaaaaa',title:'Product A'},{id:'bbbbbb',title:'Product B'},{id:'cccccc',title:'Product C'}]}/>));`;
const built=await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},logLevel:'error'});
const script=built.outputFiles[0].text;

const pages=new Set();
const browser={async newPage(){
 const virtualConsole=new VirtualConsole();const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://synthetic.invalid/',runScripts:'outside-only',virtualConsole});const w=dom.window;let handler;const errors=[];
 w.addEventListener('error',e=>{errors.forEach(fn=>fn({message:e.message}));e.preventDefault();});
 w.fetch=(url,options)=>new Promise((resolve,reject)=>{if(url!=='/api/store/short-links'||!handler)return reject(Error('External transport prohibited'));Promise.resolve(handler({request:()=>({postData:()=>options.body}),fulfill:async({status,body})=>resolve({status,json:async()=>JSON.parse(body)})})).catch(reject);});
 function locator(all){return{
  nth(i){return locator(()=>all().slice(i,i+1));},
  async fill(value){const el=all()[0];if(!el)throw Error('Missing input');w.g2Flush(()=>{Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new w.Event('input',{bubbles:true}));el.dispatchEvent(new w.Event('change',{bubbles:true}));});},
  async click(){const el=all()[0];if(!el)throw Error('Missing button');w.g2Flush(()=>el.click());},
  async check(){const el=all()[0];if(!el)throw Error('Missing checkbox');if(!el.checked)w.g2Flush(()=>el.click());},
  async uncheck(){const el=all()[0];if(!el)throw Error('Missing checkbox');if(el.checked)w.g2Flush(()=>el.click());},
  async allTextContents(){return all().map(el=>el.textContent);},async count(){return all().length;}
 };}
 const page={on(event,fn){if(event==='pageerror')errors.push(fn);},async route(_pattern,fn){handler=fn;},async goto(){w.eval(script);},
 locator(selector){return locator(()=>[...w.document.querySelectorAll(selector)]);},
 getByRole(role,options={}){return locator(()=>role==='checkbox'?[...w.document.querySelectorAll('input[type=checkbox]')].filter(el=>el.closest('label').textContent.trim()===options.name):[...w.document.querySelectorAll('button')].filter(el=>el.textContent.trim()===options.name));},
 getByText(text){return locator(()=>[...w.document.querySelectorAll('*')].filter(el=>el.textContent.trim()===text));},
 async waitForFunction(fn){const check=()=>w.eval('('+fn.toString()+')()');if(check())return;await new Promise((resolve,reject)=>{const observer=new w.MutationObserver(()=>{if(check()){observer.disconnect();clearTimeout(timer);resolve();}});const timer=setTimeout(()=>{observer.disconnect();reject(Error('DOM condition not observed'));},5000);observer.observe(w.document,{subtree:true,childList:true,attributes:true,characterData:true});});},
 async close(){if(w.g2Unmount)w.g2Unmount();w.close();pages.delete(page);}
 };pages.add(page);return page;
},async close(){for(const page of [...pages])await page.close();}};
const base='https://synthetic.invalid/';
let checks=0,failures=0;
const is=(label,got,want)=>{checks++;if(JSON.stringify(got)===JSON.stringify(want))console.log('PASS',label);else{failures++;console.log('FAIL',label,JSON.stringify({got,want}));}};
async function ready(page){await page.goto(base);await page.waitForFunction(()=>document.querySelector('input[type=checkbox]')); await page.locator('input[type=checkbox]').nth(0).check();await page.locator('input[type=checkbox]').nth(1).check();await page.locator('#cart-link-post').fill('synthetic-post');}
const link=target=>({code:'abc234',name:'synthetic-post',made:1234,place:'email',target});
try{
 for(const s of [{label:'confirmed',status:200,ok:true,positive:true},{label:'HTTP500',status:500,ok:true},{label:'truthy ok',status:200,ok:'true'},{label:'target lacks ids',status:200,ok:true,incomplete:true},...(process.env.G2_CART_CONTRADICTORY==='1'?[{label:'contradictory error',status:200,ok:true,error:'server_error'}]:[])]){
  const page=await browser.newPage();let calls=0;const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE_ERROR',e.message);});
  await page.route('**/api/store/short-links',async r=>{calls++;const body=JSON.parse(r.request().postData());await r.fulfill({status:s.status,contentType:'application/json',body:JSON.stringify({ok:s.ok,links:[link(s.incomplete?{kind:'cart'}:body.target)],...(s.error?{error:s.error}:{})})});});
  await ready(page);await page.getByRole('button',{name:'Make a short link',exact:true}).click();await page.waitForFunction(()=>document.querySelector('button[aria-busy]')?.getAttribute('aria-busy')==='false');
  const status=await page.locator('[role=status]').allTextContents(),alerts=await page.locator('[role=alert]').allTextContents();
  is(s.label+': advertised short URL requires complete successful confirmation',status.some(x=>x.includes('/l/abc234')),s.positive===true);
  is(s.label+': uncertain response explains failure',alerts.length>0,s.positive!==true);is(s.label+': one request/no component crash',[calls,errors.length],[1,0]);await page.close();
 }
 const page=await browser.newPage();page.on('pageerror',e=>console.log('PAGE_ERROR_RACE',e.message));let pending,requestBody;let arrived;const seen=new Promise(r=>arrived=r);
 await page.route('**/api/store/short-links',r=>{pending=r;requestBody=JSON.parse(r.request().postData());arrived();});
 await ready(page);await page.getByRole('button',{name:'Make a short link',exact:true}).click();await seen;
 await page.getByRole('checkbox',{name:'Product B',exact:true}).uncheck();await page.getByRole('checkbox',{name:'Product C',exact:true}).check();
 is('control: request actually names A and B',requestBody.target.ids,['aaaaaa','bbbbbb']);
 is('control: current long link names A and C',await page.getByText('https://example.test/@synthetic?restore=aaaaaa,cccccc',{exact:true}).count(),1);
 await pending.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,links:[link(requestBody.target)]})});await page.waitForFunction(()=>document.querySelector('button[aria-busy]')?.getAttribute('aria-busy')==='false');
 is('stale success cannot advertise the old A+B URL beside current A+C selection',(await page.locator('[role=status]').allTextContents()).some(x=>x.includes('/l/abc234')),false);await page.close();
}finally{await browser.close();}
console.log(JSON.stringify({checks,failures}));process.exitCode=failures?1:0;
