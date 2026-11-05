/** Independent G browser controls; disposable documents, no application writes. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright-core'),ts=require('typescript');
const root=new URL('../../',import.meta.url);
const exports={};
runInNewContext(ts.transpileModule(readFileSync(new URL('lib/reveal-scripts.ts',root),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports});
const css=readFileSync(new URL('app/globals.css',root),'utf8');
const revealCss=[/:root\[data-reveal="on"\] \.reveal \{[^}]*\}/,/:root\[data-reveal="on"\] \.reveal\.is-in \{[^}]*\}/].map(re=>{const match=css.match(re);assert.ok(match);return match[0];}).join('\n');
const browser=await chromium.launch({headless:true});let checks=0;
try{
 for(const [label,reduced,absent] of [['reduced-motion',true,false],['observer-unavailable',false,true]]){
  const context=await browser.newContext({reducedMotion:reduced?'reduce':'no-preference'});
  try{
   const page=await context.newPage();
   await page.route('**/*',route=>route.abort());
   await page.setContent(`<style>.reveal{opacity:1}${revealCss}</style><section class="reveal">Readable</section>`);
   if(absent)await page.evaluate(()=>{window.IntersectionObserver=undefined;});
   await page.addScriptTag({content:exports.REVEAL_ON});
   await page.addScriptTag({content:exports.REVEAL_WATCH});
   assert.equal(await page.locator('html').getAttribute('data-reveal'),null,label+' never hides content');checks++;
   assert.equal(await page.locator('section').evaluate(node=>getComputedStyle(node).opacity),'1',label+' remains painted');checks++;
  }finally{await context.close();}
 }
 for(const [index,script] of [exports.REVEAL_ON,exports.REVEAL_WATCH].entries()){
  assert.equal(exports.REVEAL_HASHES[index],"'sha256-"+createHash('sha256').update(script).digest('base64')+"'");checks++;
 }
 console.log(`G_REVEAL_CONTROLS ${checks}/6 PASS; actual Chromium, real inline scripts/CSS, no application route or Firefox claim.`);
}finally{await browser.close();}
