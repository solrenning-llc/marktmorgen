/** The real editor's local keyboard operations; no save or AI call is needed. */
export async function checkFaqEditorKeyboard({page,section,is}){
 const add=section.getByRole("button",{name:"Add a question",exact:true});
 const questions=section.locator("input");
 const focused=()=>page.evaluate(()=>document.activeElement?.id??"");
 const press=async button=>{await button.focus();await button.press("Enter");};
 for(let n=0;n<3;n++){
  await press(add);
  is("FAQ new question receives keyboard focus "+n,await focused(),await questions.nth(n).getAttribute("id"));
  await questions.nth(n).fill(["Alpha?","Beta?","Gamma?"][n]);
  await section.locator("textarea").nth(n).fill(["Alpha answer.","Beta answer.","Gamma answer."][n]);
 }
 // A move may disable its own button at the boundary: focus must survive it.
 await press(section.getByRole("button",{name:"Move up question 2",exact:true}));
 is("FAQ reordered question keeps its own focus",await focused(),await questions.nth(0).getAttribute("id"));
 is("FAQ moving keeps question/answer pairs",await section.locator("input,textarea").evaluateAll(nodes=>nodes.map(n=>n.value)),["Beta?","Beta answer.","Alpha?","Alpha answer.","Gamma?","Gamma answer."]);
 await press(section.getByRole("button",{name:"Move down question 1",exact:true}));
 is("FAQ downward move follows the same question",await focused(),await questions.nth(1).getAttribute("id"));
 const controls=section.locator("li button");
 is("FAQ action names are distinct",await controls.evaluateAll(nodes=>new Set(nodes.map(n=>n.getAttribute("aria-label")??n.textContent.trim())).size),9);
 is("FAQ action targets are at least 44 by 44",await controls.evaluateAll(nodes=>nodes.every(n=>{const r=n.getBoundingClientRect();return r.width>=44&&r.height>=44;})),true);
 await press(section.getByRole("button",{name:"Remove question 2",exact:true}));
 is("FAQ middle removal focuses the following question",await focused(),await questions.nth(1).getAttribute("id"));
 is("FAQ removal preserves its neighbors",await questions.evaluateAll(nodes=>nodes.map(n=>n.value)),["Alpha?","Gamma?"]);
 await press(section.getByRole("button",{name:"Remove question 2",exact:true}));
 is("FAQ last removal focuses the previous question",await focused(),await questions.nth(0).getAttribute("id"));
 await press(section.getByRole("button",{name:"Remove question 1",exact:true}));
 is("FAQ empty list returns focus to Add",await add.evaluate(n=>n===document.activeElement),true);
}

/** Local fixture only. Every manual save and AI request is intercepted. */
export async function checkFaqAcknowledgment({browser,LOCAL,fixture,is}){
 const cases=[
  {name:"HTTP failure",status:500,reply:v=>({ok:true,faq:v})},
  {name:"truthy ok",reply:v=>({ok:"true",faq:v})},
  {name:"missing saved list",reply:()=>({ok:true})},
  {name:"null response",reply:()=>null},
  {name:"array response",reply:v=>[{ok:true,faq:v}]},
  {name:"missing item",reply:v=>({ok:true,faq:v.slice(1)})},
  {name:"different order",reply:v=>({ok:true,faq:[...v].reverse()})},
  {name:"different question",reply:v=>({ok:true,faq:[{...v[0],q:"Different"},v[1]]})},
  {name:"different answer",reply:v=>({ok:true,faq:[{...v[0],a:"Different"},v[1]]})},
  {name:"invalid item",reply:()=>({ok:true,faq:[null,null]})},
  {name:"contradictory error",reply:v=>({ok:true,faq:v,error:"server_error"})},
  {name:"malformed JSON",raw:"<html>Error</html>"},
  {name:"lost reply",abort:true},
  {name:"unnormalized echo",reply:v=>({ok:true,faq:[{...v[0],q:"  First   question?  "},v[1]]})},
  {name:"canonical saved list",reply:v=>({ok:true,faq:v}),confirmed:true}
 ];
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let work=null,requests=0,aiRequests=0;
   await page.route("**/api/store/ai",async route=>{aiRequests++;await route.abort("failed");});
   await page.route("**/api/store/faq",async route=>{
    if(!work)throw Error("Unexpected FAQ write");requests++;const pending=work;await pending.held;
    const normalizeQ=v=>v.replace(/[\u0000-\u001f\u007f]+/g," ").replace(/\s+/g," ").trim();
    const value=route.request().postDataJSON().items.map(v=>({q:normalizeQ(v.q),a:v.a.replace(/\r\n/g,"\n").trim()}));
    if(pending.scenario.abort){await route.abort("failed");return;}
    await route.fulfill({status:pending.scenario.status??200,contentType:"application/json",body:pending.scenario.raw??JSON.stringify(pending.scenario.reply(value))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   const section=page.locator("section#faq");await section.waitFor({state:"visible"});
   while(await section.getByRole("button",{name:/^Remove(?: question \d+)?$/}).count())await section.getByRole("button",{name:/^Remove(?: question \d+)?$/}).first().click();
   await checkFaqEditorKeyboard({page,section,is});
   await section.getByRole("button",{name:"Add a question",exact:true}).click();
   await section.getByRole("button",{name:"Add a question",exact:true}).click();
   const questions=section.locator("input");const answers=section.locator("textarea");
   for(const scenario of cases){
    await questions.nth(0).fill("  First   question?  ");await questions.nth(1).fill("Second question?");
    await answers.nth(0).fill("Écrivez votre question.\n\nKeep this paragraph.");await answers.nth(1).fill("Second answer.");
    let release;const held=new Promise(resolve=>{release=resolve;});work={scenario,held};
    const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/faq");seen.catch(()=>{});
    const name=scenario.name+"/"+width;
    try{
     await section.getByRole("button",{name:"Save questions",exact:true}).click();const input=(await seen).postDataJSON();
     is("FAQ creator question preserved "+name,input.items[0].q,"  First   question?  ");
     is("FAQ announces pending "+name,await section.getAttribute("aria-busy"),"true");
     is("FAQ pending controls lock "+name,await section.locator("input,textarea,button").evaluateAll(nodes=>nodes.every(n=>n.disabled)),true);
    }finally{release();}
    if(scenario.confirmed){
     await page.locator(".nb-toast-region [role=status]").getByText("Questions saved.",{exact:true}).waitFor({state:"attached"});
    }else{
     const status=section.getByRole("status");await status.getByText("We could not confirm whether your questions were saved. Reload this page to check before trying again.",{exact:true}).waitFor();
     is("FAQ no false success "+name,await page.getByText("Questions saved.",{exact:true}).count(),0);
     is("FAQ draft question retained "+name,await questions.nth(0).inputValue(),"  First   question?  ");
     is("FAQ draft answer retained "+name,await answers.nth(0).inputValue(),"Écrivez votre question.\n\nKeep this paragraph.");
     is("FAQ edits unlock "+name,await questions.nth(0).isEnabled(),true);
    }
    is("FAQ document fits "+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   }
   is("FAQ writes intercepted "+width,requests,cases.length);is("FAQ no AI call "+width,aiRequests,0);
  }finally{await context.close();}
 }
}
