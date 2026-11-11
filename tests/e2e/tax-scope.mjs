/** Reads the real studio tax controls; never saves settings or opens a provider page. */
export async function checkTaxScope({browser,LOCAL,session,sid,is}){
 const context=await browser.newContext();
 try{
  await context.addCookies([{name:"nl_session",value:session,url:LOCAL}]);
  const page=await context.newPage();let writes=0;const writePaths=[];
  page.on("request",request=>{if(request.method()==="POST"){writes++;writePaths.push(new URL(request.url()).pathname);}});
  await page.route("**/api/**",route=>["GET","HEAD"].includes(route.request().method())?route.continue():route.abort());
  for(const width of [390,1280]){
   await page.setViewportSize({width,height:900});
   await page.goto(LOCAL+"/studio?store="+sid,{waitUntil:"domcontentloaded",timeout:60000});
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(node=>{node.open=true;}));
   const section=page.locator('[aria-labelledby="tax-title"]');
   const text=(await section.innerText()).replace(/\s+/g," ");
   is("tax controls distinguish account setup from platform duties "+width,text.includes("do not establish who owes tax under platform or marketplace rules"),true);
   is("platform VAT work remains visibly incomplete "+width,text.includes("platform VAT collection and records are still being built"),true);
   is("account setup does not claim to open sales "+width,text.includes("does not complete that work or open sales"),true);
   is("tax status is not established by entering a number "+width,text.includes("Entering a number does not by itself establish a buyer's tax treatment"),true);
   is("no blanket creator filing claim "+width,text.includes("You remain the seller who files and pays it"),false);
   is("the actual form references both visible explanations "+width,await section.locator("form").getAttribute("aria-describedby"),"tax-account-scope tax-platform-scope");
   for(const id of ["tax-account-scope","tax-platform-scope"]){
    is("scope explanation is unique "+id+" "+width,await page.locator("#"+id).count(),1);
    is("scope explanation has readable text "+id+" "+width,(await page.locator("#"+id).innerText()).trim().length>40,true);
   }
   is("tax section fits its viewport "+width,await section.evaluate(node=>node.scrollWidth<=node.clientWidth),true);
  }
  if(writes)console.error("TAX_SCOPE_UNEXPECTED_WRITES:"+JSON.stringify(writePaths));
  is("reading tax explanations never writes settings",writes,0);
  let listed=0;
  await page.route("**/api/store/discount",async route=>{
   const sent=route.request().postDataJSON();
   is("explicit discount read sends only list action",sent,{action:"list"});
   listed++;
   await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,codes:[],schedules:[],more:false})});
  });
  // The preceding checks intentionally read server text before hydration.
  // Settle that navigation before the separate, explicit client action.
  await page.waitForLoadState("networkidle");
  const load=page.getByRole("button",{name:"Load discount codes",exact:true});
  const seen=page.waitForRequest(request=>request.method()==="POST"&&new URL(request.url()).pathname==="/api/store/discount",{timeout:15000});
  seen.catch(()=>{});
  try{
   await load.click();
   is("explicit discount action reaches only the simulated endpoint",(await seen).postDataJSON(),{action:"list"});
   await page.getByRole("button",{name:"Refresh discount codes",exact:true}).waitFor();
  }catch(error){
   console.error("TAX_SCOPE_DISCOUNT_ACTION:"+JSON.stringify({listed,writePaths,url:page.url(),button:await load.count()?await load.evaluate(node=>({disabled:node.disabled,busy:node.getAttribute("aria-busy"),text:node.textContent})):null}));
   throw error;
  }
  is("discount list requires one explicit action",listed,1);
 }finally{await context.close();}
}
