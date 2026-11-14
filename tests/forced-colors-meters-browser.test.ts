/**
 * In forced colors the system paints every background in its own Canvas colour, so a bar, a meter's fill or a
 * day's mark drawn only as a coloured box became Canvas on Canvas and vanished: the studio's charts of visits and
 * buying hours, its progress and usage meters, and the share bars of a store's reviews (WCAG 1.4.11 Non-text
 * Contrast; AX274 item 4, forced colors). app/globals.css now draws them, in forced colors only, in CanvasText,
 * the colour the person's theme gives to text: a fill marked .meter-fill, and .rv-bar's fill. Checked in local
 * Chromium with the real stylesheet; the marks are read from the components' source.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {chromium}=require('playwright-core');
const css=readFileSync(root+'/app/globals.css','utf8');
const html='<!doctype html><html lang="en"><head><style>'+css+'</style></head><body>'+
 '<div style="height:12px;width:200px"><div id="fill" class="meter-fill" style="height:100%;width:40%;background:#5b4fe0"></div></div>'+
 '<span class="rv-bar" style="display:block;width:200px"><span id="review" style="width:60%"></span></span>'+
 '<div id="plain" style="height:12px;width:80px;background:#5b4fe0"></div>'+
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
  out[forced]=await page.evaluate(()=>({canvas:getComputedStyle(document.body).backgroundColor,text:getComputedStyle(document.body).color,
   fill:getComputedStyle(document.getElementById('fill')).backgroundColor,review:getComputedStyle(document.getElementById('review')).backgroundColor,plain:getComputedStyle(document.getElementById('plain')).backgroundColor}));
  await page.close();
 }
 console.log(JSON.stringify(out));
}finally{if(browser)await browser.close();}
`;

type Colors = { canvas: string; text: string; fill: string; review: string; plain: string };
const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as Record<"active" | "none", Colors>;

part("In forced colors, the fills are drawn in the text colour, not lost in the page's");
is("a .meter-fill is drawn in CanvasText", result.active.fill, result.active.text);
is("a review share bar is drawn in CanvasText", result.active.review, result.active.text);
is("(a box with no mark still takes the page's colour, as the system decides)", result.active.plain !== result.active.text, true);
is("outside forced colors a fill keeps its own colour", result.none.fill, "rgb(91, 79, 224)");

part("The studio's bars, meters and marks carry .meter-fill");
for (const [file, least] of [
  ["components/sales-goal-card.tsx", 1],
  ["components/store-coach.tsx", 1],
  ["components/usage-meter.tsx", 1],
  ["components/buying-hours.tsx", 2],
  ["components/studio-start.tsx", 1],
  ["components/stats-panel.tsx", 5],
  ["components/import-tool.tsx", 1],
  ["components/product-image-editor.tsx", 1],
  ["components/community-composer.tsx", 1],
  ["components/product-editor.tsx", 1],
] as const) {
  is(`${file}: ${least} or more`, (readFileSync(file, "utf8").match(/\bmeter-fill\b/g) ?? []).length >= least, true);
}
done();
