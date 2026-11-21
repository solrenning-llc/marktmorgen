/** Declining a real keyboard navigation keeps the exact welcome-video draft. */
export async function checkIntroDraftProtection({page,is,label}){
 const before=page.url(),input=page.locator("#intro-url");
 const value=()=>input.evaluateAll(nodes=>nodes.map(node=>node.value));
 const draft=await value();
 is("unsaved intro protects unload "+label,await page.evaluate(()=>!window.dispatchEvent(new Event("beforeunload",{cancelable:true}))),true);
 const notices=[];
 const dismiss=async dialog=>{notices.push(dialog.message());await dialog.dismiss();};
 page.on("dialog",dismiss);
 try{const path=page.getByRole("link",{name:"Path",exact:true});await path.focus();await path.press("Enter");}finally{page.off("dialog",dismiss);}
 is("unsaved intro asks before leaving "+label,notices,["You have changes that are not saved. Leave without saving them?"]);
 is("staying keeps intro document "+label,page.url(),before);
 is("staying keeps exact intro draft "+label,await value(),draft);
}

/** Synthetic local fixture only; every intro POST is intercepted and no video is opened. */
export async function checkIntroAcknowledgment({browser,LOCAL,fixture,axeSource,is}){
 const sources=[
  {url:"https://youtu.be/abcdefghijk",video:{provider:"youtube",id:"abcdefghijk",hash:""}},
  {url:"https://vimeo.com/123456789/abcdef1234",video:{provider:"vimeo",id:"123456789",hash:"abcdef1234"}},
  {url:"https://www.loom.com/share/0123456789abcdef0123456789abcdef",video:{provider:"loom",id:"0123456789abcdef0123456789abcdef",hash:""}}
 ];
 const cases=[
  {name:"HTTP failure",status:500,reply:v=>({ok:true,intro:v})},
  {name:"truthy ok",reply:v=>({ok:"true",intro:v})},
  {name:"missing snapshot",reply:()=>({ok:true})},
  {name:"null snapshot",reply:()=>({ok:true,intro:null})},
  {name:"wrong provider",reply:v=>({ok:true,intro:{...v,provider:"other"}})},
  {name:"wrong id",reply:v=>({ok:true,intro:{...v,id:"different"}})},
  {name:"wrong hash",reply:v=>({ok:true,intro:{...v,hash:"different"}})},
  {name:"contradictory error",reply:v=>({ok:true,intro:v,error:"server_error"})},
  {name:"array response",reply:v=>[{ok:true,intro:v}]},
  {name:"malformed JSON",raw:"<html>Error</html>"},
  {name:"lost response",abort:true},
  {name:"confirmed",reply:v=>({ok:true,intro:v}),confirmed:true}
 ];
 for(const width of [390,1280])for(const source of sources){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let work=null,requests=0;
   await page.route("**/api/store/intro",async route=>{
    if(!work)throw Error("Unexpected intro write");
    requests++;const item=work;await item.held;
    if(item.scenario.abort){await route.abort("failed");return;}
    await route.fulfill({status:item.scenario.status??200,contentType:"application/json",body:item.scenario.raw??JSON.stringify(item.scenario.reply(source.video))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.waitForLoadState("networkidle");
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   await page.addScriptTag({content:axeSource});
   const input=page.getByLabel("Welcome video (optional)",{exact:true});const form=input.locator("..");
   for(const scenario of cases){
    await input.fill(source.url);
    await page.waitForFunction(provider=>document.querySelector("#intro-note")?.textContent?.includes("A "+provider+" video, under your name."),{youtube:"YouTube",vimeo:"Vimeo",loom:"Loom"}[source.video.provider]);
    if(scenario===cases[0])await checkIntroDraftProtection({page,is,label:"local draft/"+source.video.provider+"/"+width});
    let release;const held=new Promise(resolve=>{release=resolve;});work={scenario,held};
    const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/intro");seen.catch(()=>{});
    // Read the leave guard in the very microtask the saved toast enters the page: a reading after the toast is
    // found can come after React's effect cleanup or before it, so only this one is the same on every run.
    if(scenario.confirmed)await page.evaluate(()=>{
     delete window.__introGuardAtToast;
     const watch=new MutationObserver(()=>{
      if([...document.querySelectorAll(".nb-toast-region [role=status]")].some(node=>node.textContent?.includes("Welcome video settings saved."))){
       window.__introGuardAtToast=!window.dispatchEvent(new Event("beforeunload",{cancelable:true}));watch.disconnect();
      }
     });
     watch.observe(document.body,{childList:true,subtree:true,characterData:true});
    });
    const name=source.video.provider+"/"+scenario.name+"/"+width;
    try{
     await form.getByRole("button",{name:"Save the video",exact:true}).click();
     is("intro request preserved "+name,(await seen).postDataJSON(),{url:source.url});
     is("intro locks pending input "+name,await input.isDisabled(),true);
     is("intro announces busy "+name,await form.getAttribute("aria-busy"),"true");
    }finally{release();}
    if(scenario.confirmed){
     await page.locator(".nb-toast-region [role=status]").getByText("Welcome video settings saved.",{exact:true}).waitFor({state:"attached"});
     is("confirmed intro had released unload protection when its toast appeared "+name,await page.evaluate(()=>window.__introGuardAtToast),false);
     is("confirmed intro releases unload protection "+name,await page.evaluate(()=>!window.dispatchEvent(new Event("beforeunload",{cancelable:true}))),false);
    }else{
     const alert=form.getByRole("alert");await alert.waitFor();
     is("intro uncertainty is honest "+name,(await alert.innerText()).includes("Reload this page to check before trying again"),true);
     is("intro draft preserved "+name,await input.inputValue(),source.url);
     is("intro unlocks after refusal "+name,await input.isEnabled(),true);
     is("intro no false success "+name,await page.getByText("Welcome video settings saved.",{exact:true}).count(),0);
     if(["HTTP failure","malformed JSON","lost response"].includes(scenario.name))await checkIntroDraftProtection({page,is,label:name});
     const contrast=await alert.evaluate(async node=>{const r=await window.axe.run(node,{runOnly:{type:"rule",values:["color-contrast-enhanced"]}});return {violations:r.violations.map(v=>v.id),incomplete:r.incomplete.map(v=>v.id),passed:r.passes.some(v=>v.id==="color-contrast-enhanced")};});
     is("intro alert contrast "+name,contrast,{violations:[],incomplete:[],passed:true});
    }
    is("intro document fits "+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   }
   is("all intro POSTs intercepted "+source.video.provider+"/"+width,requests,cases.length);
  }finally{await context.close();}
 }
}
