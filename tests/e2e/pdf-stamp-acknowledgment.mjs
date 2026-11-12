/** Reuses synthetic PDF metadata only; intercepts every write and blocks stamp GETs. */
export async function checkPdfStampAcknowledgment({browser,LOCAL,fixture,is}){
 const cases=[
  {name:"HTTP failure",status:500,reply:v=>({ok:true,...v})},
  {name:"truthy ok",reply:v=>({ok:"true",...v})},
  {name:"missing saved fields",reply:()=>({ok:true})},
  {name:"wrong product",reply:v=>({ok:true,...v,id:"different"})},
  {name:"wrong choice",reply:v=>({ok:true,...v,on:false})},
  {name:"string choice",reply:v=>({ok:true,...v,on:"true"})},
  {name:"null response",reply:()=>null},
  {name:"array response",reply:v=>[{ok:true,...v}]},
  {name:"contradictory error",reply:v=>({ok:true,...v,error:"server_error"})},
  {name:"inherited error",status:400,reply:()=>({ok:false,error:"__proto__"})},
  {name:"malformed JSON",raw:"<html>Error</html>"},
  {name:"lost reply",abort:true},
  {name:"canonical saved choice",reply:v=>({ok:true,...v}),confirmed:true}
 ];
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let work=null,requests=0,gets=0;
   await page.route("**/api/store/stamp**",async route=>{
    if(route.request().method()==="GET"){gets++;await route.abort("failed");return;}
    if(!work)throw Error("Unexpected stamp write");requests++;const item=work;await item.held;
    if(item.scenario.abort){await route.abort("failed");return;}
    const value=route.request().postDataJSON();
    await route.fulfill({status:item.scenario.status??200,contentType:"application/json",body:item.scenario.raw??JSON.stringify(item.scenario.reply(value))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.waitForLoadState("networkidle");
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   const select=page.locator('[id="stamp-'+fixture.product+'"]');await select.waitFor({state:"visible"});
   // The checkbox is visible in the server HTML before React can handle its
   // change. Observe that exact handler instead of sleeping or retrying a click.
   await page.waitForFunction(element=>Object.keys(element).some(key=>key.startsWith("__reactProps$")&&typeof element[key]?.onChange==="function"),await select.elementHandle());
   const box=select.locator("../..");
   for(const scenario of cases){
    let release=()=>{};const held=new Promise(resolve=>{release=()=>resolve(undefined);});work={scenario,held};
    const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/stamp");seen.catch(()=>{});
    const name=scenario.name+"/"+width;
    try{
     await select.click();is("stamp request exact "+name,(await seen).postDataJSON(),{id:fixture.product,on:true});
     is("stamp pending lock "+name,await select.isDisabled(),true);
     is("stamp announces busy "+name,await box.getAttribute("aria-busy"),"true");
    }finally{release();}
    if(scenario.confirmed){
     await page.locator(".nb-toast-region [role=status]").getByText("PDF marking setting saved.",{exact:true}).waitFor({state:"attached"});
    }else{
     const alert=box.getByRole("alert");await alert.waitFor();
     is("stamp uncertainty honest "+name,(await alert.innerText()).includes("Reload this page to check before trying again"),true);
     is("stamp no false success "+name,await page.getByText("PDF marking setting saved.",{exact:true}).count(),0);
     is("stamp unlocks "+name,await select.isEnabled(),true);
    }
    is("stamp document fits "+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   }
   is("stamp all writes intercepted "+width,requests,cases.length);is("stamp no stamp GET "+width,gets,0);
  }finally{await context.close();}
 }
}
