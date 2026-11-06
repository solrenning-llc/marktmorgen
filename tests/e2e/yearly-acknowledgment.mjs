import {waitForReactChangeHandler} from "./react-hydration.mjs";

/** Only intercepted yearly offer settings; no email or subscription switch occurs. */
export async function checkYearlyAcknowledgment({browser,LOCAL,fixture,is}){
 const draft="  10   Rue Étoile, Montréal  ",canonical="10 Rue Étoile, Montréal";
 const cases=[
 {name:"HTTP",status:500,reply:v=>v},{name:"truthy",reply:v=>({...v,ok:"true"})},
 {name:"missing",reply:()=>({ok:true})},{name:"wrong state",reply:v=>({...v,yearlyAsk:{...v.yearlyAsk,on:!v.yearlyAsk.on}})},
 {name:"wrong address",reply:v=>({...v,yearlyAsk:{...v.yearlyAsk,address:"other"}})},
 {name:"null",reply:()=>null},{name:"array",reply:v=>[v]},
 {name:"contradiction",reply:v=>({...v,error:"server_error"})},
 {name:"malformed",raw:"invalid"},{name:"lost",abort:true},
 {name:"inherited",reply:()=>({ok:false,error:"__proto__"})},
 {name:"confirmed",reply:v=>v,confirmed:true}
 ];
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let pending=null,requests=0;
   await page.route("**/api/store/yearly-ask",async route=>{
    if(!pending)throw Error("Unexpected yearly offer settings write");requests++;
    const work=pending,input=route.request().postDataJSON();await work.release;
    if(work.scenario.abort){await route.abort("failed");return;}
    await route.fulfill({status:work.scenario.status??200,contentType:"application/json",body:work.scenario.raw??JSON.stringify(work.scenario.reply({ok:true,yearlyAsk:{on:input.on,address:canonical}}))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   const section=page.locator("[data-yearly-ask-editor]");await section.waitFor();
   const check=section.locator("#yearly-ask-on"),address=section.locator("#yearly-ask-address");
   await waitForReactChangeHandler(page,check);
   for(const on of [true,false]){
    await check.setChecked(on);await address.fill(draft);
    for(const scenario of cases){
     let release;const held=new Promise(resolve=>{release=resolve;});pending={scenario,release:held};
     const name=on+"/"+scenario.name+"/"+width;
     const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/yearly-ask");seen.catch(()=>{});
     try{
      await section.getByRole("button",{name:"Save",exact:true}).click();
      is("yearly settings exact request "+name,(await seen).postDataJSON(),{on,address:draft});
      is("yearly settings busy "+name,await section.getAttribute("aria-busy"),"true");
      for(const field of await section.locator("input,button").all())is("yearly pending controls lock "+name,await field.isDisabled(),true);
     }finally{release();}
     await page.waitForFunction(()=>document.querySelector("[data-yearly-ask-editor]")?.getAttribute("aria-busy")==="false");
     if(scenario.confirmed){
      is("yearly confirms "+name,await section.getByRole("alert").count(),0);
      is("yearly normalized saved address "+name,await address.inputValue(),canonical);
      is("yearly confirmed status "+name,await section.locator(".tag").innerText(),on?"Email on":"Email off");
     }else{
      const alert=section.getByRole("alert");await alert.waitFor();
      is("yearly uncertainty honest "+name,(await alert.innerText()).includes("Reload this page to check before trying again"),true);
      is("yearly creator address preserved "+name,await address.inputValue(),draft);
      is("yearly creator choice preserved "+name,await check.isChecked(),on);
      is("yearly saved status preserved "+name,await section.locator(".tag").innerText(),on?"Email off":"Email on");
     }
     is("yearly settings fit "+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
   }
   is("all yearly writes intercepted "+width,requests,24);
  }finally{await context.close();}
 }
}
