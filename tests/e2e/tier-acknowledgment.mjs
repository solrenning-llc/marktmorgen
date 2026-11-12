import {waitForReactChangeHandler} from "./react-hydration.mjs";

/** Settings replies intercepted; no member switch, Stripe, email or payment occurs. */
export async function checkTierAcknowledgment({browser,LOCAL,fixture,is}){
 const cases=[
 {name:"HTTP",status:500,reply:v=>v},{name:"truthy",reply:v=>({...v,ok:"true"})},
 {name:"missing",reply:()=>({ok:true})},{name:"wrong tiers",reply:v=>({...v,tiers:["other"]})},
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
   await page.route("**/api/store/tiers",async route=>{
    if(!pending)throw Error("Unexpected tier write");requests++;
    const work=pending,input=route.request().postDataJSON();await work.release;
    if(work.scenario.abort){await route.abort("failed");return;}
    await route.fulfill({status:work.scenario.status??200,contentType:"application/json",body:work.scenario.raw??JSON.stringify(work.scenario.reply({ok:true,tiers:input.tiers}))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   const section=page.locator("[data-tier-editor]");await section.waitFor();
   const checks=section.getByRole("checkbox");
   is("two isolated tier candidates "+width,await checks.count(),2);
   // The checkboxes are server-rendered and enabled: a click before React attaches
   // onChange toggles nothing it keeps ("did not change its state" on slow WebKit).
   for(const check of await checks.all())await waitForReactChangeHandler(page,check);
   await checks.nth(0).check();
   is("one tier selection refused "+width,await section.getByRole("button",{name:"Let members switch",exact:true}).isDisabled(),true);
   await checks.nth(1).check();
   const expectedIds=fixture.ids;
   for(const off of [false,true])for(const scenario of cases){
    let release;const held=new Promise(resolve=>{release=resolve;});pending={scenario,release:held};
    const name=off+"/"+scenario.name+"/"+width;
    const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/tiers");seen.catch(()=>{});
    try{
     await section.getByRole("button",{name:off?"Switch it off":"Let members switch",exact:true}).click();
     const body=(await seen).postDataJSON();
     is("tier payload preserves ordered ids "+name,body,{tiers:off?[]:expectedIds});
     is("two existing product ids "+name,expectedIds.length,2);
     is("tier busy announced "+name,await section.getAttribute("aria-busy"),"true");
     for(const field of await section.locator("input,button").all())is("tier controls lock "+name,await field.isDisabled(),true);
    }finally{release();}
    await page.waitForFunction(()=>document.querySelector("[data-tier-editor]")?.getAttribute("aria-busy")==="false");
    if(scenario.confirmed){
     is("tier confirms without error "+name,await section.getByRole("alert").count(),0);
     is("tier confirmed selection "+name,await checks.evaluateAll((nodes,off)=>nodes.every(n=>n.checked===!off),off),true);
     is("tier saved status "+name,await section.locator(".tag").innerText(),off?"Off":"On");
    }else{
     const alert=section.getByRole("alert");await alert.waitFor();
     is("tier uncertainty honest "+name,(await alert.innerText()).includes("Reload this page to check before trying again"),true);
     is("tier draft retained "+name,await checks.evaluateAll(nodes=>nodes.every(n=>n.checked)),true);
     is("tier saved status not advanced "+name,await section.locator(".tag").innerText(),off?"On":"Off");
    }
    is("tier settings fit "+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   }
   is("all tier writes intercepted "+width,requests,22);
  }finally{await context.close();}
 }
}
