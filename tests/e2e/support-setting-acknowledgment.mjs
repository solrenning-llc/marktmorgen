import {waitForReactChangeHandler} from "./react-hydration.mjs";

/** Every support-setting POST is intercepted; no message or store write occurs. */
export async function checkTipsAcknowledgment({browser,LOCAL,fixture,axeSource,is}){
 const scenarios=[
 {name:"HTTP failure",status:500,body:value=>({ok:true,tips:value})},
 {name:"truthy confirmation",body:value=>({ok:"true",tips:value})},
 {name:"missing saved snapshot",body:()=>({ok:true})},
 {name:"different enabled choice",body:value=>({ok:true,tips:{...value,on:!value.on}})},
 {name:"different heading",body:value=>({ok:true,tips:{...value,heading:"Different"}})},
 {name:"different line",body:value=>({ok:true,tips:{...value,line:"Different"}})},
 {name:"null",body:()=>null},
 {name:"array",body:value=>[{ok:true,tips:value}]},
 {name:"malformed",raw:"<html>temporary error</html>"},
 {name:"inherited error",body:()=>({ok:false,error:"__proto__"})},
 {name:"contradictory error",body:value=>({ok:true,tips:value,error:"server_error"})},
 {name:"lost response",abort:true},
 {name:"normalization is not echoed",body:value=>({ok:true,tips:{...value,heading:"  Questions   about dinner  "}})},
 {name:"different amounts",body:value=>({ok:true,tips:{...value,amounts:[999]}})},
 {name:"different amount order",body:value=>({ok:true,tips:{...value,amounts:[...value.amounts].reverse()}})},
 {name:"invalid rejected index",status:400,body:()=>({ok:false,error:"amount",bad:[-1,99]})},
 {name:"matching normalized snapshot",body:value=>({ok:true,tips:value}),confirmed:true},
 ];
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let pending=null,requests=0;
   await page.route("**/api/store/tips",async route=>{
    if(!pending)throw Error("Unexpected support setting write");
    requests++;const work=pending;const input=route.request().postDataJSON();
    const normalize=text=>text.replace(/\s+/g," ").trim();
    const value={on:input.on,heading:normalize(input.heading),line:normalize(input.line),amounts:input.amounts.filter(v=>v.trim()).map(v=>Math.round(Number(v)*100))};
    await work.release;
    if(work.scenario.abort){await route.abort("failed");return;}
    await route.fulfill({status:work.scenario.status??200,contentType:"application/json",body:work.scenario.raw??JSON.stringify(work.scenario.body(value))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   const form=page.locator("form#support");await form.waitFor({state:"visible"});await page.addScriptTag({content:axeSource});
   const toggle=form.getByRole("checkbox",{name:"Show Support my work on my store page",exact:true});
   const heading=form.getByLabel("Heading (optional)",{exact:true});const line=form.getByLabel("One line under it (optional)",{exact:true});
   const amountFields=[form.getByLabel("Amount 1",{exact:true}),form.getByLabel("Amount 2",{exact:true}),form.getByLabel("Amount 3",{exact:true})];
   await waitForReactChangeHandler(page,toggle);
   const original=await toggle.isChecked();await toggle.setChecked(!original);
   for(const scenario of scenarios){
    await heading.fill("  Questions   about dinner  ");await line.fill("Écrivez   votre question.");
    for(const [i,field] of amountFields.entries())await field.fill(["3","5.50","10"][i]);
    let release;const held=new Promise(resolve=>{release=resolve;});pending={scenario,release:held};
    const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/tips");seen.catch(()=>{});
    const name=scenario.name+"/"+width;
    try{
     await form.getByRole("button",{name:"Save",exact:true}).click();const input=(await seen).postDataJSON();
     is("support choice sent "+name,input.on,!original);
     is("creator heading preserved "+name,input.heading,"  Questions   about dinner  ");
     for(const field of [toggle,heading,line,...amountFields])is("support fields lock "+name,await field.isDisabled(),true);
     is("support announces pending "+name,await form.getAttribute("aria-busy"),"true");
    }finally{release();}
    if(scenario.confirmed){
     await page.locator(".nb-toast-region [role=status]").getByText("Support settings saved.",{exact:true}).waitFor({state:"attached"});
     is("support toast does not claim public availability "+name,await page.getByText("Support my work is on your store page.",{exact:true}).count(),0);
    }else{
     const alert=form.getByRole("alert");await alert.waitFor();
     is("support uncertain result stays honest "+name,(await alert.innerText()).includes("Reload this page to check before trying again"),true);
     const contrast=await alert.evaluate(async node=>{const r=await window.axe.run(node,{runOnly:{type:"rule",values:["color-contrast-enhanced"]}});return {violations:r.violations.map(v=>v.id),incomplete:r.incomplete.map(v=>v.id),passed:r.passes.some(v=>v.id==="color-contrast-enhanced")};});
     is("support error enhanced contrast "+name,contrast,{violations:[],incomplete:[],passed:true});
     is("support has no false success "+name,await page.getByText("Support settings saved.",{exact:true}).count(),0);
     for(const field of [toggle,heading,line,...amountFields])is("support fields unlock "+name,await field.isEnabled(),true);
     is("creator line remains untouched "+name,await line.inputValue(),"Écrivez   votre question.");
    }
    const fits=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
    is("support controls fit "+name,fits,true);
   }
   is("all support writes intercepted "+width,requests,scenarios.length);
  }finally{await context.close();}
 }
}
