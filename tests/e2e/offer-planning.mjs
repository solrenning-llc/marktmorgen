export async function checkOfferPlanning({browser,LOCAL,fixture,axeSource,is}){
 for(const width of [390,1280]){
 const context=await browser.newContext({viewport:{width,height:1000}});try{
 await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);const page=await context.newPage();let writes=0;
 await page.route("**/api/**",route=>{if(!["GET","HEAD"].includes(route.request().method())){writes++;return route.abort();}return route.continue();});
 await page.goto(LOCAL+"/studio/funnels?store="+fixture.sid+"&product="+fixture.product);const panel=page.locator("[data-offer-planning]");await panel.waitFor();
 is("HT14 explicit local rule "+width,(await panel.innerText()).includes("lower-middle observed price"),true);
 is("HT14 no sale forecast "+width,(await panel.innerText()).includes("does not predict sales"),true);
 is("HT14 gates remain visible "+width,(await panel.innerText()).includes("Paid selling remains subject to every opening and fiscal gate"),true);
 await panel.getByRole("button",{name:"Reject suggestion",exact:true}).click();await panel.getByText("Suggestion dismissed. Your current prices and funnels are unchanged.",{exact:true}).waitFor();
 is("HT14 rejection makes no change "+width,writes,0);
 await panel.getByRole("button",{name:"Review the suggestion again",exact:true}).click();await panel.getByRole("button",{name:"Accept as unsaved plan",exact:true}).click();
 const draft=panel.getByRole("textbox",{name:"Your unsaved offer plan",exact:true});is("HT14 accepted reference is unsaved "+width,(await draft.inputValue()).includes("Starting price reference:"),true);
 await draft.fill((await draft.inputValue())+"\n\nMy own delivery check.");is("HT14 creator can edit proposed plan "+width,(await draft.inputValue()).endsWith("My own delivery check."),true);
 is("HT14 no automatic save/AI/activation "+width,writes,0);
 // The panel's top under the sticky studio header (html scroll-padding-top), as a creator scrolling to it sees it: a
 // position left by the edits above can leave its first field half behind the header, which axe reads as a small target.
 await panel.evaluate(node=>node.scrollIntoView({block:"start",behavior:"instant"}));await page.addScriptTag({content:axeSource});const audit=await page.evaluate(async()=>await window.axe.run(document.querySelector("[data-offer-planning]"),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}}));is("HT14 planner accessibility "+width,audit.violations.map(v=>v.id),[]);
 is("HT14 planner fits "+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await panel.getByRole("button",{name:"Discard this plan",exact:true}).click();
 }finally{await context.close();}
 }
}
