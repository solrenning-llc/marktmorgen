// Adapted from Guidepup examples at 274efb894cf26b2962990786723b76cc71fa785d.
// MIT copyright and permission notice: ./GUIDEPUP-LICENSE.txt.
// Navigation setup only; assertions run after the temporary marker is removed.
import {voiceOverKeyCodeCommands,MacOSKeyCodes,macOSActivateId,NVDAKeyCodeCommands,WindowsKeyCodes,WindowsModifiers} from "@guidepup/guidepup";
const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
export async function navigateToContent(reader,page,kind,foreground){
 await page.bringToFront();
 if(kind==="nvda"){
  await reader.perform(NVDAKeyCodeCommands.exitFocusMode,{capture:false});
  // The active Playwright tab does not prove NVDA's foreground application.
  const pageTitle=(await page.title()).replace(/\s+/g," ").trim().toLowerCase();
  if(!pageTitle)throw Error("NVDA browser focus requires a nonempty page title");
  // Diagnostic snapshots do not replace NVDA's existing foreground gate.
  async function observeNativeForeground(stage){
   if(!foreground)return null;
   try{
    const title=await foreground.read();
    console.log("AX2_NVDA_NATIVE_FOREGROUND:"+JSON.stringify({stage,title}));
    return title;
   }catch(error){
    console.error("AX2_NVDA_NATIVE_FOREGROUND_UNKNOWN:"+JSON.stringify({stage,error:String(error)}));
    return null;
   }
  }
  let switches=0;
  async function confirmForeground(stage,canSwitch=true,activatePage=false){
   let changed=false,activated=false;
   for(;;){
    await reader.perform(NVDAKeyCodeCommands.reportTitle);
    const windowTitle=(await reader.lastSpokenPhrase()).replace(/\s+/g," ").trim().toLowerCase();
    console.log("AX2_NVDA_WINDOW_FOCUS:"+JSON.stringify({attempt:switches,stage,pageTitle,windowTitle}));
    if(windowTitle.startsWith(pageTitle))return changed;
    if(activatePage&&!activated){
     // The exact native title check observed that another application owns the
     // foreground. Reactivate the already selected page, then prove its title;
     // Playwright focus alone never counts as evidence.
     activated=true;changed=true;
     await page.bringToFront();
     continue;
    }
    if(!canSwitch||switches===10)throw Error("NVDA foreground window did not match the synthetic page title ("+stage+")");
    switches++;
    await reader.perform({keyCode:[WindowsKeyCodes.Escape],modifiers:[WindowsModifiers.Alt]},{capture:false});
    await new Promise(resolve=>setTimeout(resolve,500));
    changed=true;
   }
  }
  await confirmForeground("before preparation");
  await page.locator("body").focus();
  await observeNativeForeground("after body focus");
  await page.locator("body").click({position:{x:1,y:1}});
  await observeNativeForeground("after body click");
  await page.locator("body").blur();
  await observeNativeForeground("after body blur");
  await reader.perform(NVDAKeyCodeCommands.readNextFocusableItem,{capture:false});
  await observeNativeForeground("after next focusable item");
  await pause();
  await reader.perform(NVDAKeyCodeCommands.toggleBetweenBrowseAndFocusMode,{capture:false});
  await observeNativeForeground("after first browse-focus toggle");
  await pause();
  await reader.perform(NVDAKeyCodeCommands.toggleBetweenBrowseAndFocusMode,{capture:false});
  await observeNativeForeground("after second browse-focus toggle");
  await reader.perform(NVDAKeyCodeCommands.exitFocusMode,{capture:false});
  await observeNativeForeground("after exit focus mode");
  await reader.perform({keyCode:[WindowsKeyCodes.Home],modifiers:[WindowsModifiers.Control]});
  const resetForeground=await observeNativeForeground("after document reset");
  let dismissedSearch=false;
  if(typeof resetForeground==="string"&&resetForeground.replace(/\s+/g," ").trim().toLowerCase()==="search"){
   // Windows Search can take the foreground when Ctrl+Home is sent. Close
   // only that exactly observed window, then let NVDA's title gate prove the
   // browser is back; the native snapshot itself never counts as approval.
   await reader.perform({keyCode:[WindowsKeyCodes.Escape],modifiers:[]},{capture:false});
   dismissedSearch=true;
  }
  // Preparation can lose native focus after the initial title was proved.
  // Reacquire it within the same ten-switch budget, never retry a heading assertion.
  const foregroundChanged=await confirmForeground("after preparation",true,true);
  if(dismissedSearch||foregroundChanged){
   await reader.perform({keyCode:[WindowsKeyCodes.Home],modifiers:[WindowsModifiers.Control]});
   await observeNativeForeground("after final document reset");
   await confirmForeground("after final document reset",false);
  }
  return;
 }
 await macOSActivateId("org.webkit.Playwright");
 await page.bringToFront();
 const cancel=()=>reader.perform({keyCode:MacOSKeyCodes.Control},{capture:false});
 try{
  await page.evaluate(()=>{
   const marker=document.createElement("input");
   marker.id="__guidepup_marker__";marker.type="text";marker.value="Guidepup Marker";
   marker.readOnly=true;marker.tabIndex=-1;marker.autocomplete="off";
   marker.setAttribute("aria-label","Guidepup Marker");
   marker.style.cssText="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap";
   document.body.prepend(marker);
  });
  let opened=false;
  for(let attempt=0;attempt<3;attempt++){
   await cancel();await pause();
   await reader.perform({keyCode:MacOSKeyCodes.Escape},{capture:false});await pause();
   await reader.perform(voiceOverKeyCodeCommands.openItemChooser,{capture:true});
   if((await reader.lastSpokenPhrase()).toLowerCase().includes("item chooser")){opened=true;break;}
  }
  if(!opened)throw Error("VoiceOver item chooser was not announced");
  let selected=false;
  for(let attempt=0;attempt<3&&!selected;attempt++){
   for(const character of "web content"){
    await cancel();await pause();await reader.type(character,{capture:"initial"});
    if((await reader.lastSpokenPhrase()).toLowerCase().includes("web content")){selected=true;break;}
   }
   if(!selected)await reader.perform({keyCode:MacOSKeyCodes.Backspace},{capture:false});
  }
  if(!selected)throw Error("VoiceOver web content item was not announced");
  await reader.perform({keyCode:MacOSKeyCodes.Enter},{capture:false});
  await reader.interact({capture:false});await pause();
  await reader.next();
 }finally{
  await page.evaluate(()=>document.getElementById("__guidepup_marker__")?.remove());
 }
 // Item chooser interaction can leave the cursor at a later heading.
 // Establish the area start only after removing the temporary marker.
 await reader.perform(voiceOverKeyCodeCommands.moveToAreaTop,{capture:false});
}
