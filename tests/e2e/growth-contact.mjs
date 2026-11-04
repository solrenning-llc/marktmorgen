import assert from "node:assert/strict";

/** Synthetic local app only; fixture data and intercepted CRM refusals. */
export async function checkGrowthAndContact({owner,LOCAL,abStore,second,contactToken,axeSource}) {
 const errors=[];
 const growth=await owner.context().newPage();
 growth.on("pageerror",error=>errors.push(String(error)));
 let previews=0;
 await growth.route("**/api/store/funnel-share*",async route=>{previews++;await route.abort();});
 try {
  await growth.emulateMedia({reducedMotion:"reduce"});
  for(const width of [320,390,768,1280]) {
   await growth.setViewportSize({width,height:900});
   for(const goal of ["leads","sales","services","retention"]) {
    await growth.waitForLoadState("networkidle");
    await growth.goto(LOCAL+"/studio/growth?store="+second+"&goal="+goal,{waitUntil:"domcontentloaded",timeout:60000});
    await growth.getByRole("heading",{name:"Choose your next business goal",exact:true}).waitFor();
    const goals=growth.getByRole("navigation",{name:"Growth goals"});
    assert.equal(await goals.locator('[aria-current="page"]').count(),1);
    const hrefs=await growth.locator('main a').evaluateAll(nodes=>nodes.map(node=>node.getAttribute("href")));
    assert(hrefs.length>=7&&hrefs.every(href=>href&&href.includes("store="+second)),"all growth destinations preserve selected store");
    assert.equal(await growth.locator("main").getByText("Your next steps",{exact:true}).count(),1);
    const review=growth.getByRole("region",{name:"Measure one change",exact:true});
    await review.waitFor();
    const comparison=review.locator("details"),toggle=comparison.locator("summary");
    await toggle.focus();await toggle.press("Enter");
    assert.equal(await comparison.getAttribute("open"),"");
    assert.equal(await comparison.locator("ol > li").count(),3);
    assert((await review.innerText()).includes({leads:"confirmed subscribers",sales:"Gross payments are not profit",services:"same enquiry cohort",retention:"same time to return"}[goal]));
    assert((await review.innerText()).includes("the result is inconclusive"));
    await toggle.press("Enter");assert.equal(await comparison.getAttribute("open"),null);
    const campaigns=growth.getByRole("region",{name:"Campaigns for this goal",exact:true});
    if(goal==="retention"){
      assert.equal(await campaigns.count(),0,"retention is not assigned an unrelated acquisition campaign");
    }else{
      await campaigns.waitFor();
      const cards=campaigns.locator(":scope > ul > li");
      assert.equal(await cards.count(),{leads:2,sales:2,services:2}[goal]);
      for(const details of await cards.locator("details").all()){
        const summary=details.locator("summary");
        await summary.focus();await summary.press("Enter");
        assert.equal(await details.getAttribute("open"),"","native keyboard disclosure opens");
        assert((await details.locator("ol > li").count())>0,"real template has journey steps");
        await summary.press("Enter");
        assert.equal(await details.getAttribute("open"),null,"native keyboard disclosure closes");
      }
      if(width===390){
        const names=await cards.locator("h3").allTextContents();
        await campaigns.getByRole("link",{name:"Explore matching campaigns",exact:true}).click();
        await growth.locator("#starter-goal").waitFor();
        assert.equal(await growth.locator("#starter-goal").inputValue(),goal);
        assert.equal(new URL(growth.url()).searchParams.get("store"),second);
        assert.deepEqual(await growth.locator("#campaign-starters h4").allTextContents(),names,"destination uses the same actual template catalog");
        await growth.waitForLoadState("networkidle");
        await growth.goBack({waitUntil:"domcontentloaded"});
        await growth.getByRole("heading",{name:"Choose your next business goal",exact:true}).waitFor();
      }
    }
    assert.equal(await growth.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0);
    await growth.addScriptTag({content:axeSource});
    const scan=await growth.evaluate(async()=>{const result=await window.axe.run(document.querySelector("main"),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}});return result.violations.map(rule=>({id:rule.id,targets:rule.nodes.map(node=>node.target)}));});
    assert.deepEqual(scan,[]);
   }
   console.log("  ok    growth4 goals preserve store/selection/AA/fit at "+width);
  }
  assert.equal(previews,0,"goal discovery and keyboard previews never request metered campaign setup");
 } finally {await growth.waitForLoadState("networkidle");await growth.close();}
 for(const width of [390,1280]) {
  const contact=await owner.context().newPage();
  contact.on("pageerror",error=>errors.push(String(error)));
  try {
   await contact.setViewportSize({width,height:900});
   await contact.emulateMedia({reducedMotion:"reduce"});
   const url=LOCAL+"/studio/people?store="+abStore+"&p="+contactToken;
   await contact.goto(url,{waitUntil:"domcontentloaded",timeout:60000});
   const company=contact.getByLabel("Company",{exact:true});
   await company.waitFor();
   const matched=contact.getByText("Contact fields match the last confirmed values.",{exact:true});
   const savedValue="Confirmed company "+width;
   await contact.waitForLoadState("networkidle");
   await company.fill(savedValue);
   await contact.getByText("1 contact field has unsaved changes.",{exact:true}).waitFor();
   const [savedResponse]=await Promise.all([contact.waitForResponse(response=>response.url().endsWith("/api/store/crm")&&response.request().method()==="POST"),company.press("Tab")]);
   try{await matched.waitFor();}catch(error){console.error("CONTACT_FIRST_SAVE_DIAGNOSTIC:"+JSON.stringify({width,status:savedResponse.status(),request:savedResponse.request().postDataJSON(),response:await savedResponse.json().catch(()=>null),actualValue:await company.inputValue(),expectedValue:savedValue,statuses:await contact.getByRole("status").allTextContents()}));throw error;}
   await contact.waitForLoadState("networkidle");
   await contact.reload({waitUntil:"domcontentloaded"});
   await company.waitFor();
   assert.equal(await company.inputValue(),savedValue,"real synthetic API save persists through reload");
   let requests=0,mode="refused",releasePending;
   const pendingGate=new Promise(resolve=>{releasePending=resolve;});
   await contact.route("**/api/store/crm",async route=>{
    requests++;
    if(mode==="pending"){await pendingGate;await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})});}
    else if(mode==="refused")await route.fulfill({status:400,contentType:"application/json",body:JSON.stringify({ok:false,error:"value"})});
    // Contradictory transport/body cannot be confirmed as saved.
    else await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({ok:true})});
   });
   const draft="Retained company "+width;
   await company.fill(draft);
   await Promise.all([contact.waitForResponse(response=>response.url().endsWith("/api/store/crm")),company.press("Tab")]);
   await contact.getByText("This field cannot keep that value. Your entry is still here; correct it and try again.",{exact:true}).waitFor();
   assert.equal(await company.inputValue(),draft);
   const save=contact.getByRole("button",{name:"Save Company",exact:true});
   assert.equal(await save.isEnabled(),true);
   mode="pending";
   await Promise.all([contact.waitForRequest(request=>request.url().endsWith("/api/store/crm")),save.click()]);
   assert.equal(await company.isDisabled(),true);
   assert.equal(await contact.getByLabel("Segment",{exact:true}).isDisabled(),true);
   await save.evaluate(node=>{node.click();node.click();});
   assert.equal(requests,2,"one request per refused attempt and explicit retry;pending duplicate blocked");
   releasePending();
   await matched.waitFor();
   assert.equal(await company.inputValue(),draft);
   mode="uncertain";
   await company.fill("Uncertain company "+width);
   await Promise.all([contact.waitForResponse(response=>response.url().endsWith("/api/store/crm")),company.press("Tab")]);
   await contact.getByText("This change could not be confirmed and may already be saved. Keep a copy of your values, then reload and check the contact before trying again. Saving is paused until you reload.",{exact:true}).waitFor();
   assert.equal(await save.isDisabled(),true);
   await company.fill("Keep this copy "+width);
   await company.press("Tab");
   await save.evaluate(node=>node.click());
   assert.equal(requests,3,"uncertain write is neither retried nor rolled back");
   assert.equal(await company.inputValue(),"Keep this copy "+width);
   await contact.evaluate(href=>{const link=document.createElement("a");link.id="fixture-leave-contact";link.href=href;link.textContent="Synthetic leave";document.body.append(link);},LOCAL+"/studio?store="+abStore);
   const dialogEvent=contact.waitForEvent("dialog");
   const navigation=contact.locator("#fixture-leave-contact").click();
   const dialog=await dialogEvent;
   assert.equal(dialog.type(),"confirm");
   await dialog.dismiss();
   await navigation;
   assert.equal(contact.url(),url,"declined departure preserves uncertain values");
   assert.equal(await company.inputValue(),"Keep this copy "+width);
   assert.equal(await contact.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0);
   await contact.addScriptTag({content:axeSource});
   const violations=await contact.evaluate(async()=>{const result=await window.axe.run(document.querySelector("main"),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}});return result.violations.map(rule=>rule.id);});
   assert.deepEqual(violations,[]);
   console.log("  ok    contact real-save/reload/refusal/retry/pending/uncertain/leave guard/AA/fit at "+width);
  } catch(error) {console.error("Synthetic contact recovery state:",await contact.locator("body").innerText().then(text=>text.slice(-6000)).catch(()=>"unreadable"));throw error;} finally {await contact.waitForLoadState("networkidle");await contact.close({runBeforeUnload:false});}
 }
 assert.deepEqual(errors,[],"growth/contact pages have no uncaught browser errors");
}
