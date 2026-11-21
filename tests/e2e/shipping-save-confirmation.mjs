/** All shipping writes are intercepted; no live store, payment or email. */
export function shippingForm(page,productId){
 return page.locator("form").filter({has:page.locator("#ship-"+productId+"-sku")});
}

export async function checkShippingSave({browser,LOCAL,fixture,is}){
 const saved={cents:750,region:"na",countries:["US","CA"],note:"Ships tomorrow",sku:"Créateur-01"};
 const product={id:fixture.product,shipping:saved};
 const beforeReady=await browser.newContext({viewport:{width:390,height:1000},javaScriptEnabled:false});
 try{
  await beforeReady.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
  const initial=await beforeReady.newPage();let writes=0;
  await initial.route("**/api/**",async route=>{
   if(["GET","HEAD"].includes(route.request().method())){await route.continue();return;}
   writes++;await route.abort("blockedbyclient");
  });
  await initial.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"domcontentloaded",timeout:60000});
  const summary=initial.getByText("SKU: Synthetic-SKU",{exact:true}).locator("..");
  for(const name of ["Change","Stop shipping it"]){
   const beforeName=name+" — Loading…";
   const button=summary.getByRole("button",{name:beforeName,exact:true});
   await button.waitFor({state:"attached"});
   is(name+" is natively unavailable before shipping hydration",await button.isDisabled(),true);
   is(name+" exposes unavailable shipping hydration",await button.getAttribute("aria-disabled"),"true");
   is(name+" visibly reports shipping preparation",(await button.innerText()).trim(),beforeName);
   await button.dispatchEvent("click");
  }
  is("shipping form stays closed before hydration",await shippingForm(initial,fixture.product).count(),0);
  is("shipping controls start no write before hydration",writes,0);
 }finally{await beforeReady.close();}
 const cases=[
 {name:"HTTP failure",status:500,body:{ok:true,product}},
 {name:"truthy success",body:{ok:"true",product}},
 {name:"missing product",body:{ok:true}},
 {name:"different product",body:{ok:true,product:{...product,id:"other"}}},
 {name:"different charge",body:{ok:true,product:{...product,shipping:{...saved,cents:0}}}},
 {name:"missing shipping",body:{ok:true,product:{id:fixture.product}}},
 {name:"contradictory error",body:{ok:true,product,error:"server_error"}},
 {name:"malformed JSON",raw:"<html>unknown</html>"},
 {name:"lost reply",abort:true},
 {name:"confirmed",body:{ok:true,product},confirmed:true},
 ];
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:1000}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let scenario=cases[0],release=()=>{},seen=()=>{},requests=0,otherWrites=0;
   await page.route("**/api/**",async route=>{
    const req=route.request();if(["GET","HEAD"].includes(req.method())){await route.continue();return;}
    if(new URL(req.url()).pathname!=="/api/store/shipping"){otherWrites++;await route.abort();return;}
    requests++;const sent=req.postDataJSON();
    is("shipping request keeps product "+width,sent.id,fixture.product);
    is("shipping request keeps SKU "+width,sent.shipping.sku,saved.sku);
    is("shipping request keeps chosen charge "+width,sent.shipping.price,"7.50");
    const waiting=new Promise(resolve=>{release=resolve;});seen();await waiting;
    if(scenario.abort){await route.abort();return;}
    await route.fulfill({status:scenario.status??200,contentType:"application/json",body:scenario.raw??JSON.stringify(scenario.body)});
   });
   for(const next of cases){
    scenario=next;
    await page.goto(LOCAL+"/studio?store="+fixture.sid+"&shipping_case="+encodeURIComponent(next.name),{waitUntil:"networkidle",timeout:60000});
    const summary=page.getByText("SKU: Synthetic-SKU",{exact:true}).locator("..");
    await summary.getByRole("button",{name:"Change",exact:true}).click();
    const sku=page.locator("#ship-"+fixture.product+"-sku");
    const form=page.locator("form").filter({has:sku});
    await form.getByLabel("Shipping cost per order, in dollars",{exact:true}).fill("7.50");
    await form.getByRole("combobox").selectOption("na");
    await sku.fill(saved.sku);
    await form.getByLabel("When it ships (optional)",{exact:true}).fill(saved.note);
    let requestTimer;
    const requested=new Promise((resolve,reject)=>{requestTimer=setTimeout(()=>reject(new Error("No explicit shipping request: "+next.name+"/"+width)),30000);seen=()=>{clearTimeout(requestTimer);resolve();};});
    await form.getByRole("button",{name:"Save shipping",exact:true}).click();await requested;
    is("shipping form announces pending "+next.name+"/"+width,await form.getAttribute("aria-busy"),"true");
    is("shipping inputs lock pending "+next.name+"/"+width,await sku.isDisabled(),true);
    is("shipping cancel locks pending "+next.name+"/"+width,await form.getByRole("button",{name:"Cancel",exact:true}).isDisabled(),true);
    release();
    if(next.confirmed){
     await page.locator('.nb-toast-region [role="status"]').getByText("Shipping saved.",{exact:true}).waitFor();
    }else{
     const alert=form.getByRole("alert");await alert.waitFor();
     is("uncertain shipping stays truthful "+next.name+"/"+width,(await alert.innerText()).includes("Shipping was not confirmed"),true);
     is("uncertain shipping keeps SKU "+next.name+"/"+width,await sku.inputValue(),saved.sku);
     is("uncertain shipping keeps charge "+next.name+"/"+width,await form.getByLabel("Shipping cost per order, in dollars",{exact:true}).inputValue(),"7.50");
     is("shipping controls unlock after uncertainty "+next.name+"/"+width,await sku.isEnabled(),true);
    }
    is("shipping fits viewport "+next.name+"/"+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   }
   is("one intercepted shipping write per case "+width,requests,cases.length);
   is("no unrelated shipping writes "+width,otherWrites,0);
  }finally{await context.close();}
 }
}
