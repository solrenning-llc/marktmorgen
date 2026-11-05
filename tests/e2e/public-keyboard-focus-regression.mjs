import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";
import {checkPublicKeyboardCycle} from "./accessibility-public-keyboard.mjs";

function revealFixtureSource(){
 const {transpileModule,ModuleKind}=createRequire(import.meta.url)("typescript");
 const compiled=transpileModule(readFileSync(new URL("../../lib/reveal-scripts.ts",import.meta.url),"utf8"),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText;
 const exports={};runInNewContext(compiled,{exports});
 const css=readFileSync(new URL("../../app/globals.css",import.meta.url),"utf8");
 const hidden=css.match(/:root\[data-reveal="on"\] \.reveal \{[^}]*\}/)?.[0];
 const shown=css.match(/:root\[data-reveal="on"\] \.reveal\.is-in \{[^}]*\}/)?.[0];
 assert.ok(hidden&&shown&&typeof exports.REVEAL_WATCH==="string","real reveal script and CSS are available");
 return {script:exports.REVEAL_WATCH,css:hidden+shown};
}

/** Disposable documents exercise the real helper with native keys, without app writes. */
export async function checkPublicKeyboardFocusRegressions({browser}) {
 const context=await browser.newContext({viewport:{width:390,height:900},serviceWorkers:"block"});
 const is=(label,actual,expected)=>assert.deepEqual(actual,expected,label);
 const style="body{margin:8px}button{display:block;height:44px;margin:2px 0} :focus-visible{outline:3px solid black;outline-offset:2px}";
 const buttons=Array.from({length:13},(_,index)=>`<button id="target-${index}"><span>Target ${index+1}</span></button>`).join("");
 try {
  // Only the thirteenth target is covered: checking the first ten cannot catch it.
  const covered=await context.newPage();
  await covered.setContent(`<style>${style}#cover{position:fixed;background:white;z-index:10}</style>${buttons}<div id="cover">Cover</div>`);
  await covered.evaluate(()=>{
   const target=document.querySelector("#target-12"),cover=document.querySelector("#cover"),box=target.getBoundingClientRect();
   Object.assign(cover.style,{left:box.left+"px",top:box.top+"px",width:box.width+"px",height:box.height+"px"});
  });
  await assert.rejects(()=>checkPublicKeyboardCycle({page:covered,path:"synthetic-covered-thirteenth-target",is}),/Keyboard focus obscured/);
  await covered.close();

  // Descendant hits belong to the focused button; they must not be false failures.
  const clear=await context.newPage();
  await clear.setViewportSize({width:390,height:320});
  await clear.setContent(`<style>${style}</style>${buttons}`);
  await clear.evaluate(()=>{window.__fixtureScrolled=false;addEventListener("scroll",()=>{if(scrollY>0)window.__fixtureScrolled=true;},{passive:true});});
  await checkPublicKeyboardCycle({page:clear,path:"synthetic-clear-thirteen-targets",is});
  assert.ok(await clear.evaluate(()=>window.__fixtureScrolled),"native keyboard traversal scrolls the short viewport");
  await clear.close();

  // The center of a wrapped link's union box can fall between its painted lines.
  const wrapped=await context.newPage();
  await wrapped.setContent(`<style>${style}p{width:180px;font:20px/2 sans-serif}a:focus-visible{outline:3px solid black}</style><p><a href="#end">A link that wraps across more than one line</a></p><div id="end">End</div>`);
  assert.ok(await wrapped.locator("a").evaluate(node=>node.getClientRects().length>1),"wrapped fixture has multiple rendered fragments");
  await checkPublicKeyboardCycle({page:wrapped,path:"synthetic-wrapped-inline-link",is});
  await wrapped.close();
  // The real help trace expanded one section to 9305px in a 720px viewport.
  // Exercise the actual initial observer and stylesheet, with native keys.
  const tall=await context.newPage();
  try{
   const source=revealFixtureSource();
   await tall.setViewportSize({width:1280,height:720});
   await tall.setContent(`<!doctype html><html data-reveal="on"><head><style>${style}:root{--ease:linear}${source.css}</style></head><body><button>Before the section</button><div style="height:1000px"></div><section class="reveal" style="height:9305px"><div style="height:8500px"></div><button>Inside a tall section</button></section><button>After the section</button></body></html>`);
   await tall.addScriptTag({content:source.script});
   assert.equal(await tall.locator(".reveal").evaluate(node=>getComputedStyle(node).opacity),"0","below-fold section starts unrevealed");
   await checkPublicKeyboardCycle({page:tall,path:"real-reveal-tall-section",is});
   await tall.waitForFunction(()=>{
    const node=document.querySelector(".reveal"),style=getComputedStyle(node);
    return node.classList.contains("is-in")&&style.opacity==="1"&&style.transform==="none";
   },undefined,{timeout:3000});
  }finally{await tall.close();}
  for(const color of ["rgb(0, 0, 0)","rgb(255, 255, 0)","rgba(0, 0, 0, 0)"]){
   const radio=await context.newPage();
   try{
    // Match the product's native-radio rule: WebKit can focus an option after
    // an arrow without matching :focus-visible. The painted ring is required
    // by the helper in either case, including the transparent negative control.
    await radio.setContent(`<style>input{width:44px;height:44px}input:focus{outline:3px solid ${color};outline-offset:2px}</style><input type="radio" name="choice" aria-label="First" checked><input type="radio" name="choice" aria-label="Second">`);
    const journey=()=>checkPublicKeyboardCycle({page:radio,path:"synthetic-radio-outline-"+color,is});
    if(color.startsWith("rgba"))await assert.rejects(journey,/native keyboard focus is visible/);
    else await journey();
   }finally{await radio.close();}
  }
  console.log("AX2_KEYBOARD_FOCUS_REGRESSIONS:"+JSON.stringify({coveredThirteenthRejected:true,clearThirteenPassed:true,wrappedInlinePassed:true,tallSectionRevealed:true,opaqueRadiosPassed:2,transparentRadioRejected:true,scope:"Native focus and fragment-center hit tests in disposable documents, including the real reveal script/CSS; not a visual contrast or full obstruction audit."}));
 } finally {await context.close();}
}
