/** All shipment writes are intercepted; no buyer mail or provider payment is submitted. */
export async function checkShipmentAcknowledgment({browser,LOCAL,fixture,shipment,is}){
 const shipped={at:1790000000,tracking:"https://example.test/tracking"};
 const scenarios=[
  {name:"HTTP failure",status:500,body:{ok:true,shipped,emailed:true}},
  {name:"truthy confirmation",body:{ok:"true",shipped,emailed:true}},
  {name:"missing email status",body:{ok:true,shipped}},
  {name:"truthy email status",body:{ok:true,shipped,emailed:"true"}},
  {name:"missing record",body:{ok:true,emailed:true}},
  {name:"invalid timestamp",body:{ok:true,shipped:{...shipped,at:-1},emailed:true}},
  {name:"invalid tracking",body:{ok:true,shipped:{...shipped,tracking:"javascript:alert(1)"},emailed:true}},
  {name:"contradictory error",body:{ok:true,shipped,emailed:true,error:"unknown"}},
  {name:"malformed JSON",raw:"<html>unknown</html>"},
  {name:"lost reply",abort:true},
  {name:"known refusal",status:400,body:{ok:false,error:"unknown"},known:true},
  {name:"confirmed without email",body:{ok:true,shipped,emailed:false},confirmed:true,emailed:false},
  {name:"confirmed with email",body:{ok:true,shipped,emailed:true},confirmed:true,emailed:true},
 ];
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let pending=null,writes=0,otherWrites=0;
   const pageErrors=[],posts=[];
   page.on("pageerror",error=>pageErrors.push(String(error).slice(0,2000)));
   page.on("request",request=>{if(request.method()==="POST"&&new URL(request.url()).pathname==="/api/store/shipped")posts.push(Date.now());});
   await page.route("**/api/**",async route=>{
    if(route.request().method()==="GET"){await route.continue();return;}
    if(new URL(route.request().url()).pathname!=="/api/store/shipped"){otherWrites++;await route.abort();return;}
    if(!pending)throw Error("Unexpected shipment write");
    const work=pending;writes++;await work.release;
    if(work.scenario.abort){await route.abort();return;}
    await route.fulfill({status:work.scenario.status??200,contentType:"application/json",body:work.scenario.raw??JSON.stringify(work.scenario.body)});
   });
   for(const scenario of scenarios){
    await page.goto(LOCAL+"/studio?store="+fixture.sid+"&shipment_case="+encodeURIComponent(scenario.name)+"#sales",{waitUntil:"networkidle",timeout:60000});
    is("synthetic shipment row is visible "+scenario.name+"/"+width,await page.locator("#sales").getByText("Synthetic shipment",{exact:true}).count(),1);
    const form=page.locator('#sales form').filter({has:page.getByLabel("Tracking link (optional)",{exact:true})});
    const field=form.getByLabel("Tracking link (optional)",{exact:true});
    await field.fill("https://example.test/chosen");
    let release;const held=new Promise(resolve=>{release=resolve;});pending={scenario,release:held};
    const started=Date.now(),postStart=posts.length,errorStart=pageErrors.length,writesStart=writes;
    let phase="waiting-request",seenOutcome={state:"pending"},clickOutcome={state:"pending"};
    const seen=page.waitForRequest(request=>request.method()==="POST"&&new URL(request.url()).pathname==="/api/store/shipped",{timeout:15000});
    seen.then(()=>{seenOutcome={state:"fulfilled",afterMs:Date.now()-started};},error=>{seenOutcome={state:"rejected",afterMs:Date.now()-started,error:String(error).slice(0,2000)};}).catch(()=>{});
    // Keep the reply held for busy-state assertions without awaiting click completion first.
    // Firefox may wait for effects of the submit action until that reply is released.
    const click=form.getByRole("button",{name:"Mark as shipped",exact:true}).click({noWaitAfter:true});
    // Attach the rejection handler immediately, including when the request
    // fails first and context cleanup later rejects the pending click.
    click.then(()=>{clickOutcome={state:"fulfilled",afterMs:Date.now()-started};},error=>{clickOutcome={state:"rejected",afterMs:Date.now()-started,error:String(error).slice(0,2000)};}).catch(()=>{});
    let failed=false,originalError,failurePhase,failureAfterMs,releasedAfterMs;
    try{
     const request=await seen;phase="parsing-request";
     const sent=request.postDataJSON();phase="checking-pending-state";
     is("shipment request preserves chosen values "+scenario.name+"/"+width,[sent.session,sent.tracking],[shipment,"https://example.test/chosen"]);
     is("shipment tracking locks while waiting "+scenario.name+"/"+width,await field.isDisabled(),true);
     is("shipment button locks while waiting "+scenario.name+"/"+width,await form.getByRole("button").isDisabled(),true);
     is("shipment form announces pending state "+scenario.name+"/"+width,await form.getAttribute("aria-busy"),"true");
    }catch(error){failed=true;originalError=error;failurePhase=phase;failureAfterMs=Date.now()-started;}
    finally{
     release();phase="reply-released";releasedAfterMs=Date.now()-started;
     // A secondary click error must not replace the first awaited error.
     if(!failed){try{phase="awaiting-click";await click;}catch(error){failed=true;originalError=error;failurePhase=phase;failureAfterMs=Date.now()-started;}}
    }
    if(failed){
     try{
     let timer;
     const snapshot=Promise.resolve().then(()=>page.evaluate(()=>{
      const form=[...document.querySelectorAll('#sales form')].find(node=>node.querySelector('input[type="url"]'));
      return {url:location.href,ready:document.readyState,activeElement:document.activeElement?.tagName,
       form:form?.outerHTML.slice(0,5000)??null,busy:form?.getAttribute("aria-busy")??null,
       disabled:form?.querySelector("button")?.disabled??null};
     })).catch(error=>({captureError:String(error).slice(0,1000)}));
     let dom;
     try{dom=await Promise.race([snapshot,new Promise(resolve=>{timer=setTimeout(()=>resolve({captureTimedOut:true}),500);})]);}
     catch(error){dom={captureError:String(error).slice(0,1000)};}finally{clearTimeout(timer);}
     console.error("SHIPMENT_ACTION_FAILURE:"+JSON.stringify({scenario:scenario.name,width,phase,failurePhase,failureAfterMs,releasedAfterMs,
      afterMs:Date.now()-started,url:page.url(),postCount:posts.length-postStart,postAfterMs:posts.slice(postStart).map(at=>at-started),
      interceptedWrites:writes-writesStart,seenOutcome,clickOutcome,pageErrors:pageErrors.slice(errorStart),dom,
      originalError:String(originalError).slice(0,3000)}));
     }catch{/* Best-effort diagnostics never replace the original failure. */}
     throw originalError;
    }
    if(scenario.confirmed){
     const status=page.locator("#sales").getByRole("status");await status.waitFor();
     is("confirmed shipment has truthful persistent status "+scenario.name+"/"+width,(await status.innerText()).includes("Marked as shipped on"),true);
     is("persistent shipment never asserts email delivery "+scenario.name+"/"+width,/told|emailed/.test(await status.innerText()),false);
     await page.locator('.nb-toast-region [role="status"]').getByText(scenario.emailed?"Marked as shipped. The buyer was emailed.":"Marked as shipped. No new email was confirmed.",{exact:true}).waitFor();
     is("confirmed tracking remains safe "+scenario.name+"/"+width,await status.getByRole("link").getAttribute("href"),shipped.tracking);
    }else{
     const alert=form.getByRole("alert");await alert.waitFor();
     is("unconfirmed shipment remains unconfirmed "+scenario.name+"/"+width,(await alert.innerText()).includes(scenario.known?"That order could not be found":"The shipment was not confirmed"),true);
     is("unconfirmed shipment keeps chosen tracking "+scenario.name+"/"+width,await field.inputValue(),"https://example.test/chosen");
     is("shipment controls unlock after refusal "+scenario.name+"/"+width,await field.isEnabled(),true);
     is("refused shipment has no completed status "+scenario.name+"/"+width,await page.locator("#sales").getByRole("status").count(),0);
    }
    is("shipment panel fits viewport "+scenario.name+"/"+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   }
   is("shipment writes all intercepted "+width,writes,scenarios.length);
   is("no other write from shipment scenarios "+width,otherWrites,0);
  }finally{await context.close();}
 }
}
