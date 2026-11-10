import {waitForReactChangeHandler} from "./react-hydration.mjs";

/** Only synthetic intercepted allowlist settings; never visits the listed origins or opens checkout. */
export async function checkSitesAcknowledgment({browser,LOCAL,fixture,is}){
 const draft=" HTTPS://Example.TEST/shop\nhttps://blog.example.test/path ",expected=["https://example.test","https://blog.example.test"];
 const cases=[
 {name:"HTTP",status:500,reply:v=>v},{name:"truthy",reply:v=>({...v,ok:"true"})},
 {name:"missing",reply:()=>({ok:true})},{name:"null",reply:()=>null},{name:"array",reply:v=>[v]},
 {name:"contradiction",reply:v=>({...v,error:"server_error"})},{name:"malformed",raw:"invalid"},
 {name:"lost",abort:true},{name:"inherited",reply:()=>({ok:false,error:"__proto__"})},
 {name:"wrong sites",reply:v=>({...v,sites:["https://other.example.test"]})},
 {name:"wrong type",reply:v=>({...v,sites:v.sites.join("\n")})},
 {name:"confirmed",reply:v=>v,confirmed:true}];
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let pending=null,requests=0;
   await page.route("**/api/store/embed-sites",async route=>{
    if(!pending)throw Error("Unexpected allowlist write");requests++;
    const work=pending,input=route.request().postDataJSON();await work.release;
    if(work.scenario.abort){await route.abort("failed");return;}
    await route.fulfill({status:work.scenario.status??200,contentType:"application/json",body:work.scenario.raw??JSON.stringify(work.scenario.reply({ok:true,sites:input.sites}))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.waitForLoadState("networkidle");
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   const section=page.locator("#checkout-script");await section.waitFor();
   const field=section.locator("textarea").first(),save=section.getByRole("button",{name:"Save sites",exact:true});
   await waitForReactChangeHandler(page,field);
   for(const clear of [false,true]){
    const raw=clear?"":draft,sites=clear?[]:expected;await field.fill(raw);
    for(const scenario of cases){
     let release;const held=new Promise(resolve=>{release=resolve;});pending={scenario,release:held};
     const name=clear+"/"+scenario.name+"/"+width;
     const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/embed-sites");seen.catch(()=>{});
     try{
      await save.click();is("allowlist exact canonical request "+name,(await seen).postDataJSON(),{sites});
      is("allowlist busy "+name,await section.getAttribute("aria-busy"),"true");
      is("allowlist draft locks "+name,await field.isDisabled(),true);
      is("allowlist save locks "+name,await section.getByRole("button",{name:"Saving…",exact:true}).isDisabled(),true);
     }finally{release();}
     await page.waitForFunction(()=>document.querySelector("#checkout-script")?.getAttribute("aria-busy")==="false");
     if(scenario.confirmed){
      is("allowlist confirms "+name,await section.getByRole("alert").count(),0);
      is("allowlist canonical draft "+name,await field.inputValue(),sites.join("\n"));
      is("allowlist baseline advances "+name,await save.isDisabled(),true);
     }else{
      const alert=section.getByRole("alert");await alert.waitFor();
      is("allowlist uncertainty "+name,(await alert.innerText()).includes("Reload this page to check before trying again"),true);
      is("allowlist raw draft retained "+name,await field.inputValue(),raw);
      is("allowlist uncertain baseline retained "+name,await save.isDisabled(),false);
     }
     is("allowlist fits "+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
   }
   is("all allowlist writes intercepted "+width,requests,24);
  }finally{await context.close();}
 }
}
