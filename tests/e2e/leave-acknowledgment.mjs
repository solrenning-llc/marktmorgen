import {waitForReactChangeHandler} from "./react-hydration.mjs";

/** Synthetic cancellation-question settings; no member cancellation or provider call. */
export async function checkLeaveAcknowledgment({browser,LOCAL,fixture,is}){
 const draft="  Les appels   sont trop tard  ",canonical="Les appels sont trop tard";
 const reasons=["too_expensive","unused","missing_features","switched_service","too_complex","low_quality","customer_service","other"];
 const cases=[
 {name:"HTTP",status:500,reply:v=>v},{name:"truthy",reply:v=>({...v,ok:"true"})},
 {name:"missing",reply:()=>({ok:true})},{name:"null",reply:()=>null},{name:"array",reply:v=>[v]},
 {name:"contradiction",reply:v=>({...v,error:"server_error"})},{name:"malformed",raw:"invalid"},
 {name:"lost",abort:true},{name:"inherited",reply:()=>({ok:false,error:"__proto__"})},
 {name:"wrong state",reply:v=>({...v,leaving:{...v.leaving,on:!v.leaving.on}})},
 {name:"wrong reasons",reply:v=>({...v,leaving:{...v.leaving,reasons:["other"]}})},
 {name:"wrong words",reply:v=>({...v,leaving:{...v.leaving,own:[{id:"own_abcdef",text:"Other"}]}})},
 {name:"invalid reason ID",reply:v=>({...v,leaving:{...v.leaving,own:[{id:"invalid",text:canonical}]}})},
 {name:"confirmed",reply:v=>v,confirmed:true}];
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let pending=null,requests=0;
   await page.route("**/api/store/leaving",async route=>{
    if(!pending)throw Error("Unexpected cancellation settings write");requests++;
    const work=pending,input=route.request().postDataJSON();await work.release;
    if(work.scenario.abort){await route.abort("failed");return;}
    const good={ok:true,leaving:{on:input.on,reasons,own:[{id:"own_abcdef",text:canonical}]}};
    await route.fulfill({status:work.scenario.status??200,contentType:"application/json",body:work.scenario.raw??JSON.stringify(work.scenario.reply(good))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   const section=page.locator("[data-leave-editor]");await section.waitFor();
   const onField=section.locator("#leave-on"),own=section.getByRole("textbox",{name:"Reason of your own 1",exact:true});
   await waitForReactChangeHandler(page,onField);
   await onField.check();await own.fill(draft);
   for(const on of [true,false]){
    await onField.setChecked(on);
    const scenarios=on?cases:[...cases.slice(0,-1),{name:"changed persisted ID",reply:v=>({...v,leaving:{...v.leaving,own:[{id:"own_123456",text:canonical}]}})},cases.at(-1)];
    for(const scenario of scenarios){
     let release;const held=new Promise(resolve=>{release=resolve;});pending={scenario,release:held};
     const name=on+"/"+scenario.name+"/"+width;
     const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/leaving");seen.catch(()=>{});
     try{
      await section.getByRole("button",{name:"Save",exact:true}).click();
      is("leave exact request and persistent ID "+name,(await seen).postDataJSON(),{on,reasons,own:on?[{text:draft}]:[{id:"own_abcdef",text:canonical}]});
      is("leave busy "+name,await section.getAttribute("aria-busy"),"true");
      for(const field of await section.locator("input,button").all())is("leave pending locked "+name,await field.isDisabled(),true);
     }finally{release();}
     await page.waitForFunction(()=>document.querySelector("[data-leave-editor]")?.getAttribute("aria-busy")==="false");
     if(scenario.confirmed){
      is("leave confirms "+name,await section.getByRole("alert").count(),0);
      is("leave canonical creator words "+name,await own.inputValue(),canonical);
      is("leave saved status "+name,await section.locator(".tag").innerText(),on?"On":"Off");
     }else{
      const alert=section.getByRole("alert");await alert.waitFor();
      is("leave honest uncertainty "+name,(await alert.innerText()).includes("Reload this page to check before trying again"),true);
      is("leave creator words retained "+name,await own.inputValue(),on?draft:canonical);
      is("leave saved status retained "+name,await section.locator(".tag").innerText(),on?"Off":"On");
     }
     is("leave draft choice retained "+name,await onField.isChecked(),on);
     is("leave settings fit "+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
   }
   is("all leave writes intercepted "+width,requests,29);
  }finally{await context.close();}
 }
}
