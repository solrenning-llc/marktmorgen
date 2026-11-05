// Codex G additional cases; shared compilation/server/cleanup derived from U c4ca625b, normal launch.
// Codex G copy of Codex U c4ca625b. Only launch adapted to normal Playwright defaults; assertions unchanged.
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
 browser=await chromium.launch({headless:true});
 for(const width of [320,390,1280])for(const failure of ['missing','http','malformed','lost']){
  const context=await browser.newContext({viewport:{width,height:800}});
  const page=await context.newPage();
  let mode=failure,posts=0,release;
  const held=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/store/intro',async route=>{
   posts++;if(mode===failure)await held;
   if(mode==='lost'){await route.abort('failed');return;}
   await route.fulfill({status:mode==='http'?500:200,contentType:'application/json',body:mode==='malformed'?'invalid':JSON.stringify(mode==='missing'?{ok:true}:{ok:true,intro:null})});
  });
  await page.goto(origin+'/?existing=1');const input=page.locator('#intro-url'),form=page.locator('form');await input.waitFor();
  const seen=page.waitForRequest(request=>request.method()==='POST'&&new URL(request.url()).pathname==='/api/store/intro');
  await form.getByRole('button',{name:'Remove it',exact:true}).click();
  const request=await seen;
  is('removal sends empty address '+failure+'/'+width,request.postDataJSON(),{url:''});
  is('removal pending disables input '+failure+'/'+width,await input.isDisabled(),true);
  await checkIntroDraftProtection({page,is,label:'removal pending '+failure+'/'+width});
  release();await form.getByRole('alert').waitFor();
  is('refused removal keeps exact empty draft '+failure+'/'+width,await input.inputValue(),'');
  await checkIntroDraftProtection({page,is,label:'removal unknown '+failure+'/'+width});
  mode='accepted';await form.getByRole('button',{name:'Remove it',exact:true}).click();
  await page.locator('.nb-toast-region [role=status]').getByText('Welcome video removed.',{exact:true}).waitFor();
  is('confirmed removal clean despite no-op refresh '+failure+'/'+width,await page.evaluate(()=>!window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),false);
  is('exactly two synthetic removal POSTs '+failure+'/'+width,posts,2);
  const dialogs=[];page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.dismiss();});
  await page.getByRole('link',{name:'Path',exact:true}).focus();await page.getByRole('link',{name:'Path',exact:true}).press('Enter');await page.waitForURL(origin+'/path');
  is('clean navigation asks zero confirmations '+failure+'/'+width,dialogs,[]);
  await context.close();
 }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await rm(scratch,{recursive:true,force:true});}
console.log(checks+' checks, '+failures+' failures.');
process.exitCode=failures?1:0;


