import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {checkIntroDraftProtection} from './intro-acknowledgment.mjs';

// Independent browser proof. Only Next's refresh is replaced with a no-op;
// React, IntroEditor, leave guard, toast, and video parsing are the actual modules.
const root=resolve(process.env.TASK_TEST_ROOT||process.cwd());
const scratch=await mkdtemp(join(tmpdir(),'u-intro-review-'));
const target=join(root,'components/intro-editor.tsx');
const product=process.env.INTRO_PRODUCT_REF?execFileSync('git',['show',process.env.INTRO_PRODUCT_REF+':components/intro-editor.tsx'],{cwd:root,encoding:'utf8'}):await readFile(target,'utf8');
let checks=0,failures=0;
const is=(name,got,want)=>{checks++;try{assert.deepEqual(got,want);}catch{failures++;console.error('FAIL',name,JSON.stringify({got,want}));throw new Error(name);}};
const result=await build({stdin:{contents:`import {createRoot} from 'react-dom/client';import {IntroEditor} from '@/components/intro-editor';import {Toaster} from '@/components/toast';const initial=location.search.includes('existing=1')?{provider:'youtube',id:'abcdefghijk',hash:''}:null;createRoot(document.querySelector('#root')).render(<><a href='/path'>Path</a><IntroEditor intro={initial}/><Toaster/></>);`,resolveDir:root,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',alias:{'@':root},plugins:[{name:'review-world',setup(b){b.onResolve({filter:/^next\/navigation$/},()=>({path:'router',namespace:'review'}));b.onLoad({filter:/.*/,namespace:'review'},()=>({contents:'export const useRouter=()=>({refresh(){window.refreshes=(window.refreshes||0)+1;}});',loader:'js'}));b.onLoad({filter:/components\/intro-editor\.tsx$/},()=>({contents:product,loader:'tsx',resolveDir:join(root,'components')}));}}]});
const script=result.outputFiles[0].contents;
const server=createServer((request,response)=>{if(request.url==='/app.js'){response.setHeader('Content-Type','application/javascript');response.end(script);return;}response.setHeader('Content-Type','text/html');response.end('<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
let browser;
try{
 browser=await chromium.launch({executablePath:process.env.CHROMIUM||chromium.executablePath(),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 for(const width of [320,390,1280]){
  const context=await browser.newContext({viewport:{width,height:800}});
  const page=await context.newPage();
  const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  let mode='missing',release,held=Promise.resolve(),posts=0;
  await page.route('**/api/store/intro',async route=>{posts++;await held;if(mode==='lost'){await route.abort('failed');return;}const body=route.request().postDataJSON();const value=body.url?{provider:'youtube',id:'abcdefghijk',hash:''}:null;await route.fulfill({status:mode==='http'?500:200,contentType:'application/json',body:mode==='malformed'?'invalid':JSON.stringify(mode==='missing'?{ok:true}:{ok:true,intro:value})});});
  await page.goto(origin+'/');
  const input=page.locator('#intro-url'),form=page.locator('form');await input.waitFor();
  const dirty=()=>page.evaluate(()=>!window.dispatchEvent(new Event('beforeunload',{cancelable:true})));
  is('empty baseline clean '+width,await dirty(),false);
  for(const failure of ['missing','http','malformed','lost']){
   await input.fill('https://youtu.be/abcdefghijk');
   await page.waitForFunction(()=>document.querySelector('#intro-note')?.textContent.includes('A YouTube video'));
   await checkIntroDraftProtection({page,is,label:failure+'/'+width});
   mode=failure;await form.getByRole('button',{name:'Save the video',exact:true}).click();
   await form.getByRole('alert').waitFor();
   await checkIntroDraftProtection({page,is,label:'after '+failure+'/'+width});
  }
  await input.fill('not a video');await page.waitForFunction(()=>document.querySelector('#intro-url')?.getAttribute('aria-invalid')==='true');
  await checkIntroDraftProtection({page,is,label:'invalid draft/'+width});
  await input.fill('https://youtu.be/abcdefghijk');await page.waitForFunction(()=>document.querySelector('#intro-note')?.textContent.includes('A YouTube video'));
  mode='accepted';held=new Promise(resolve=>{release=resolve;});
  const seen=page.waitForRequest(request=>request.method()==='POST'&&new URL(request.url()).pathname==='/api/store/intro');
  await form.getByRole('button',{name:'Save the video',exact:true}).click();await seen;
  is('pending locks input '+width,await input.isDisabled(),true);
  await checkIntroDraftProtection({page,is,label:'pending/'+width});release();held=Promise.resolve();
  await page.locator('.nb-toast-region [role=status]').getByText('Welcome video settings saved.',{exact:true}).waitFor();
  is('accepted save cleans baseline with no-op refresh '+width,await dirty(),false);
  is('accepted save disables unchanged submit '+width,await form.getByRole('button',{name:'Save the video',exact:true}).isDisabled(),true);
  await page.goto(origin+'/?existing=1');await input.waitFor();
  is('stored video starts clean '+width,await dirty(),false);
  await input.fill('https://www.youtube.com/watch?v=abcdefghijk');await page.waitForFunction(()=>document.querySelector('#intro-note')?.textContent.includes('A YouTube video'));
  is('equivalent address stays clean '+width,await dirty(),false);
  mode='accepted';await form.getByRole('button',{name:'Remove it',exact:true}).click();
  await page.locator('.nb-toast-region [role=status]').getByText('Welcome video removed.',{exact:true}).waitFor();
  is('confirmed removal cleans baseline without refresh '+width,await dirty(),false);
  is('confirmed removal keeps empty draft '+width,await input.inputValue(),'');
  is('only intended synthetic POSTs '+width,posts,6);
  is('no browser exceptions '+width,pageErrors,[]);
  await context.close();
 }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await rm(scratch,{recursive:true,force:true});}
console.log(checks+' checks, '+failures+' failures.');
process.exitCode=failures?1:0;
