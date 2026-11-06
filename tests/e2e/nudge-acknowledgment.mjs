import {waitForReactChangeHandler} from "./react-hydration.mjs";

/** All reminder-setting writes are synthetic intercepted replies; no email/provider action. */
export async function checkNudgeAcknowledgment({browser,LOCAL,fixture,is}){
 const scenarios=[
 {name:"HTTP failure",status:500,body:value=>({ok:true,nudge:value})},
 {name:"truthy confirmation",body:value=>({ok:"true",nudge:value})},
 {name:"missing snapshot",body:()=>({ok:true})},
 {name:"different on",body:value=>({ok:true,nudge:{...value,on:!value.on}})},
 {name:"different address",body:value=>({ok:true,nudge:{...value,address:"Other address"}})},
 {name:"null",body:()=>null},
 {name:"array",body:value=>[{ok:true,nudge:value}]},
 {name:"malformed",raw:"<html>temporary error</html>"},
 {name:"inherited object error",body:()=>({ok:false,error:"__proto__"})},
 {name:"inherited function error",body:()=>({ok:false,error:"constructor"})},
 {name:"contradictory refusal",body:value=>({ok:true,nudge:value,error:"server_error"})},
 {name:"lost reply",abort:true},
 {name:"known refusal",status:400,body:()=>({ok:false,error:"address"}),specific:true},
 {name:"matching saved snapshot",body:value=>({ok:true,nudge:value}),confirmed:true},
 ];
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let pending=null,requests=0;
   await page.route("**/api/store/nudge",async route=>{
    if(!pending)throw Error("Unexpected reminder-setting write");
    requests++;const work=pending,input=route.request().postDataJSON();
    const value={on:input.on,address:input.address.replace(/\s+/g," ").trim()};
    await work.release;if(work.scenario.abort){await route.abort("failed");return;}
    await route.fulfill({status:work.scenario.status??200,contentType:"application/json",body:work.scenario.raw??JSON.stringify(work.scenario.body(value))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   const section=page.locator("[data-nudge-editor]"),form=section.locator("form");await form.waitFor({state:"visible"});
   const toggle=form.getByRole("checkbox",{name:"Email members who stopped coming",exact:true}),address=form.getByLabel("Your postal address, printed at the bottom",{exact:true});
   await waitForReactChangeHandler(page,toggle);
   await toggle.setChecked(true);
   for(const scenario of scenarios){
    await address.fill("  123  Example Lane, Test City  ");
    let release;const held=new Promise(resolve=>{release=resolve;});pending={scenario,release:held};
    const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/nudge");seen.catch(()=>{});
    const name=scenario.name+"/"+width;
    try{
     await form.getByRole("button",{name:"Save",exact:true}).click();const sent=(await seen).postDataJSON();
     is("reminder choice sent "+name,sent.on,true);is("postal input preserved "+name,sent.address,"  123  Example Lane, Test City  ");
     for(const field of [toggle,address])is("reminder fields lock "+name,await field.isDisabled(),true);
     is("reminder announces pending "+name,await section.getAttribute("aria-busy"),"true");
    }finally{release();}
    if(scenario.confirmed){
     await page.locator(".nb-toast-region [role=status]").getByText("Member email settings saved.",{exact:true}).first().waitFor({state:"attached"});
    }else{
     const alert=section.getByRole("alert");await alert.waitFor();
     is("reminder error stays honest "+name,(await alert.innerText()).includes(scenario.specific?"Type the postal address":"Reload this page to check before trying again"),true);
     is("reminder has no false success "+name,await page.getByText("Member email settings saved.",{exact:true}).count(),0);
     for(const field of [toggle,address])is("reminder fields unlock "+name,await field.isEnabled(),true);
     is("postal input remains untouched "+name,await address.inputValue(),"  123  Example Lane, Test City  ");
    }
    is("reminder controls fit "+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   }
   is("all reminder writes intercepted "+width,requests,scenarios.length);
  }finally{await context.close();}
 }
}
