/** Every appearance POST is synthetic; photo uploads and writes are blocked. */
export async function checkLookAcknowledgment({browser,LOCAL,fixture,is}){
 const cases=[
 {name:"HTTP",status:500,reply:look=>({ok:true,look})},
 {name:"truthy",reply:look=>({ok:"true",look})},
 {name:"missing",reply:()=>({ok:true})},
 {name:"null",reply:()=>null},
 {name:"array",reply:look=>[{ok:true,look}]},
 {name:"contradiction",reply:look=>({ok:true,look,error:"server_error"})},
 {name:"inherited",reply:()=>({ok:false,error:"__proto__"})},
 {name:"malformed",raw:"invalid"},
 {name:"lost",abort:true},
 ...["theme","accent","badge","sold","font","backdrop"].map(key=>({name:"different "+key,reply:look=>({ok:true,look:{...look,[key]:typeof look[key]==="boolean"?!look[key]:"different"}})})),
 {name:"confirmed",reply:look=>({ok:true,look}),confirmed:true}
 ];
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let pending=null,requests=0,photos=0;
   await page.route("**/api/store/photo",async route=>{photos++;await route.abort();});
   await page.route("**/api/store/look",async route=>{
    if(!pending)throw Error("Unexpected look write");requests++;
    const work=pending;const look=route.request().postDataJSON();await work.release;
    if(work.scenario.abort){await route.abort("failed");return;}
    await route.fulfill({status:work.scenario.status??200,contentType:"application/json",body:work.scenario.raw??JSON.stringify(work.scenario.reply(look))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   const section=page.locator("[data-look-editor]");await section.waitFor();
   const theme=section.locator('input[name="theme"][value="night"]');
   await theme.check({force:true});
   const before=await section.locator('input[name="font"]:checked,input[name="backdrop"]:checked').evaluateAll(nodes=>nodes.map(n=>({name:n.name,value:n.value})));
   for(const scenario of cases){
    let release;const held=new Promise(resolve=>{release=resolve;});pending={scenario,release:held};
    const name=scenario.name+"/"+width;
    const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/look");seen.catch(()=>{});
    try{
     await section.getByRole("button",{name:"Save the look",exact:true}).click();const sent=(await seen).postDataJSON();
     is("look theme sent "+name,sent.theme,"night");is("look counted proof stays off "+name,sent.sold,false);
     is("look busy "+name,await section.getAttribute("aria-busy"),"true");
     for(const field of await section.locator("input,button").all())is("look controls lock "+name,await field.isDisabled(),true);
    }finally{release();}
    await page.waitForFunction(()=>document.querySelector("[data-look-editor]")?.getAttribute("aria-busy")==="false");
    if(scenario.confirmed)await page.locator(".nb-toast-region [role=status]").getByText("Look saved.",{exact:true}).first().waitFor({state:"attached"});
    else{
     const alert=section.getByRole("alert");await alert.waitFor();
     is("look uncertainty honest "+name,(await alert.innerText()).includes("Reload this page to check before trying again"),true);
     is("look draft retained "+name,await theme.isChecked(),true);
     is("look no false confirmation "+name,await page.getByText("Look saved.",{exact:true}).count(),0);
     is("look remaining choices retained "+name,await section.locator('input[name="font"]:checked,input[name="backdrop"]:checked').evaluateAll(nodes=>nodes.map(n=>({name:n.name,value:n.value}))),before);
    }
    is("look controls fit "+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   }
   is("all appearance writes intercepted "+width,requests,cases.length);is("no photo operation "+width,photos,0);
  }finally{await context.close();}
 }
}
