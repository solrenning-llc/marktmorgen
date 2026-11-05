export async function checkStoreActivation({browser,LOCAL,fixture,axeSource,is}){
 for(const width of [390,1280]){
 const context=await browser.newContext({viewport:{width,height:1000}});try{
 await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);const page=await context.newPage();let aiWrites=0,otherWrites=0;
 await page.route("**/api/**",async route=>{
  const request=route.request();if(["GET","HEAD"].includes(request.method()))return route.continue();
  if(new URL(request.url()).pathname==="/api/store/ai"){aiWrites++;is("HT5 existing setup request "+width,request.postDataJSON().kind,"setup");return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,value:{bios:["Synthetic bio"],products:[{title:"Synthetic draft",summary:"Review the delivery",kind:"download",price:"12"}],faq:[]},left:9})});}
  otherWrites++;return route.abort();
 });
 await page.goto(LOCAL+"/studio?store="+fixture.sid);
 const guide=page.locator('[aria-labelledby="start-title"]'),draft=page.locator("#setup-ai");
 is("HT5 no automatic AI request "+width,aiWrites,0);
 is("HT5 existing draft shown "+width,await draft.count(),1);
 is("HT5 draft before checklist "+width,await draft.evaluate(node=>!!(node.compareDocumentPosition(document.querySelector('[aria-labelledby="start-title"]'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
 is("HT5 registration clock honest "+width,(await guide.innerText()).includes("This measures store registration, not an earlier sign-in or a sale."),true);
 is("HT5 manual publication step "+width,(await guide.innerText()).includes("Publish your first offer yourself"),true);
 await guide.locator("summary",{hasText:"Review the saved launch checklist"}).click();is("HT5 shared checklist "+width,(await guide.innerText()).includes("saved store activation checklist"),true);
 await draft.locator("#setup-about").fill("I sell a synthetic lesson checklist.");
 await draft.getByRole("button",{name:"Draft my store",exact:true}).click();
 await draft.getByText("Products, as drafts",{exact:true}).waitFor();
 is("HT5 only requested existing AI operation "+width,aiWrites,1);
 is("HT5 no setup or publication write "+width,otherWrites,0);
 is("HT5 draft reviewed before keep "+width,await draft.locator("#setup-title-0").inputValue(),"Synthetic draft");
 is("HT5 manual gate copy "+width,(await draft.innerText()).includes("choose Publish yourself"),true);
 is("HT5 activation fits viewport "+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.addScriptTag({content:axeSource});const violations=await page.evaluate(async()=>{const results=[await window.axe.run(document.querySelector("#setup-ai"),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}}),await window.axe.run(document.querySelector('[aria-labelledby="start-title"]'),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}})];return results.flatMap(r=>r.violations.map(v=>v.id));});
 is("HT5 activation accessibility "+width,violations,[]);
 }finally{await context.close();}
 }
}
