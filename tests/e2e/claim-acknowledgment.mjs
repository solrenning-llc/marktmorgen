/** Every claim POST is intercepted: this creates no store/account or provider request. */
export async function checkClaimAcknowledgment({browser,LOCAL,session,sid,is}){
 const scenarios=[
 {name:"HTTP failure",status:500,body:value=>({ok:true,...value})},
 {name:"truthy confirmation",body:value=>({ok:"true",...value})},
 {name:"missing store",body:value=>({ok:true,handle:value.handle})},
 {name:"invalid store",body:value=>({ok:true,...value,store:"unexpected?store=other"})},
 {name:"different handle",body:value=>({ok:true,...value,handle:"different"})},
 {name:"null",body:()=>null},
 {name:"array",body:()=>[]},
 {name:"unknown inherited error",body:()=>({ok:false,error:"__proto__"})},
 {name:"malformed",raw:"<html>error</html>"},
 {name:"contradictory error",body:value=>({ok:true,...value,error:"server_error"})},
 {name:"known refusal",status:400,body:()=>({ok:false,error:"taken"}),specific:true},
 {name:"matching store",body:value=>({ok:true,...value}),confirmed:true},
 ];
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:"nl_session",value:session,url:LOCAL}]);
   const page=await context.newPage();let pending=null,requests=0,aiRequests=0;
   await page.route("**/api/store/ai",async route=>{aiRequests++;await route.abort();});
   await page.route("**/api/store/claim",async route=>{
    if(!pending)throw Error("Unexpected claim write");
    const work=pending;requests++;
    const sent=route.request().postDataJSON();
    const value={handle:sent.handle.trim().replace(/^@+/,"").toLowerCase(),store:sid};
    await work.release;
    await route.fulfill({status:work.scenario.status??200,contentType:"application/json",body:work.scenario.raw??JSON.stringify(work.scenario.body(value))});
   });
   await page.goto(LOCAL+"/studio/new",{waitUntil:"networkidle",timeout:60000});
   const form=page.locator("form:has(#store-handle)"),field=form.getByLabel("Your address",{exact:true}),name=form.getByLabel("Store name",{exact:true}),bio=form.locator("#store-bio");
   for(const scenario of scenarios){
    await field.fill(" @Synthetic.Store ");await name.fill("Synthetic store");await bio.fill("A synthetic description.");await form.getByRole("checkbox",{name:/^I am at least 18 years old/}).check();
    let release;const held=new Promise(resolve=>{release=resolve;});
    pending={scenario,release:held};
    const seen=page.waitForRequest(request=>request.method()==="POST"&&new URL(request.url()).pathname==="/api/store/claim",{timeout:15000});seen.catch(()=>{});
    try{
     await form.getByRole("button",{name:"Create this store",exact:true}).click();
     is("claim request preserves submitted value "+scenario.name+" "+width,(await seen).postDataJSON().handle," @Synthetic.Store ");
     is("claim field locks pending reply "+scenario.name+" "+width,await field.isDisabled(),true);
     is("description locks pending reply "+scenario.name+" "+width,await bio.isDisabled(),true);
     is("name locks pending reply "+scenario.name+" "+width,await name.isDisabled(),true);
     is("claim form exposes pending state "+scenario.name+" "+width,await form.getAttribute("aria-busy"),"true");
    }finally{release();}
    if(scenario.confirmed){
     await page.waitForURL(url=>url.pathname==="/studio"&&url.searchParams.get("store")===sid);
     is("confirmed store opens its own studio "+width,new URL(page.url()).searchParams.get("store"),sid);
    }else{
     const alert=form.getByRole("alert");await alert.waitFor();
     is("claim refusal stays honest "+scenario.name+" "+width,(await alert.innerText()).includes(scenario.specific?"Someone already has that address":"We could not confirm whether your store was created"),true);
     is("unconfirmed store never navigates "+scenario.name+" "+width,new URL(page.url()).pathname,"/studio/new");
     is("failed reply preserves the chosen claim "+scenario.name+" "+width,await field.inputValue()," @Synthetic.Store ");
     is("claim unlocks after response "+scenario.name+" "+width,await field.isEnabled(),true);
     is("unconfirmed reply preserves description "+scenario.name+" "+width,await bio.inputValue(),"A synthetic description.");
    }
    const fits=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
    if(!fits)console.log("Claim overflow diagnostics",await page.evaluate(()=>[...document.querySelectorAll("main *")].map(node=>{const box=node.getBoundingClientRect();return {tag:node.tagName,id:node.id,className:String(node.className),left:box.left,right:box.right,width:box.width};}).filter(box=>box.width>0&&(box.right>innerWidth+1||box.left < -1)).slice(0,12)));
    is("claim controls fit viewport "+scenario.name+" "+width,fits,true);
   }
   is("all claim writes stayed intercepted "+width,requests,scenarios.length);
   is("claim confirmation never requests AI "+width,aiRequests,0);
  }finally{await context.close();}
 }
}
