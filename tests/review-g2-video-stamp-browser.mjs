/** Review fixture: real component, controlled clock, synthetic text; no account/provider. */
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
const {chromium}=createRequire(import.meta.url)('playwright-core');
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {VideoStamp} from './components/video-stamp';
window.mountStamp=(text)=>createRoot(document.getElementById('root')).render(<div style={{position:'relative',width:640,height:360}}><VideoStamp text={text} seed="synthetic-course:student"/><iframe id="player" src="about:blank" style={{width:640,height:360}} allowFullScreen/></div>);window.mountStamp('student@example.test · Sep 26, 2026');`;
const built=await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},logLevel:'error'});
const server=createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end(built.outputFiles[0].text);return;}res.setHeader('content-type','text/html');res.end('<!doctype html><div id="root"></div><script src="/app.js"></script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});let checks=0,failures=0;
function is(label,got,want){checks++;if(JSON.stringify(got)===JSON.stringify(want))console.log('PASS',label);else{failures++;console.log('FAIL',label,JSON.stringify({got,want}));}}
try {
 const page=await browser.newPage({reducedMotion:'reduce'});const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>{if(r.request().url().startsWith(base))return r.continue();external.push(r.request().url());return r.abort();});
 await page.addInitScript(()=>{window.g2Time=0;window.g2Timers=new Map();let next=1;Date.now=()=>window.g2Time;window.setInterval=(f)=>{const id=next++;window.g2Timers.set(id,f);return id;};window.clearInterval=id=>window.g2Timers.delete(id);window.tick=t=>{window.g2Time=t;window.g2Timers.forEach(f=>f());};});
 await page.goto(base);const stamp=page.locator('[data-video-stamp]');await stamp.waitFor();await page.waitForFunction(()=>window.g2Timers.size===1);
 is('only synthetic own text is rendered',await stamp.textContent(),'student@example.test · Sep 26, 2026');
 is('screen reader hidden',await stamp.getAttribute('aria-hidden'),'true');
 const spot=()=>stamp.evaluate(e=>JSON.stringify([e.style.top,e.style.left,e.style.right]));const first=await spot();
 await page.evaluate(()=>window.tick(90000));is('reduced motion retains first position',await spot(),first);
 await page.emulateMedia({reducedMotion:'no-preference'});await page.waitForFunction(()=>matchMedia('(prefers-reduced-motion: reduce)').matches===false);
 await page.evaluate(()=>window.tick(135000));const moving=await spot();
 await page.evaluate(()=>window.tick(180000));await page.waitForFunction(before=>JSON.stringify([document.querySelector('[data-video-stamp]').style.top,document.querySelector('[data-video-stamp]').style.left,document.querySelector('[data-video-stamp]').style.right])!==before,moving);
 is('normal motion changes on the next 45 second slot',(await spot())!==moving,true);
 await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.querySelector('[data-video-stamp]').style.top==='6%'&&document.querySelector('[data-video-stamp]').style.left==='3%');
 is('switching reduced motion back restores first position',await spot(),first);
 await page.locator('#player').click();await page.evaluate(()=>document.querySelector('#player').requestFullscreen());await page.waitForFunction(()=>document.fullscreenElement?.id==='player');
 is('fullscreen player excludes sibling stamp, matching documented limitation',await page.evaluate(()=>!document.fullscreenElement.contains(document.querySelector('[data-video-stamp]'))),true);await page.evaluate(()=>document.exitFullscreen());
 is('no browser error',errors,[]);is('no external request',external,[]);await page.close();
}finally{await browser.close();await new Promise(r=>server.close(r));}
console.log(JSON.stringify({checks,failures}));process.exitCode=failures?1:0;
