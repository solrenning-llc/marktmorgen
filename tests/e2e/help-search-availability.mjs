import assert from "node:assert/strict";

/** The real /help route stays usable without scripts, with failed scripts, and hydrated. */
export async function checkHelpSearchAvailability({browser,origin}) {
 const fallback="All answers are below. Open a question to read its answer.";
 for(const mode of ["no-scripts","failed-scripts","hydrated"]){
  const context=await browser.newContext({viewport:{width:390,height:900},serviceWorkers:"block",javaScriptEnabled:mode!=="no-scripts"});
  let writes=0,foreign=0,blockedScripts=0;
  try{
   await context.route("**/*",route=>{
    const request=route.request(),url=new URL(request.url());
    if(!["GET","HEAD"].includes(request.method())){writes++;return route.abort();}
    if(url.origin!==origin){foreign++;return route.abort();}
    if(mode==="failed-scripts"&&request.resourceType()==="script"){blockedScripts++;return route.abort();}
    return route.continue();
   });
   const page=await context.newPage();
   const errors=[];
   page.on("pageerror",error=>errors.push(error.message));
   const response=await page.goto(origin+"/help",{waitUntil:"networkidle",timeout:60000});
   assert.equal(response.status(),200,"help route is available "+mode);
   const search=page.getByRole("searchbox",{name:"Search the help center",exact:true});
   const keywords=["refund","Stripe","trial","course","domain"].map(name=>page.getByRole("button",{name,exact:true}));
   const hint=await search.getAttribute("aria-describedby");
   const hintText=()=>page.evaluate(id=>document.getElementById(id)?.textContent?.trim(),hint);
   if(mode==="hydrated"){
    await search.waitFor({state:"visible"});
    await page.waitForFunction(()=>document.querySelector("#help-search")?.disabled===false);
    for(const keyword of keywords)assert.equal(await keyword.isEnabled(),true,"hydrated keyword is operable");
    assert.notEqual(await hintText(),fallback,"hydrated hint offers the working filter");
    await search.fill("Stripe");
    await page.waitForFunction(()=>document.querySelectorAll("details[data-help-item][hidden]").length>0&&document.querySelectorAll("details[data-help-item]:not([hidden])").length>0);
    await keywords[3].click();
    await page.waitForFunction(()=>document.querySelector("#help-search")?.value==="course");
    assert.equal(await search.inputValue(),"course","hydrated keyword changes the controlled query");
   }else{
    assert.equal(await search.isDisabled(),true,"search is honestly unavailable "+mode);
    for(const keyword of keywords)assert.equal(await keyword.isDisabled(),true,"keyword is honestly unavailable "+mode);
    assert.equal(await hintText(),fallback,"native answer instruction is shown "+mode);
    assert.equal(await page.locator("details[data-help-item][hidden]").count(),0,"no answer is hidden without filtering "+mode);
    const answer=page.locator("details[data-help-item]").first();
    assert.ok(await answer.count(),"a real native answer exists");
    await answer.locator("summary").click();
    await page.waitForFunction(node=>node.open,await answer.elementHandle(),{timeout:3000});
    assert.equal(await answer.getAttribute("open"),"","native disclosure works without application code "+mode);
    if(mode==="failed-scripts")assert.ok(blockedScripts>0,"the failed-script fixture actually blocks application scripts");
   }
   assert.equal(writes,0,"no writes "+mode);
   assert.equal(foreign,0,"no foreign requests "+mode);
   if(mode==="hydrated")assert.deepEqual(errors,[],"hydrated help has no page runtime error");
   console.log("AX2_HELP_SEARCH_AVAILABILITY:"+JSON.stringify({mode,writes,foreign,blockedScripts,pageErrors:errors.length,scope:"One public route at 390px; native fallback and hydrated filter only, not whole-product AAA."}));
  }finally{await context.close();}
 }
}
