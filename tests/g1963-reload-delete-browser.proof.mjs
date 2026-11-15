/** Own review-only actual React+Chromium. Inputs are the real authenticated-page seeds from the companion Node proof. */
import{readFileSync}from'node:fs';import{build}from'esbuild';import{createRequire}from'node:module';import{createServer}from'node:http';
const{chromium}=createRequire(import.meta.url)('playwright-core');
const fixtures=JSON.parse(readFileSync('/tmp/g1963-reload-delete-fixtures.json','utf8'));
const source=`import React from'react';import{createRoot}from'react-dom/client';import{CreatorCardEditor}from'./components/creator-card-editor';import{CONTACT_WORDS}from'./lib/buyer-words/contact';createRoot(document.getElementById('root')).render(<CreatorCardEditor initial={window.seed} handle="synthetic" storeName="Synthetic" words={CONTACT_WORDS.en.card} address="example.com/@synthetic/contact" look={{className:'st-page',style:{},lang:'en'}}/>);`;
const built=await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},logLevel:'error'});
const server=createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end(built.outputFiles[0].text);return;}const index=Number(new URL(req.url,'http://localhost').searchParams.get('case')||0),f=fixtures[index];res.setHeader('content-type','text/html');res.end('<!doctype html><div id="root"></div><script>window.seed='+JSON.stringify(f.initial).replaceAll('<','\\u003c')+'</script><script src="/app.js"></script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
let browser,checks=0,failures=0;const is=(label,got,want)=>{checks++;if(JSON.stringify(got)===JSON.stringify(want))console.log('PASS',label);else{failures++;console.log('FAIL',label,JSON.stringify({got,want}));}};
try{browser=await chromium.launch({headless:true});
for(const[i,f]of fixtures.entries()){
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 await page.route('**/api/store/creator-card',r=>{const b=JSON.parse(r.request().postData());return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,card:b.action==='save'?f.initial:{on:false,name:'',title:'',email:'',phone:'',website:'',note:''},...(b.action==='remove'?{removed:true}:{})})});});
 await page.goto(`${base}/?case=${i}`);await page.getByRole('button',{name:'Save the card',exact:true}).waitFor();
 is(f.label+': real name seed',await page.locator('input[autocomplete=name]').inputValue(),f.initial.name);
 is(f.label+': real retained email seed',await page.locator('input[autocomplete=email]').inputValue(),f.initial.email);
 is(f.label+': Delete available for every kept record after reload',await page.getByRole('button',{name:'Delete the card',exact:true}).count(),f.held?1:0);
 is(f.label+': no crash',errors.length,0);
 if(f.held&&!f.initial.name&&!f.initial.on){
  await page.getByRole('button',{name:'Save the card',exact:true}).click();await page.waitForFunction(()=>document.querySelector('form').getAttribute('aria-busy')==='false');
  is(f.label+': saving once exposes Delete (workaround)',await page.getByRole('button',{name:'Delete the card',exact:true}).count(),1);
  await page.getByRole('button',{name:'Delete the card',exact:true}).click();await page.waitForFunction(()=>document.querySelector('form').getAttribute('aria-busy')==='false');
  is(f.label+': confirmed retry can delete',await page.getByRole('status').innerText().then(x=>x.includes('Your card was deleted')),true);
 }
 await page.close();
}}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
console.log(`${checks} checks, ${failures} failures`);process.exitCode=failures?1:0;
