import {waitForReactChangeHandler} from "./react-hydration.mjs";

/** Intercept every cart-setting write; no checkout or payment occurs. */
export async function checkCartAcknowledgment({browser,LOCAL,fixture,is}){
 const cases=[
 {name:"HTTP",status:500,reply:v=>v},{name:"truthy",reply:v=>({...v,ok:"true"})},
 {name:"missing",reply:()=>({ok:true})},{name:"wrong state",reply:v=>({...v,deal:{...v.deal,on:!v.deal.on}})},
 {name:"wrong minimum",reply:v=>({...v,deal:{...v.deal,min:4}})},
 {name:"wrong percent",reply:v=>({...v,deal:{...v.deal,percent:20}})},
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
   await page.route("**/api/store/cart-deal",async route=>{
    if(!pending)throw Error("Unexpected cart setting write");requests++;
    const work=pending,input=route.request().postDataJSON();await work.release;
    if(work.scenario.abort){await route.abort("failed");return;}
    await route.fulfill({status:work.scenario.status??200,contentType:"application/json",body:work.scenario.raw??JSON.stringify(work.scenario.reply({ok:true,deal:input}))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   const section=page.locator("#cart-deal");await section.waitFor();
   const check=section.getByRole("checkbox");await waitForReactChangeHandler(page,check);await check.check();
   await section.locator("#deal-min").selectOption("3");
   await section.locator("#deal-percent").fill("15");
   for(const on of [true,false]){
    await check.setChecked(on);
    for(const scenario of cases){
     let release;const held=new Promise(resolve=>{release=resolve;});pending={scenario,release:held};
     const name=on+"/"+scenario.name+"/"+width;
     const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/cart-deal");seen.catch(()=>{});
     try{
      await section.getByRole("button",{name:"Save",exact:true}).click();
      is("cart settings exact request "+name,(await seen).postDataJSON(),{on,min:3,percent:15});
      is("cart settings busy "+name,await section.getAttribute("aria-busy"),"true");
      for(const field of await section.locator("input,select,button").all())is("cart settings pending lock "+name,await field.isDisabled(),true);
     }finally{release();}
     await page.waitForFunction(()=>document.querySelector("#cart-deal")?.getAttribute("aria-busy")==="false");
     if(scenario.confirmed)is("cart settings confirmed "+name,await section.getByRole("alert").count(),0);
     else{
      const alert=section.getByRole("alert");await alert.waitFor();
      is("cart settings honest uncertainty "+name,(await alert.innerText()).includes("Reload this page to check before trying again"),true);
      is("cart setting draft retained "+name,await check.isChecked(),on);
      if(on){
       is("cart minimum retained "+name,await section.locator("#deal-min").inputValue(),"3");
       is("cart percent retained "+name,await section.locator("#deal-percent").inputValue(),"15");
      }
     }
     is("cart settings fit "+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
   }
   is("all cart writes intercepted "+width,requests,26);
  }finally{await context.close();}
 }
}
