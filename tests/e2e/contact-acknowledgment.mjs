import {waitForReactChangeHandler} from "./react-hydration.mjs";

/** Every contact-setting POST is intercepted; no message or store write occurs. */
export async function checkContactAcknowledgment({browser,LOCAL,fixture,axeSource,is}){
 const scenarios=[
 {name:"HTTP failure",status:500,body:value=>({ok:true,contact:value})},
 {name:"truthy confirmation",body:value=>({ok:"true",contact:value})},
 {name:"missing saved snapshot",body:()=>({ok:true})},
 {name:"different enabled choice",body:value=>({ok:true,contact:{...value,on:!value.on}})},
 {name:"different heading",body:value=>({ok:true,contact:{...value,heading:"Different"}})},
 {name:"different line",body:value=>({ok:true,contact:{...value,line:"Different"}})},
 {name:"null",body:()=>null},
 {name:"array",body:value=>[{ok:true,contact:value}]},
 {name:"malformed",raw:"<html>temporary error</html>"},
 {name:"inherited error",body:()=>({ok:false,error:"__proto__"})},
 {name:"contradictory error",body:value=>({ok:true,contact:value,error:"server_error"})},
 {name:"lost response",abort:true},
 {name:"normalization is not echoed",body:value=>({ok:true,contact:{...value,heading:"  Questions   about dinner  "}})},
 {name:"matching normalized snapshot",body:value=>({ok:true,contact:value}),confirmed:true},
 ];
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let pending=null,requests=0;
   await page.route("**/api/store/contact-box",async route=>{
    if(!pending)throw Error("Unexpected contact setting write");
    requests++;const work=pending;const input=route.request().postDataJSON();
    const normalize=text=>text.replace(/\s+/g," ").trim();
    const value={on:input.on,heading:normalize(input.heading),line:normalize(input.line)};
    await work.release;
    if(work.scenario.abort){await route.abort("failed");return;}
    await route.fulfill({status:work.scenario.status??200,contentType:"application/json",body:work.scenario.raw??JSON.stringify(work.scenario.body(value))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   const form=page.locator("form#contact");await form.waitFor({state:"visible"});await page.addScriptTag({content:axeSource});
   const toggle=form.getByRole("checkbox",{name:"Show the contact form on my store page",exact:true});
   const heading=form.getByLabel("Heading (optional)",{exact:true});const line=form.getByLabel("One line under it (optional)",{exact:true});
   await waitForReactChangeHandler(page,toggle);
   const original=await toggle.isChecked();await toggle.setChecked(!original);
   for(const scenario of scenarios){
    await heading.fill("  Questions   about dinner  ");await line.fill("Écrivez   votre question.");
    let release;const held=new Promise(resolve=>{release=resolve;});pending={scenario,release:held};
    const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/contact-box");seen.catch(()=>{});
    const name=scenario.name+"/"+width;
    try{
     await form.getByRole("button",{name:"Save",exact:true}).click();const input=(await seen).postDataJSON();
     is("contact choice sent "+name,input.on,!original);
     is("creator heading preserved "+name,input.heading,"  Questions   about dinner  ");
     for(const field of [toggle,heading,line])is("contact fields lock "+name,await field.isDisabled(),true);
     is("contact announces pending "+name,await form.getAttribute("aria-busy"),"true");
    }finally{release();}
    if(scenario.confirmed){
     await page.locator(".nb-toast-region [role=status]").getByText("Contact form settings saved.",{exact:true}).waitFor({state:"attached"});
     is("contact toast does not claim public availability "+name,await page.getByText("The contact form is on your store page.",{exact:true}).count(),0);
    }else{
     const alert=form.getByRole("alert");await alert.waitFor();
     is("contact uncertain result stays honest "+name,(await alert.innerText()).includes("Reload this page to check before trying again"),true);
     const contrast=await alert.evaluate(async node=>{const r=await window.axe.run(node,{runOnly:{type:"rule",values:["color-contrast-enhanced"]}});return {violations:r.violations.map(v=>v.id),incomplete:r.incomplete.map(v=>v.id),passed:r.passes.some(v=>v.id==="color-contrast-enhanced")};});
     is("contact error enhanced contrast "+name,contrast,{violations:[],incomplete:[],passed:true});
     is("contact has no false success "+name,await page.getByText("Contact form settings saved.",{exact:true}).count(),0);
     for(const field of [toggle,heading,line])is("contact fields unlock "+name,await field.isEnabled(),true);
     is("creator line remains untouched "+name,await line.inputValue(),"Écrivez   votre question.");
    }
    is("contact controls fit "+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   }
   is("all contact writes intercepted "+width,requests,scenarios.length);
  }finally{await context.close();}
 }
}
