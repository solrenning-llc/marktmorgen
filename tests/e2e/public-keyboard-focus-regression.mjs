import assert from "node:assert/strict";
import {checkPublicKeyboardCycle} from "./accessibility-public-keyboard.mjs";

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
  console.log("AX2_KEYBOARD_FOCUS_REGRESSIONS:"+JSON.stringify({coveredThirteenthRejected:true,clearThirteenPassed:true,wrappedInlinePassed:true,scope:"Native focus and fragment-center hit tests in disposable documents; not a visual contrast or full obstruction audit."}));
 } finally {await context.close();}
}
