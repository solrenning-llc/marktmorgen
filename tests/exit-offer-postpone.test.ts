/**
 * WCAG 2.2.4 (interruptions) on the offer a store shows a visitor who is
 * about to leave (components/exit-offer.tsx): the visitor can turn such
 * offers off ("Don't show offers like this", kept in this browser), Escape
 * closes it, and the keyboard goes back where it was. The creator's own words
 * in the offer do not change. The real offer runs in local Chromium with a
 * fake clock and every request refused; the new words are checked in every
 * buyer language.
 */
import { execFileSync } from "node:child_process";
import { speechFor } from "@/lib/buyer-words";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is } from "./check";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const bundle=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {ExitOffer} from "@/components/exit-offer";',
 'import {speechFor} from "@/lib/buyer-words";',
 'const w=speechFor("en","usd").w;',
 'const store=new URLSearchParams(location.search).get("store")||"one";',
 'createRoot(document.getElementById("root")).render(React.createElement(React.Fragment,null,React.createElement("a",{href:"#x",id:"before"},"A link on the page"),React.createElement(ExitOffer,{store,title:"Free checklist",words:{close:w.close,beforeYouGo:w.beforeYouGo,noMore:w.noMoreOffers}},React.createElement("p",null,"The creator\'s own words."))));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'});
async function launch(){const options={headless:true,args:['--no-sandbox']};if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});try{return await chromium.launch(options);}catch(first){try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}}}
let browser;const out={};
try{
 browser=await launch();
 const context=await browser.newContext({viewport:{width:1280,height:800}});
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin==='http://synthetic.test'&&u.pathname==='/store')return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html lang="en"><body><div id="root"></div></body></html>'});return route.abort();});
 const open=async(store)=>{
  const page=await context.newPage();
  await page.clock.install();
  await page.goto('http://synthetic.test/store?store='+store);
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.focus('#before');
  await page.clock.fastForward(9000);
  // Let React render the armed state and listen before the pointer leaves.
  await page.clock.runFor(500);
  await page.waitForTimeout(150);
  await page.evaluate(()=>document.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,clientY:-1,relatedTarget:null})));
  await page.waitForTimeout(100);
  return page;
 };
 const first=await open('one');
 out.first=await first.evaluate(()=>({open:!!document.querySelector('dialog')?.open,buttons:[...document.querySelectorAll('dialog button')].map(b=>(b.getAttribute('aria-label')||b.textContent).trim()),words:document.querySelector('dialog')?.textContent.includes("The creator's own words.")}));
 await first.keyboard.press('Escape');
 await first.waitForTimeout(100);
 out.escape=await first.evaluate(()=>({open:!!document.querySelector('dialog')?.open,focus:document.activeElement?.id||document.activeElement?.tagName}));
 await first.close();
 const second=await open('two');
 out.second=await second.evaluate(()=>!!document.querySelector('dialog')?.open);
 const off=second.getByRole('button',{name:"Don't show offers like this"});
 out.offButton=await off.count();
 if(out.offButton){await off.click();await second.waitForTimeout(100);out.afterOff=await second.evaluate(()=>({open:!!document.querySelector('dialog')?.open,focus:document.activeElement?.id||document.activeElement?.tagName}));}
 await second.close();
 const third=await open('three');
 out.third=await third.evaluate(()=>!!document.querySelector('dialog')?.open);
 await third.close();
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;

const words = LANGUAGE_CODES.map((language) => (speechFor(language, "usd").w as Record<string, unknown>).noMoreOffers as string | undefined);
is("every buyer language has words to turn such offers off", words.every((text) => typeof text === "string" && text.trim().length > 0), true);
is("in English, plainly", (speechFor("en", "usd").w as Record<string, unknown>).noMoreOffers, "Don't show offers like this");

const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 120_000, maxBuffer: 8_000_000 })) as {
  first: { open: boolean; buttons: string[]; words: boolean }; escape: { open: boolean; focus: string }; second: boolean; offButton: number; afterOff?: { open: boolean; focus: string }; third: boolean;
};
is("the offer opens as the pointer leaves through the top", result.first.open, true);
is("with the creator's own words unchanged", result.first.words, true);
is("and a way to turn such offers off", result.first.buttons.includes("Don't show offers like this"), true);
is("Escape closes it", result.escape.open, false);
is("and the keyboard is back where it was", result.escape.focus, "before");
is("another store's offer opens in a later visit", result.second, true);
is("it offers to turn such offers off", result.offButton, 1);
is("turning them off closes it", result.afterOff?.open, false);
is("and puts the keyboard back where it was", result.afterOff?.focus, "before");
is("after that no store's offer interrupts again in this browser", result.third, false);
done();
