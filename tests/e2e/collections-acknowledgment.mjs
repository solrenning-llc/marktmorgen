/** All collection saves/removals intercepted; generated ids are synthetic only. */
/** Test actual geometry, including a disabled first-row move button. */
export async function checkCollectionProductTargets({section,is}){
 const controls=section.getByRole("button",{name:/^(?:Move .+ up|Take .+ out)$/});
 is("collection has real product controls",await controls.count()>0,true);
 for(const control of await controls.all()){
  const box=await control.boundingBox();
  is("collection target is at least 44px: "+await control.getAttribute("aria-label"),Boolean(box&&box.width>=44&&box.height>=44),true);
 }
}

/** With no page scripts, SSR must not advertise an editing action it cannot run. */
export async function checkCollectionsBeforeHydration({browser,LOCAL,fixture,is,width}){
 const context=await browser.newContext({javaScriptEnabled:false,viewport:{width,height:900}});
 try{
  await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
  const page=await context.newPage();
  await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"domcontentloaded",timeout:60000});
  const section=page.locator("[data-collections-editor]");await section.waitFor({state:"attached"});
  is("collections editing waits for hydration "+width,await section.locator("input,textarea,select,button").evaluateAll(nodes=>nodes.length>0&&nodes.every(n=>n.disabled)),true);
 }finally{await context.close();}
}

export async function checkCollectionsAcknowledgment({browser,LOCAL,fixture,is}){
 const cases=[
 {name:"HTTP",status:500,reply:value=>value},{name:"truthy",reply:value=>({...value,ok:"true"})},
 {name:"missing",reply:()=>({ok:true})},{name:"null",reply:()=>null},{name:"array",reply:value=>[value]},
 {name:"contradiction",reply:value=>({...value,error:"server_error"})},{name:"malformed",raw:"invalid"},
 {name:"lost",abort:true},{name:"inherited",reply:()=>({ok:false,error:"constructor"})},
 ...["title","blurb","products","id"].map(key=>({name:"different "+key,reply:(value,phase)=>({ok:true,collections:[{id:"abcd1234",title:"Other",blurb:"Other",products:["other"],...value.collections[0],[key]:key==="products"?["other"]:key==="id"?(phase==="edit"?"other123":"bad"):"Wrong"}]})})),
 {name:"confirmed",reply:value=>value,confirmed:true}
 ];
 for(const width of [390,1280]){
  await checkCollectionsBeforeHydration({browser,LOCAL,fixture,is,width});
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let pending=null,requests=0;
   await page.route("**/api/store/collections",async route=>{
    if(!pending)throw Error("Unexpected collection write");requests++;
    const work=pending,input=route.request().postDataJSON(),normal=s=>s.replace(/\s+/g," ").trim();
    const value={ok:true,collections:input.collections.map(row=>({id:row.id||"abcd1234",title:normal(row.title),blurb:normal(row.blurb),products:row.products}))};
    await work.release;if(work.scenario.abort){await route.abort("failed");return;}
    await route.fulfill({status:work.scenario.status??200,contentType:"application/json",body:work.scenario.raw??JSON.stringify(work.scenario.reply(value,work.phase))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   const section=page.locator("[data-collections-editor]");await section.waitFor();
   await section.getByRole("button",{name:/Add a collection/}).click();
   await section.getByLabel("Collection 1: name",{exact:false}).fill("Guides  pour vous");
   await section.getByLabel("A line about it (optional)",{exact:false}).fill("Pour  apprendre.");
   await section.getByRole("button",{name:"Add to this collection",exact:true}).click();
   await checkCollectionProductTargets({section,is});
   for(const phase of ["create","edit","remove"]){
    if(phase==="edit")await section.getByLabel("Collection 1: name",{exact:false}).fill("Guides  suivants");
    if(phase==="remove")await section.getByRole("button",{name:"Remove collection 1",exact:true}).click();
    await page.waitForFunction(()=>{const root=document.querySelector("[data-collections-editor]");return root?.getAttribute("aria-busy")==="false"&&[...root.querySelectorAll("button")].some(button=>button.textContent.trim()==="Save collections"&&!button.disabled);});
    for(const scenario of cases){
     let release;const held=new Promise(resolve=>{release=resolve;});pending={scenario,phase,release:held};
     const name=phase+"/"+scenario.name+"/"+width;
     const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/collections");seen.catch(()=>{});
     try{
      await section.getByRole("button",{name:"Save collections",exact:true}).click();const input=(await seen).postDataJSON();
      is("collection intent "+name,input.collections.length,phase==="remove"?0:1);
      if(phase==="edit")is("existing collection id preserved "+name,input.collections[0].id,"abcd1234");
      is("collections busy "+name,await section.getAttribute("aria-busy"),"true");
      for(const field of await section.locator("input,textarea,select,button").all())is("collection controls lock "+name,await field.isDisabled(),true);
     }finally{release();}
     await page.waitForFunction(()=>document.querySelector("[data-collections-editor]")?.getAttribute("aria-busy")==="false");
     if(scenario.confirmed){
      // A confirmed save calls router.refresh(); finish that transition before
      // starting the next edit/removal against this same editor.
      await page.waitForLoadState("networkidle");
      is("collections confirmed without error "+name,await section.getByRole("alert").count(),0);
      is("collections saved baseline "+name,await section.getByRole("button",{name:"Save collections",exact:true}).isDisabled(),true);
      if(phase!=="remove")is("saved collection address keeps id "+name,(await section.getByRole("link").getAttribute("href")).endsWith("-abcd1234"),true);
     }else{
      const alert=section.getByRole("alert");await alert.waitFor();
      is("collection uncertainty honest "+name,(await alert.innerText()).includes("Reload this page to check before trying again"),true);
      if(phase!=="remove")is("creator collection draft retained "+name,await section.getByLabel("Collection 1: name",{exact:false}).inputValue(),phase==="create"?"Guides  pour vous":"Guides  suivants");
     }
     is("collection controls fit "+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
   }
   is("all collection writes intercepted "+width,requests,42);
  }finally{await context.close();}
 }
}
