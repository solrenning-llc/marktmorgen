/**
 * The two checkout previews on the feature pages (components/feature-demos.tsx: /platform/price-options and
 * /platform/checkout) each draw a button that looks like it pays. Pressing it did nothing at all (VR site sweep,
 * 12/11/2026): a button that does nothing is make-believe (AGENTS.md, VR Part A, item 2). Pressed now, it says, in a
 * status line read out by screen readers, that this is a preview, that nothing happens here and what the button does on
 * a real store, at the price it shows; nothing is sent and the page does not move. Local Chromium, real code, every
 * outside request refused.
 */
import { execFileSync } from "node:child_process";
import { demoPressedWords } from "@/components/feature-demos";
import { done, is } from "./check";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const bundle=await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {OptionsDemo,BumpDemo} from "@/components/feature-demos";',
 'createRoot(document.getElementById("options")).render(React.createElement(OptionsDemo));',
 'createRoot(document.getElementById("bump")).render(React.createElement(BumpDemo));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'});
async function launch(){
 const options={headless:true,args:['--no-sandbox']};
 if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});
 try{return await chromium.launch(options);}catch(first){
  try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}
 }
}
let browser;
try{
 browser=await launch();
 const page=await browser.newPage();
 const out={errors:[],requests:0};
 page.on('pageerror',e=>out.errors.push(e.message));
 await page.route('**/*',route=>{out.requests++;return route.abort();});
 await page.setContent('<div id="options"></div><div id="bump"></div>');
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.waitForSelector('#bump button[type=submit]');
 const status=sel=>page.evaluate(s=>[...document.querySelectorAll(s+' [role=status]')].map(n=>n.textContent.trim()),sel);
 out.before={options:await status('#options'),bump:await status('#bump')};
 out.requests=0;
 const url=page.url();
 // Options: pick "The season" ($69), then press the button with the keyboard.
 await page.getByLabel('The season').check();
 await page.locator('#options button[type=submit]').focus();await page.keyboard.press('Enter');
 // Bump: check the extra ($39 + $4), then click.
 await page.locator('#bump input[type=checkbox]').check();
 await page.locator('#bump button[type=submit]').click();
 out.after={options:await status('#options'),bump:await status('#bump')};
 // A later choice clears the answer, so a screen reader hears it only on a press.
 await page.locator('#bump input[type=radio]').nth(1).check();
 out.changed={bump:await status('#bump')};
 // The payment plan: $13 today, plus the $4 extra, and the answer says "today".
 await page.locator('#bump button[type=submit]').click();
 out.plan={bump:await status('#bump')};
 out.moved=page.url()!==url;
 console.log(JSON.stringify(out));
}finally{if(browser)await browser.close();}
`;

const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 90_000, maxBuffer: 2_000_000 })) as {
  before: Record<"options" | "bump", string[]>;
  after: Record<"options" | "bump", string[]>;
  changed: Record<"bump", string[]>;
  plan: Record<"bump", string[]>;
  moved: boolean;
  requests: number;
  errors: string[];
};
is("each preview has one status line, empty before its button is pressed", result.before, { options: [""], bump: [""] });
is("pressing the options preview's button says what it would do, at the price picked", result.after.options, [demoPressedWords(69)]);
is("pressing the bump preview's button says what it would do, with the extra added", result.after.bump, [demoPressedWords(43)]);
is("the words say plainly it is a preview and nothing happens here", demoPressedWords(43).startsWith("This is a preview, so nothing happens here."), true);
is("a later choice clears the answer until the button is pressed again", result.changed.bump, [""]);
is("on the payment plan the answer gives what is charged today, as the button does", result.plan.bump, [demoPressedWords(17, "today")]);
is("the plan's answer says $17 today", /\$17 today\.$/.test(demoPressedWords(17, "today")), true);
// No store can sell while PLANS_ON_SALE is false (VR Part A, item 2): the words make no promise about the reader's store.
is("the words never promise the reader's own store a checkout", /\bon your store\b/i.test(demoPressedWords(43)), false);
is("the words are true whether or not paid selling is open", demoPressedWords(43), "This is a preview, so nothing happens here. On a store that is selling, this button opens a secure checkout for $43.");
is("nothing is sent and the page does not move", [result.requests, result.moved], [0, false]);
is("no error in the browser", result.errors, []);
done();
