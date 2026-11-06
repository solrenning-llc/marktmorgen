/** G review-only: actual SSR -> delayed React 19 hydration -> keyboard/local edits; no save/ACK/provider operation. */
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const require=createRequire(import.meta.url),{chromium}=require('playwright-core');
const root=process.cwd(),dir=mkdtempSync(join(tmpdir(),'g2834-browser-'));
const canonical=readFileSync(join(root,'tests/checkout-fields-hydration-readiness.test.ts'),'utf8');
const fixtures=canonical.slice(canonical.indexOf('const router ='),canonical.indexOf('const draw ='));
const common=`import React from 'react';import {AppRouterContext} from 'next/dist/shared/lib/app-router-context.shared-runtime';import {CheckoutFieldsEditor} from './components/checkout-fields-editor';`;
let browser,server,checks=0,failures=0;
const is=(label,got,want)=>{checks++;if(JSON.stringify(got)===JSON.stringify(want))console.log('PASS',label);else{failures++;console.log('FAIL',label,JSON.stringify({got,want}));}};
try{
 const ssr=join(dir,'ssr.cjs');
 await build({stdin:{contents:common+`import{renderToString}from'react-dom/server';import type{Product}from'./lib/store';`+fixtures+`export function draw(fields,price=2500){const seed=product(fields,price);return{seed,html:renderToString(<AppRouterContext.Provider value={router}><CheckoutFieldsEditor product={seed}/></AppRouterContext.Provider>)}}`,resolveDir:root,loader:'tsx'},bundle:true,platform:'node',format:'cjs',outfile:ssr,jsx:'automatic',alias:{'@':root},logLevel:'error'});
 const {draw}=require(ssr),saved=[{label:'Size',type:'dropdown',optional:false,options:['Small','Large']}];
 const cases=[{name:'new questions',label:'Ask the buyer something at checkout',fields:[],price:2500},{name:'saved questions',label:'Change',fields:saved,price:2500},{name:'free product',label:'',fields:saved,price:0}];
 const client=await build({stdin:{contents:common+`import{hydrateRoot}from'react-dom/client';const router={bfcacheId:'g2834',back(){},forward(){},refresh(){},push(){},replace(){},prefetch(){}};function Root(){const[product,setProduct]=React.useState(window.gSeed);React.useEffect(()=>{window.gSetProduct=setProduct},[]);return <AppRouterContext.Provider value={router}><CheckoutFieldsEditor product={product}/></AppRouterContext.Provider>}window.gHydrate=()=>hydrateRoot(document.getElementById('root'),<React.StrictMode><Root/></React.StrictMode>,{onRecoverableError:e=>window.gRecover.push(String(e))});`,resolveDir:root,loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,jsx:'automatic',alias:{'@':root},define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},logLevel:'error'});
 server=createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(client.outputFiles[0].text);return;}const c=cases[Number(new URL(req.url,'http://localhost').searchParams.get('case'))||0],f=draw(c.fields,c.price);res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><div id="root">'+f.html+'</div><script>window.gSeed='+JSON.stringify(f.seed).replaceAll('<','\\u003c')+';window.gRecover=[];window.gPosts=[];window.fetch=async(...args)=>{window.gPosts.push(String(args[0]));throw Error("External/save transport prohibited in G2834 hydration proof")}</script><script src="/app.js"></script>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true});
 for(const[index,c]of cases.entries()){
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());await page.goto(`${base}/?case=${index}`);
  if(c.price===0){is('free: SSR has no control',await page.locator('button').count(),0);await page.evaluate(()=>window.gHydrate());await page.waitForFunction(()=>typeof window.gSetProduct==='function');is('free: hydrated has no control',await page.locator('button').count(),0);is('free: no hydration error',errors.length+await page.evaluate(()=>window.gRecover.length),0);is('free: no POST',await page.evaluate(()=>window.gPosts.length),0);await page.close();continue;}
  await page.evaluate(()=>window.gOriginal=document.querySelector('button'));
  is(c.name+': SSR native disabled',await page.locator('button').isDisabled(),true);
  is(c.name+': SSR aria disabled',await page.locator('button').getAttribute('aria-disabled'),'true');
  is(c.name+': action visible while loading',await page.locator('button').innerText(),c.label+' — Loading…');
  is(c.name+': saved text readable',await page.locator('#root').innerText().then(s=>c.fields.length?s.includes('Size'):!s.includes('Asks at checkout:')),true);
  await page.keyboard.press('Tab');is(c.name+': unavailable control not in keyboard focus',await page.evaluate(()=>document.activeElement===window.gOriginal),false);
  await page.evaluate(()=>window.gOriginal.click());is(c.name+': native click cannot open before hydration',await page.locator('form').count(),0);is(c.name+': no pre-hydration POST',await page.evaluate(()=>window.gPosts.length),0);
  await page.evaluate(()=>window.gHydrate());await page.waitForFunction(()=>document.querySelector('button')?.disabled===false&&typeof window.gSetProduct==='function');
  is(c.name+': hydration preserves same native control',await page.evaluate(()=>document.querySelector('button')===window.gOriginal),true);
  is(c.name+': hydrated visible action',await page.locator('button').innerText(),c.label);is(c.name+': hydrated aria-disabled removed',await page.locator('button').getAttribute('aria-disabled'),null);
  await page.locator('button').focus();await page.keyboard.press('Enter');is(c.name+': keyboard opens actual form',await page.locator('form').count(),1);
  const input=page.locator('input[id$="-l"]');is(c.name+': original field value',await input.inputValue(),c.fields[0]?.label||'');await input.fill('Unsaved local edit');is(c.name+': local edit retained',await input.inputValue(),'Unsaved local edit');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();is(c.name+': cancel does not POST',await page.evaluate(()=>window.gPosts.length),0);
  await page.getByRole('button',{name:c.label,exact:true}).click();is(c.name+': reopen discards only unsaved edit',await page.locator('input[id$="-l"]').inputValue(),c.fields[0]?.label||'');await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.evaluate(()=>window.gSetProduct({...window.gSeed,id:'synthetic_refresh',fields:[{label:'Fresh server label',type:'text',optional:true,options:[]}]}));
  await page.getByRole('button',{name:'Change',exact:true}).click();is(c.name+': opening after prop refresh uses current product',await page.locator('input[id$="-l"]').inputValue(),'Fresh server label');
  is(c.name+': no save/provider request at any point',await page.evaluate(()=>window.gPosts.length),0);is(c.name+': no hydration/render error',errors.length+await page.evaluate(()=>window.gRecover.length),0);await page.close();
 }
}finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
console.log(`${checks} checks, ${failures} failures`);process.exitCode=failures?1:0;
