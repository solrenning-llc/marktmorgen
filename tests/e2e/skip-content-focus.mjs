import assert from "node:assert/strict";
import {readdirSync,readFileSync} from "node:fs";
import {join,relative} from "node:path";
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";

/** Every source declaration, including alternate/error branches and shared pages. */
export async function renderedContentDeclarations(root,development=false){
 const require=createRequire(join(root,"package.json"));
 const ts=require("typescript"),{build}=require("esbuild");
 const source=JSON.parse(readFileSync(join(root,"tsconfig.json"),"utf8")).compilerOptions.jsxImportSource??"react";
 const files=folder=>readdirSync(folder,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(folder,entry.name)):entry.name.endsWith(".tsx")?[join(folder,entry.name)]:[]);
 const mains=[];
 for(const file of [...files(join(root,"app")),...files(join(root,"components"))]){
  const ast=ts.createSourceFile(file,readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const visit=node=>{
   if((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&node.tagName.getText(ast)==="main"){
    const attrs=node.attributes.properties;
    const id=attrs.find(attr=>ts.isJsxAttribute(attr)&&attr.name.getText(ast)==="id");
    if(id&&id.initializer&&ts.isStringLiteral(id.initializer)&&id.initializer.text==="content"){
     const tab=attrs.find(attr=>ts.isJsxAttribute(attr)&&attr.name.getText(ast)==="tabIndex");
     const route=relative(root,file)+":"+(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1);
     assert.equal(attrs.some(ts.isJsxSpreadAttribute),false,"unreviewed main prop spread in "+route);
     mains.push({route,attributes:`id="content" ${tab?tab.getText(ast):""}`});
    }
   }
   ts.forEachChild(node,visit);
  };visit(ast);
 }
 assert.ok(mains.length>=120,"the full route inventory was traversed");
 const snippets=mains.map((main,index)=>`<main ${main.attributes} data-proof="${index}"><a href="#next">Continue</a></main>`);
 const built=await build({stdin:{contents:`import {renderToStaticMarkup} from 'react-dom/server';export const html=renderToStaticMarkup(<section>${snippets.join("")}</section>);`,loader:"tsx",resolveDir:root},bundle:true,platform:"node",format:"cjs",write:false,jsx:"automatic",jsxDev:development,jsxImportSource:source,alias:{"@":root},logLevel:"error"});
 const box={exports:{}};
 runInNewContext(built.outputFiles[0].text,{module:box,exports:box.exports,require,process,console,TextEncoder,TextDecoder,URL,setTimeout,clearTimeout,queueMicrotask});
 const rendered=[...String(box.exports.html).matchAll(/<main\b[^>]*>[\s\S]*?<\/main>/g)];
 assert.equal(rendered.length,mains.length,"no branch of the source inventory was omitted");
 return mains.map((main,index)=>({route:main.route,html:rendered[index][0]}));
}

/** Every emitted main contract gets native fragment focus with application JS off. */
export async function checkCompiledContentTargets({browser,root}){
 const declarations=await renderedContentDeclarations(root);
 const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:"block",viewport:{width:390,height:900}});
 let checked=0;
 try{
  for(const declaration of declarations){
   // A fresh document has a fresh native sequential-focus starting point.
   // Replacing a focused document's HTML can retain the old Tab cursor.
   const page=await context.newPage();
   try{
   await page.bringToFront();
   await page.setContent('<!doctype html><title>Source content focus contract</title><a href="#content">Skip</a>'+declaration.html);
   assert.equal(await page.locator('main#content').getAttribute("tabindex"),"-1",declaration.route);
   await page.keyboard.press("Tab");
   assert.ok(await page.locator('a[href="#content"]').evaluate(node=>node===document.activeElement),"native entry "+declaration.route);
   await page.keyboard.press("Enter");
   await page.waitForFunction(()=>document.activeElement===document.querySelector('main#content'),undefined,{timeout:3000});
   await page.keyboard.press("Tab");
   assert.ok(await page.locator('main#content').evaluate(node=>node.contains(document.activeElement)),"native continuation "+declaration.route);
   checked++;
   }finally{await page.close();}
  }
  assert.equal(checked,declarations.length);
  console.log("CONTENT_FOCUS_DECLARATIONS:"+JSON.stringify({declarations:declarations.length,nativeFocus:checked,applicationJavaScript:false,scope:"All real source main declarations compiled through the configured runtime and rendered on the server; isolated native contracts, not complete route journeys."}));
 }finally{await context.close();}
}


/** Native links where supplied; pages without one get an explicitly labelled destination-only probe. */
export async function checkContentFocusTarget({context,origin,path}){
 const page=await context.newPage();
 try{
  const response=await page.goto(origin+path,{waitUntil:"domcontentloaded",timeout:60000});
  assert.equal(response.status(),200,"real route is available: "+path);
  const main=page.locator('main#content');
  assert.equal(await main.count(),1,"one content destination: "+path);
  assert.equal(await main.getAttribute("tabindex"),"-1","server-rendered native focus destination: "+path);
  const skip=page.locator('a[href="#content"]').first();
  const supplied=await skip.count()>0;
  await page.bringToFront();
  if(supplied){
   let reached=false;
   for(let n=0;n<30;n++){
    await page.keyboard.press("Tab");
    if(await skip.evaluate(node=>node===document.activeElement)){reached=true;break;}
   }
   assert.ok(reached,"native Tab reaches the page's actual skip link: "+path);
   await page.keyboard.press("Enter");
  }else{
   // Do not invent a missing skip link or call this a native skip journey.
   // This separately proves the destination can receive focus with its new HTML attribute.
   await main.focus();
  }
  await page.waitForFunction(()=>document.activeElement===document.querySelector('main#content'),undefined,{timeout:3000});
  await page.keyboard.press("Tab");
  assert.ok(await main.evaluate(node=>node.contains(document.activeElement)),"next Tab continues inside the content: "+path);
  console.log("CONTENT_FOCUS_TARGET:"+JSON.stringify({path,nativeSkipLink:supplied,destinationFocus:true,nextTabInside:true}));
 }finally{await page.close();}
}
