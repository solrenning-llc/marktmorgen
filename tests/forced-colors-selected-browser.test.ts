/**
 * In forced colors (Windows High Contrast and the like), the system repaints every background with its own Canvas
 * colour, so a choice shown as chosen only by being a filled button (.btn-primary beside .btn-ghost or
 * .btn-secondary) looked exactly like the others: the inbox's filter tabs, and every toggle, segmented choice and
 * "you are here" button drawn that way (WCAG 1.4.1, 1.4.11; AX274 item 4, forced colors). The state is still in
 * aria-selected, aria-pressed or aria-current, so app/globals.css now draws those, in forced colors only, in the
 * system's Highlight colours, which the person's own theme chose to stand out. Checked in local Chromium with the
 * real stylesheet; outside forced colors nothing changes.
 */
import { execFileSync } from "node:child_process";
import { done, is } from "./check";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {chromium}=require('playwright-core');
const css=readFileSync(root+'/app/globals.css','utf8');
const html='<!doctype html><html lang="en"><head><style>'+css+'</style></head><body style="padding:20px">'+
 '<div role="tablist"><button class="btn btn-primary" role="tab" aria-selected="true" id="tab-on">Open</button><button class="btn btn-ghost" role="tab" aria-selected="false" id="tab-off">Mine</button></div>'+
 '<div><button class="btn btn-primary" aria-pressed="true" id="press-on">Monthly</button><button class="btn btn-secondary" aria-pressed="false" id="press-off">Yearly</button></div>'+
 '<nav><a class="btn btn-primary" aria-current="page" href="#a" id="here">Sales</a><a class="btn btn-ghost" href="#b" id="there">Pages</a></nav>'+
 '</body></html>';
async function launch(){
 const options={headless:true,args:['--no-sandbox']};
 if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});
 try{return await chromium.launch(options);}catch(first){try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}}
}
let browser;
try{
 browser=await launch();
 const out={};
 for(const forced of ['active','none']){
  const page=await browser.newPage();
  await page.emulateMedia({forcedColors:forced});
  await page.route('**/*',r=>r.abort());
  await page.setContent(html);
  // The background as seen: a transparent one shows its parent's.
  out[forced]=await page.evaluate(()=>{
   const seen=(el)=>{for(let e=el;e;e=e.parentElement){const b=getComputedStyle(e).backgroundColor;if(!/rgba\(.*, 0\)$/.test(b)&&b!=='transparent')return b;}return 'rgb(255, 255, 255)';};
   return Object.fromEntries(['tab-on','tab-off','press-on','press-off','here','there'].map(id=>{const el=document.getElementById(id),c=getComputedStyle(el);return [id,[seen(el),c.color,c.borderTopColor,c.borderTopStyle,c.borderTopWidth].join('|')];}));
  });
  await page.close();
 }
 console.log(JSON.stringify(out));
}finally{if(browser)await browser.close();}
`;

const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as Record<"active" | "none", Record<string, string>>;
const forced = result.active;

is("forced colors: the selected tab does not look like the others", forced["tab-on"] !== forced["tab-off"], true);
is("forced colors: a pressed button does not look like the others", forced["press-on"] !== forced["press-off"], true);
is("forced colors: the page you are on does not look like the others", forced["here"] !== forced["there"], true);
is("forced colors: the three are drawn alike, in the system's own colours for it", forced["tab-on"] === forced["press-on"] && forced["press-on"] === forced["here"], true);
is("outside forced colors, the selected tab is drawn as before (a filled button, unlike the others)", result.none["tab-on"] !== result.none["tab-off"], true);
done();
