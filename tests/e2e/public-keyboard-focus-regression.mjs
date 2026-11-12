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

function helpFocusInsetSource(){
 const css=readFileSync(new URL("../../app/help/focus-scroll.css",import.meta.url),"utf8");
 assert.match(css,/scroll-padding-bottom:\s*3rem/,"help document keeps a native-focus bottom inset");
 assert.match(css,/scroll-margin-block:\s*3rem/,"help disclosures carry the same native-focus clearance");
 return css;
}

function topicFocusInsetSource(){
 const css=readFileSync(new URL("../../app/platform/[slug]/focus-scroll.css",import.meta.url),"utf8");
 assert.match(css,/\[data-topic-focus-inset\]\s+a\.card\s*\{[^}]*scroll-margin-block:\s*3rem/s,"linked topic cards keep native-focus clearance");
 return css;
}

function linkedTopicFeatureClasses(){
 const source=readFileSync(new URL("../../components/topic-page.tsx",import.meta.url),"utf8");
 const classes=source.match(/<Link href=\{item\.href\} className="([^"]+)"/)?.[1];
 assert.ok(classes,"the linked feature card is available to the geometry fixture");
 return classes;
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
   const helpCss=helpFocusInsetSource();
   await tall.setViewportSize({width:1280,height:720});
   await tall.setContent(`<!doctype html><html data-reveal="on"><head><style>${style}:root{--ease:linear}${source.css}${helpCss}</style></head><body><button>Before the section</button><div style="height:1000px"></div><section class="reveal" data-help-section style="height:9305px"><div style="height:8500px"></div><details open data-help-item><summary>Inside a tall help section</summary></details></section><button>After the section</button></body></html>`);
   await tall.addScriptTag({content:source.script});
   assert.equal(await tall.locator(".reveal").evaluate(node=>getComputedStyle(node).opacity),"0","below-fold section starts unrevealed");
   assert.deepEqual(await tall.locator("summary").evaluate(node=>({bottom:getComputedStyle(document.documentElement).scrollPaddingBottom,margin:getComputedStyle(node).scrollMarginBlock})),{bottom:"48px",margin:"48px"},"real help focus insets are active in the browser fixture");
   let revealObserved=false;
   await checkPublicKeyboardCycle({page:tall,path:"real-reveal-tall-section",is,onFocusSettled:async()=>{
    if(revealObserved||!await tall.locator("summary").evaluate(node=>document.activeElement===node))return;
    await tall.waitForFunction(()=>{
     const node=document.querySelector(".reveal"),style=getComputedStyle(node);
     return node.classList.contains("is-in")&&style.opacity==="1"&&style.transform==="none";
    },undefined,{timeout:3000});
    revealObserved=true;
   }});
   assert.equal(revealObserved,true,"the reveal transition settles while native focus remains inside the tall section");
  }finally{await tall.close();}
  // Firefox left a short linked topic card at 457.2px tall because h-full
  // stretched it to the height of the much longer card beside it. Its top was
  // 493.08px in a 720px viewport, putting its center 1.68px below the viewport.
  // Reproduce that two-column row with the real linked-card classes and the
  // page-scoped stylesheet, without assigning focus or scrolling from script.
  const tallCard=await context.newPage();
  try{
   const topicCss=topicFocusInsetSource();
   const topicClasses=linkedTopicFeatureClasses();
   await tallCard.setViewportSize({width:1280,height:720});
   await tallCard.setContent(`<style>${style}${topicCss}.fixture-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.fixture-peer{height:457.2px}.cell{min-width:0}.card{display:flex}.h-full{height:100%}</style><div style="height:4218px"></div><div data-topic-focus-inset class="fixture-grid"><div class="fixture-peer">A long card beside the link</div><div class="cell"><a class="${topicClasses}" href="#end">A short linked topic card</a></div></div><div id="end">End</div>`);
   assert.equal(await tallCard.locator("a.card").evaluate(node=>getComputedStyle(node).scrollMarginBlock),"48px","real topic-card focus inset is active");
   await checkPublicKeyboardCycle({page:tallCard,path:"real-topic-tall-card",is});
  }finally{await tallCard.close();}
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
  console.log("AX2_KEYBOARD_FOCUS_REGRESSIONS:"+JSON.stringify({coveredThirteenthRejected:true,clearThirteenPassed:true,wrappedInlinePassed:true,tallSectionRevealed:true,tallTopicCardPassed:true,opaqueRadiosPassed:2,transparentRadioRejected:true,scope:"Native focus and fragment-center hit tests in disposable documents, including the real reveal and page-scoped focus CSS; not a visual contrast or full obstruction audit."}));
 } finally {await context.close();}
}
