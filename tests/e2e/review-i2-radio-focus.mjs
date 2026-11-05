import assert from "node:assert/strict";
import {chromium} from "playwright-core";
import {checkPublicKeyboardCycle} from "./accessibility-public-keyboard.mjs";
const browser=await chromium.launch(process.env.CHROMIUM?{executablePath:process.env.CHROMIUM}:{});
const is=(label,actual,expected)=>assert.deepEqual(actual,expected,label);
let blackPassed=false;
try {
 for(const [color,covered] of [["black",false],["rgb(1,1,1)",false],["rgb(1,1,1)",true]]) {
  const page=await browser.newPage({viewport:{width:390,height:320}});
  await page.setContent('<style>input{display:block;width:44px;height:44px;margin:8px}:focus{outline:3px solid '+color+'}#cover{position:fixed;z-index:99;background:white}</style><input type="radio" name="group" checked><input type="radio" name="group"><input id="last" type="radio" name="group">'+(covered?'<div id="cover">Cover</div>':''));
  if(covered)await page.evaluate(()=>{const b=document.querySelector("#last").getBoundingClientRect();Object.assign(document.querySelector("#cover").style,{left:b.left+"px",top:b.top+"px",width:b.width+"px",height:b.height+"px"});});
  const run=()=>checkPublicKeyboardCycle({page,path:"i2-radio-"+color+"-"+covered,is});
  if(covered)await assert.rejects(run,/Keyboard focus obscured/);
  else if(color==="black"){try{await run();blackPassed=true;}catch(error){console.log("BLACK_FALSE_REJECTION:"+error.message);}}
  else await run();
  await page.close();
 }
 assert.equal(blackPassed,true,"an opaque black radio outline must be accepted");
}finally{await browser.close();}
