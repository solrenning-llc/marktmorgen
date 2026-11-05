/** Exercise the existing guard through an actual navigation link and unload event. */
export async function checkOrderDraftProtection({page,is,label}){
 const before=page.url();
 const order=()=>page.locator("#order [data-order-part]").evaluateAll(nodes=>nodes.map(node=>node.getAttribute("data-order-part")));
 const draft=await order();
 is("unsaved order protects unload "+label,await page.evaluate(()=>!window.dispatchEvent(new Event("beforeunload",{cancelable:true}))),true);
 const notices=[];
 const dismiss=async dialog=>{notices.push(dialog.message());await dialog.dismiss();};
 page.on("dialog",dismiss);
 try{
  const path=page.getByRole("link",{name:"Path",exact:true});
  await path.focus();await path.press("Enter");
 }finally{page.off("dialog",dismiss);}
 is("unsaved order asks before leaving "+label,notices,["You have changes that are not saved. Leave without saving them?"]);
 is("staying keeps the same document "+label,page.url(),before);
 is("staying keeps the exact draft order "+label,await order(),draft);
}

/** All order mutations intercepted; never change creator content or public ordering. */
export async function checkOrderAcknowledgment({browser,LOCAL,fixture,is}){
 const usual=["products","quotes","links","tips","signup","faq","contact","community"];
 const moved=["quotes","products",...usual.slice(2)];
 const cases=[
 {name:"HTTP",status:500,reply:v=>v},{name:"truthy",reply:v=>({...v,ok:"true"})},
 {name:"missing",reply:()=>({ok:true})},{name:"different order",reply:v=>({...v,order:[...v.order].reverse()})},
 {name:"partial",reply:v=>({...v,order:v.order.slice(1)})},
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
   await page.route("**/api/store/order",async route=>{
    if(!pending)throw Error("Unexpected page order write");requests++;
    const work=pending,input=route.request().postDataJSON();await work.release;
    if(work.scenario.abort){await route.abort("failed");return;}
    await route.fulfill({status:work.scenario.status??200,contentType:"application/json",body:work.scenario.raw??JSON.stringify(work.scenario.reply({ok:true,order:input.order}))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.waitForLoadState("networkidle");
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   const section=page.locator("#order");await section.waitFor();
   const order=()=>section.locator("[data-order-part]").evaluateAll(nodes=>nodes.map(n=>n.getAttribute("data-order-part")));
   await page.waitForFunction(()=>document.querySelector("#order")?.getAttribute("data-order-ready")==="true");
   is("order controls ready before activation "+width,await section.getByRole("button",{name:"Move What you sell down",exact:true}).isEnabled(),true);
   is("order starts with existing identifiers "+width,await order(),usual);
   is("unchanged order does not block unload "+width,await page.evaluate(()=>!window.dispatchEvent(new Event("beforeunload",{cancelable:true}))),false);
   await section.getByRole("button",{name:"Move What you sell down",exact:true}).click();
   await page.waitForFunction(expected=>JSON.stringify([...document.querySelectorAll("#order [data-order-part]")].map(node=>node.getAttribute("data-order-part")))===JSON.stringify(expected),moved);
   is("draft order moved "+width,await order(),moved);
   await checkOrderDraftProtection({page,is,label:"local move/"+width});
   for(const reset of [false,true])for(const scenario of cases){
    const expected=reset?usual:moved,retained=moved;
    let release;const held=new Promise(resolve=>{release=resolve;});pending={scenario,release:held};
    const name=reset+"/"+scenario.name+"/"+width;
    const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/order");seen.catch(()=>{});
    try{
     await section.getByRole("button",{name:reset?"Back to the usual order":"Save the order",exact:true}).click();
     is("page order exact request "+name,(await seen).postDataJSON(),{order:expected});
     is("page order busy "+name,await section.getAttribute("aria-busy"),"true");
     for(const control of await section.locator("button").all())is("page order all controls lock "+name,await control.isDisabled(),true);
    }finally{release();}
    await page.waitForFunction(()=>document.querySelector("#order")?.getAttribute("aria-busy")==="false");
    if(scenario.confirmed){
     is("page order confirms "+name,await section.getByRole("alert").count(),0);
     is("page order confirmed identifiers "+name,await order(),expected);
     is("page order saved baseline "+name,await section.getByRole("button",{name:"Save the order",exact:true}).isDisabled(),true);
     is("confirmed order releases unload protection "+name,await page.evaluate(()=>!window.dispatchEvent(new Event("beforeunload",{cancelable:true}))),false);
     if(reset)is("page order usual reset completed "+name,await section.getByRole("button",{name:"Back to the usual order",exact:true}).count(),0);
    }else{
     const alert=section.getByRole("alert");await alert.waitFor();
     is("page order uncertainty honest "+name,(await alert.innerText()).includes("Reload this page to check before trying again"),true);
     is("page order draft identifiers retained "+name,await order(),retained);
     if(!reset&&["HTTP","malformed","lost"].includes(scenario.name))await checkOrderDraftProtection({page,is,label:name});
    }
    is("page order fits "+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   }
   is("all page order writes intercepted "+width,requests,24);
  }finally{await context.close();}
 }
}
