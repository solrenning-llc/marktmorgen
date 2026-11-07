// Codex G2's proof on #1928 (624 [SZ8](23), head 8a04da813, branch codex/g2-review-1928-cart-link-red at 9a02bebde), kept as permanent tests.
/** Real React component, synthetic intercepted responses only. */
import {build} from 'esbuild';import {createRequire} from 'node:module';import {createServer} from 'node:http';
const {chromium}=createRequire(import.meta.url)('playwright-core');
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {CartLinkBuilder} from './components/cart-link-builder';createRoot(document.getElementById('root')).render(<CartLinkBuilder address="https://example.test/@synthetic" products={[{id:'aaaaaa',title:'Product A'},{id:'bbbbbb',title:'Product B'},{id:'cccccc',title:'Product C'}]}/>);`;
const built=await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},logLevel:'error'});
const server=createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('content-type','text/javascript; charset=utf-8');res.end(built.outputFiles[0].text);return;}res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});let checks=0,failures=0;
const is=(label,got,want)=>{checks++;if(JSON.stringify(got)===JSON.stringify(want))console.log('PASS',label);else{failures++;console.log('FAIL',label,JSON.stringify({got,want}));}};
async function ready(page){await page.goto(base);await page.waitForFunction(()=>document.querySelector('input[type=checkbox]')); await page.locator('input[type=checkbox]').nth(0).check();await page.locator('input[type=checkbox]').nth(1).check();await page.locator('#cart-link-post').fill('synthetic-post');}
const link=target=>({code:'abc234',name:'synthetic-post',made:1234,place:'email',target});
try{
 for(const s of [{label:'confirmed',status:200,ok:true,positive:true},{label:'HTTP500',status:500,ok:true},{label:'truthy ok',status:200,ok:'true'},{label:'target lacks ids',status:200,ok:true,incomplete:true}]){
  const page=await browser.newPage();let calls=0;const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE_ERROR',e.message);});
  await page.route('**/api/store/short-links',async r=>{calls++;const body=JSON.parse(r.request().postData());await r.fulfill({status:s.status,contentType:'application/json',body:JSON.stringify({ok:s.ok,links:[link(s.incomplete?{kind:'cart'}:body.target)]})});});
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
}finally{await browser.close();await new Promise(r=>server.close(r));}
console.log(JSON.stringify({checks,failures}));process.exitCode=failures?1:0;
