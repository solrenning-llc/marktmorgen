import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),require=createRequire(root+'/package.json');
const {compile}=require('@tailwindcss/node');
const source=readFileSync(root+'/app/[handle]/shop/[collection]/page.tsx','utf8');
const main=source.match(/<main id="content" className="([^"]+)"/)[1];
const product=readFileSync(root+'/lib/product-image.ts','utf8');
const sizes=product.match(/cover: "([^"]+)"/)[1];
const compiler=await compile(readFileSync(root+'/app/globals.css','utf8'),{base:root,onDependency(){}});
const css=compiler.build([...main.split(/\s+/),'mt-8','space-y-4','st-card','st-cover','st-cover-link','overflow-hidden']);
const browser=await require('playwright-core').chromium.launch({headless:true});
try{
 for(const [label,hint] of [['control','(max-width: 36rem) calc(100vw - 2rem), 34rem'],['candidate',sizes]]){
  const context=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:2});
  await context.route('**/*',route=>{const width=route.request().url().includes('small')?800:1200;return route.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width*9/16}"><rect width="100%" height="100%" fill="blue"/></svg>`});});
  const page=await context.newPage();
  await page.setContent(`<style>${css}</style><main class="${main}"><ul class="mt-8 space-y-4"><li class="st-card overflow-hidden"><a class="st-cover-link"><img class="st-cover" src="http://fixture/full.svg" srcset="http://fixture/small.svg 800w, http://fixture/full.svg 1200w" sizes="${hint}" width="1200" height="675"></a></li></ul></main>`);
  await page.waitForFunction(()=>document.querySelector('img').complete&&document.querySelector('img').naturalWidth>0);
  const result=await page.locator('img').evaluate(img=>({width:img.getBoundingClientRect().width,currentSrc:img.currentSrc,dpr:devicePixelRatio,sizes:img.sizes}));
  console.log(JSON.stringify({label,...result,scope:'collection markup class + repository CSS, synthetic image candidates; not full Next route/LCP/bytes'}));
  assert.ok(result.width>500,'actual single-column cover is wider than25rem');
  assert.ok(result.currentSrc.endsWith('/full.svg'),label+': 2x single-column cover requires the available1200w copy');
  await context.close();
 }
}finally{await browser.close();}
