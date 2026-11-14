/**
 * AX274 Part A item 6 on "Can everyone use your store?" (lib/store-access-check.ts,
 * components/store-access-check.tsx): each warning offers its fix in one click.
 * A product picture with no description and a link whose words do not say
 * where they go are each a link that, when the creator presses it, opens that
 * product or that link in the studio and puts the focus in the exact field to
 * fill (the picture's description, the link's words). Nothing is opened before
 * the press, and nothing is changed: the creator writes the words and saves.
 *
 * Part 1: the check carries each product's id beside its title. Part 2: the
 * warning draws one such link per item. Part 3: the product and link editors
 * answer those links (components/use-fix-link.ts). Part 4: the hook in local
 * Chromium, with every request refused.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { StoreAccessCheck } from "@/components/store-access-check";
import { addProduct, claimHandle, ensureStatsId, setProductImage, storeForEmail } from "@/lib/store";
import { accessCheck, type AccessCheck } from "@/lib/store-access-check";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const picture = (n: number) => ({ path: `images/${"a".repeat(24)}/${String(n).repeat(32)}.jpg`, width: 1200, height: 800, alt: "", bytes: 1, small: null });

async function main(): Promise<void> {
  part("The check names each product by its id too");
  redis.clear();
  const owner = "access-fix@example.com";
  await claimHandle(owner, "accessfixshop", "Access Fix Shop", "");
  await ensureStatsId(owner);
  const bread = await addProduct(owner, "Bread Book", "", "19", null);
  const cake = await addProduct(owner, "Cake Course", "", "49", null);
  if (!bread.ok || !cake.ok) throw new Error("No synthetic products");
  await setProductImage(owner, bread.product.id, picture(1));
  await setProductImage(owner, cake.product.id, picture(2));
  const check = accessCheck((await storeForEmail(owner))!) as AccessCheck & { pictureIds?: string[] };
  is("each missing description's product id, in the same order as its title", [check.pictures.missing, check.pictureIds], [["Bread Book", "Cake Course"], [bread.product.id, cake.product.id]]);

  part("The warning offers each fix in one click");
  const drawn = renderToStaticMarkup(StoreAccessCheck({ check: { ...check, links: { vague: [{ id: "lnk1", title: "Click here" }] } } as AccessCheck })!);
  is("a link per product that opens its picture's description", [`href="#alt-${bread.product.id}"`, `href="#alt-${cake.product.id}"`].every((href) => drawn.includes(href)), true);
  is("which says what it does, by product", /Describe the picture of Bread Book/.test(drawn) && /Describe the picture of Cake Course/.test(drawn), true);
  is("a link per vague link that opens its words", drawn.includes('href="#edit-link-lnk1"') && /Change the words of “Click here”/.test(drawn), true);

  part("The product and link editors answer those links, and only when pressed");
  const products = readFileSync("components/product-editor.tsx", "utf8");
  const links = readFileSync("components/link-editor.tsx", "utf8");
  is("the product editor opens the product and focuses its picture's description", /useFixLink\("alt-",/.test(products), true);
  is("the link editor opens the link and focuses its words", /useFixLink\("edit-link-",/.test(links), true);

  part("The hook in a browser");
  const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const bundle=await build({stdin:{contents:[
 'import React, {useState} from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {useFixLink} from "@/components/use-fix-link";',
 'function Editor(){const [open,setOpen]=useState(null);window.__opened=open;',
 ' useFixLink("alt-",(id)=>id==="p1"?(setOpen(id),"alt-"+id):null);',
 ' return React.createElement("div",null,React.createElement("a",{href:"#alt-p1",id:"fix"},"Describe the picture of Bread Book"),React.createElement("a",{href:"#alt-gone",id:"gone"},"Describe the picture of Gone"),open?React.createElement("label",null,"What the picture shows",React.createElement("input",{id:"alt-"+open,defaultValue:""})):null);}',
 'createRoot(document.getElementById("root")).render(React.createElement(Editor));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'});
async function launch(){const options={headless:true,args:['--no-sandbox']};if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});try{return await chromium.launch(options);}catch(first){try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}}}
let browser;const out={};
try{
 browser=await launch();
 const page=await browser.newPage();
 await page.route('**/*',route=>route.abort());
 await page.setContent('<!doctype html><html lang="en"><body><div id="root"></div></body></html>');
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.waitForTimeout(200);
 out.before=await page.evaluate(()=>({field:!!document.querySelector('input'),focus:document.activeElement?.tagName}));
 await page.focus('#fix');
 await page.keyboard.press('Enter');
 await page.waitForTimeout(300);
 out.after=await page.evaluate(()=>({focus:document.activeElement?.id,value:document.activeElement?.value,hash:location.hash}));
 await page.click('#gone');
 await page.waitForTimeout(200);
 out.gone=await page.evaluate(()=>({focus:document.activeElement?.id}));
}finally{if(browser)await browser.close();}
console.log(JSON.stringify(out));
`;
  let result: { before: { field: boolean; focus: string }; after: { focus: string; value: string; hash: string }; gone: { focus: string } } | null = null;
  try {
    result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 60_000, maxBuffer: 8_000_000 }));
  } catch {
    result = null;
  }
  is("the hook runs in a browser", result !== null, true);
  if (result) {
    is("nothing is opened before the press", result.before.field, false);
    is("pressed from the keyboard, the product opens with the focus in its picture's description", result.after.focus, "alt-p1");
    is("nothing is written in it", result.after.value, "");
    is("a product not on this page is left to the link as it is", result.gone.focus, "gone");
  }
  done();
}

void main();
