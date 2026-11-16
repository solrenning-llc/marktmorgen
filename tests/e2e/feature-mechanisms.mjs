const paths=["/platform/crm","/platform/store-page","/platform/price-options","/platform/courses","/platform/memberships","/platform/calls","/platform/checkout","/platform/your-stripe","/platform/instant-delivery","/platform/email","/platform/domain","/platform/insights","/platform/community","/platform/live-events","/platform/funnels","/platform/bundles","/platform/affiliates","/platform/calendar-sync","/platform/webhooks","/platform/quizzes-and-certificates","/platform/discord-access","/platform/license-keys","/platform/pdf-stamping","/platform/sales-pages","/platform/ai-writing","/platform/reviews","/platform/currencies-and-ways-to-pay","/platform/email-platforms","/platform/outreach","/platform/teams-and-stores","/platform/phone-notifications","/platform/switching-to-marktmorgen","/platform/move-from-clickfunnels","/platform/move-from-gumroad","/platform/move-from-teachable","/platform/security","/for/coaches","/for/cooks","/for/fitness","/for/designers"];
export async function checkFeatureMechanisms({browser,LOCAL,axeSource,is}){
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   const page=await context.newPage();let writes=0;
   await page.route("**/api/**",async route=>{if(route.request().method()!=="GET"){writes++;await route.abort();}else await route.continue();});
   for(const path of paths){
    await page.goto(LOCAL+path,{waitUntil:"domcontentloaded",timeout:60000});
    await page.locator("main h1").waitFor({state:"visible"});
    const heading=page.getByRole("heading",{name:"A practical way to use it",exact:true});
    const section=heading.locator("xpath=ancestor::section[1]");
    await section.scrollIntoViewIfNeeded();
    for(const node of await section.locator(".reveal").all()){await node.scrollIntoViewIfNeeded();await page.waitForFunction(element=>getComputedStyle(element).opacity==="1",await node.elementHandle(),{timeout:5000});}
    await page.waitForFunction(element=>getComputedStyle(element).opacity==="1",await section.elementHandle(),{timeout:5000});
    is("factual mechanism present "+path+" "+width,await heading.count(),1);
    is("mechanism fits "+path+" "+width,await section.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
    await page.addScriptTag({content:axeSource});
    const audit=await section.evaluate(async node=>(await window.axe.run(node,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}})).violations.map(v=>v.id));
    is("mechanism accessibility "+path+" "+width,audit,[]);
   }
   is("mechanism reads make no API writes "+width,writes,0);
  }finally{await context.close();}
 }
}
