import {waitForReactChangeHandler} from "./react-hydration.mjs";

/** All reminder-setting writes are synthetic intercepted replies; no email/provider action. */
export async function checkRecoveryAcknowledgment({browser,LOCAL,fixture,is}){
 const scenariosFor=asks=>[
 {name:"HTTP failure",status:500,body:value=>({ok:true,recovery:value})},
 {name:"truthy confirmation",body:value=>({ok:"true",recovery:value})},
 {name:"missing snapshot",body:()=>({ok:true})},
 {name:"different enabled",body:value=>({ok:true,recovery:{...value,enabled:!value.enabled}})},
 {name:"different address",body:value=>({ok:true,recovery:{...value,address:"Other address"}})},
 {name:"missing account consent flag",body:value=>({ok:true,recovery:{enabled:value.enabled,address:value.address}})},
 {name:"text account consent flag",body:value=>({ok:true,recovery:{...value,asks:"true"}})},
 {name:"null",body:()=>null},
 {name:"array",body:value=>[{ok:true,recovery:value}]},
 {name:"malformed",raw:"<html>temporary error</html>"},
 {name:"inherited object error",body:()=>({ok:false,error:"__proto__"})},
 {name:"inherited function error",body:()=>({ok:false,error:"constructor"})},
 {name:"contradictory refusal",body:value=>({ok:true,recovery:value,error:"server_error"})},
 {name:"lost reply",abort:true},
 {name:"known refusal",status:400,body:()=>({ok:false,error:"address"}),specific:true},
 {name:"matching account consent",body:value=>({ok:true,recovery:{...value,asks}}),confirmed:true},
 ];
 for(const width of [390,1280])for(const asks of [false,true]){
  const scenarios=scenariosFor(asks);
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let pending=null,requests=0;
   await page.route("**/api/store/recovery",async route=>{
    if(!pending)throw Error("Unexpected reminder-setting write");
    requests++;const work=pending,input=route.request().postDataJSON();
    const value={enabled:input.enabled,address:input.address.replace(/\s+/g," ").trim(),asks:false};
    await work.release;if(work.scenario.abort){await route.abort("failed");return;}
    await route.fulfill({status:work.scenario.status??200,contentType:"application/json",body:work.scenario.raw??JSON.stringify(work.scenario.body(value))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.waitForLoadState("networkidle");
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   const section=page.locator("#checkout-reminders"),form=section.locator("form");await form.waitFor({state:"visible"});
   const toggle=form.getByRole("checkbox",{name:"Send one reminder after an abandoned checkout",exact:true}),address=form.getByLabel("Your postal address",{exact:true});
   await waitForReactChangeHandler(page,toggle);
   await toggle.setChecked(true);
   for(const scenario of scenarios){
    await address.fill("  123  Example Lane, Test City  ");
    let release;const held=new Promise(resolve=>{release=resolve;});pending={scenario,release:held};
    const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/recovery");seen.catch(()=>{});
    const name=scenario.name+"/"+width;
    try{
     await form.getByRole("button",{name:"Save",exact:true}).click();const sent=(await seen).postDataJSON();
     is("reminder choice sent "+name,sent.enabled,true);is("postal input preserved "+name,sent.address,"  123  Example Lane, Test City  ");
     for(const field of [toggle,address])is("reminder fields lock "+name,await field.isDisabled(),true);
     is("reminder announces pending "+name,await form.getAttribute("aria-busy"),"true");
    }finally{release();}
    if(scenario.confirmed){
     await page.locator(".nb-toast-region [role=status]").getByText("Checkout reminders are on.",{exact:true}).first().waitFor({state:"attached"});
    }else{
     const alert=form.getByRole("alert");await alert.waitFor();
     is("reminder error stays honest "+name,(await alert.innerText()).includes(scenario.specific?"Add the postal address":"Reload this page to check before trying again"),true);
     is("reminder has no false success "+name,await page.getByText("Checkout reminders are on.",{exact:true}).count(),0);
     for(const field of [toggle,address])is("reminder fields unlock "+name,await field.isEnabled(),true);
     is("postal input remains untouched "+name,await address.inputValue(),"  123  Example Lane, Test City  ");
    }
    is("reminder controls fit "+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   }
   is("all reminder writes intercepted "+width,requests,scenarios.length);
  }finally{await context.close();}
 }
}
