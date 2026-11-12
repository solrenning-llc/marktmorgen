import {waitForReactChangeHandler,waitForReactHydrated} from "./react-hydration.mjs";

/** Every creator-pick save/removal is intercepted, with no buyer or public data writes. */
export async function checkPairsAcknowledgment({browser,LOCAL,fixture,is}){
 const cases=[
 {name:"HTTP",status:500,reply:value=>value},{name:"truthy",reply:value=>({...value,ok:"true"})},
 {name:"missing",reply:()=>({ok:true})},{name:"wrong id",reply:value=>({...value,id:"other"})},
 {name:"wrong picks",reply:value=>({...value,pairs:["other"]})},{name:"null",reply:()=>null},
 {name:"array",reply:value=>[value]},{name:"contradiction",reply:value=>({...value,error:"server_error"})},
 {name:"malformed",raw:"invalid"},{name:"lost",abort:true},
 {name:"inherited",reply:()=>({ok:false,error:"__proto__"})},
 {name:"confirmed",reply:value=>value,confirmed:true}
 ];
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let pending=null,requests=0;
   await page.route("**/api/store/pairs",async route=>{
    if(!pending)throw Error("Unexpected creator-pick write");requests++;
    const work=pending,input=route.request().postDataJSON(),value={ok:true,id:input.id,pairs:input.pairs};
    await work.release;if(work.scenario.abort){await route.abort("failed");return;}
    await route.fulfill({status:work.scenario.status??200,contentType:"application/json",body:work.scenario.raw??JSON.stringify(work.scenario.reply(value))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   const toggle=page.locator('button[aria-controls="product-panel-'+fixture.product+'"]');
   await toggle.waitFor();await page.waitForFunction(el=>typeof el.onclick==="function",await toggle.elementHandle());
   // PAIRS_INITIAL_SELECTION in WebKit showed the first choice undone by its own input event: the
   // studio root was still hydrating, the event made React finish at once, and that commit put the
   // server value back into the select, so "Save picks" stayed disabled. Act only after the commit.
   await waitForReactHydrated(page,toggle);
   if(await toggle.getAttribute("aria-expanded")!=="true")await toggle.click();
   const section=page.locator('[data-pairs-editor="'+fixture.product+'"]');await section.waitFor();
   is("creator-pick three labeled selectors "+width,await section.locator("select").count(),3);
   const first=section.locator("select").nth(0),target=await first.locator('option:not([value=""])').first().getAttribute("value");
   await section.evaluate(root=>{
    window.__pairsSelectionEvents=[];
    for(const type of ["input","change"])root.addEventListener(type,event=>{
     if(window.__pairsSelectionEvents.length>=8)return;
     const select=event.target;
     window.__pairsSelectionEvents.push({type,trusted:event.isTrusted,value:select?.value,selectedIndex:select?.selectedIndex,buttonDisabled:root.querySelector("button")?.disabled});
    },true);
   });
   await waitForReactChangeHandler(page,first);
   await first.selectOption(target);
   console.log("PAIRS_INITIAL_SELECTION",JSON.stringify(await section.evaluate((root,target)=>({
    target,events:window.__pairsSelectionEvents,
    selects:Array.from(root.querySelectorAll("select"),s=>({value:s.value,selectedIndex:s.selectedIndex,disabled:s.disabled})),
    buttonDisabled:root.querySelector("button")?.disabled,busy:root.getAttribute("aria-busy"),
   }),target)));
   for(const remove of [false,true]){
    if(remove)await first.selectOption("");
    for(const scenario of cases){
     let release;const held=new Promise(resolve=>{release=resolve;});pending={scenario,release:held};
     const name=remove+"/"+scenario.name+"/"+width;
     const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/pairs");seen.catch(()=>{});
     try{
      await section.getByRole("button",{name:"Save picks",exact:true}).click();
      is("creator-pick request exact "+name,(await seen).postDataJSON(),{id:fixture.product,pairs:remove?[]:[target]});
      is("creator-pick busy "+name,await section.getAttribute("aria-busy"),"true");
      for(const field of await section.locator("select,button").all())is("creator-pick controls lock "+name,await field.isDisabled(),true);
     }finally{release();}
     await page.waitForFunction(id=>document.querySelector('[data-pairs-editor="'+id+'"]')?.getAttribute("aria-busy")==="false",fixture.product);
     if(scenario.confirmed){
      is("creator-pick confirms without error "+name,await section.getByRole("alert").count(),0);
      is("creator-pick saved baseline "+name,await section.getByRole("button",{name:"Save picks",exact:true}).isDisabled(),true);
     }else{
      const alert=section.getByRole("alert");await alert.waitFor();
      is("creator-pick uncertainty honest "+name,(await alert.innerText()).includes("Reload this page to check before trying again"),true);
      is("creator-pick draft retained "+name,await first.inputValue(),remove?"":target);
     }
     is("creator-pick controls fit "+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
   }
   is("all creator-pick writes intercepted "+width,requests,24);
  }finally{await context.close();}
 }
}
