/** HT3 static value before plan prices on both existing routes; no paid action. */
export async function checkPricingValue({browser,LOCAL,axeSource,is}){
 const names=["Checkout","Upsells","Affiliates","Funnels","Email automation","Community","Courses","Video calls","Analytics","CRM"];
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:1000}});
  try{
   const page=await context.newPage();let writes=0;
   await page.route("**/api/**",async route=>{if(route.request().method()!=="GET"){writes++;await route.abort();}else await route.continue();});
   for(const path of ["/pricing"]){ // VS1: the home page keeps one plan card and a link here; the value list lives on pricing.
    await page.goto(LOCAL+path,{waitUntil:"domcontentloaded",timeout:60000});
   // These checks inspect the settled document, including streamed home sections.
   await page.waitForLoadState("networkidle");
    const value=page.locator("[data-pricing-value]"),prices=page.locator("[data-plan-prices]");
    is("HT3 ten benefit categories "+path+"/"+width,await value.locator(":scope > ul h3").allInnerTexts(),names);
    // 243 [CF6], the owner's complement of 31/10/2026: on /pricing the plans come first, the value list after them.
    is("HT3 prices precede value "+path+"/"+width,await value.evaluate((node,target)=>Boolean(node.compareDocumentPosition(document.querySelector(target))&Node.DOCUMENT_POSITION_PRECEDING),"[data-plan-prices]"),true);
    is("HT3 plan section retained "+path+"/"+width,await prices.count(),1);
    for(const link of await value.locator('a[href^="/platform/"]').all()){
     await link.focus();is("HT3 feature keyboard "+path+"/"+width,await link.evaluate(node=>node===document.activeElement),true);
     is("HT3 feature target "+path+"/"+width,await link.evaluate(node=>node.getBoundingClientRect().height>=44),true);
    }
    const models=value.locator("[data-pricing-fee-models]"),text=await models.innerText();
    is("HT3 fee scope retained "+path+"/"+width,text.includes("above $15")&&text.includes("9.9% + $1.00"),true);
    is("HT3 source date visible "+path+"/"+width,text.includes("2026-10-20"),true);
    is("HT3 separate Stripe costs "+path+"/"+width,text.includes("Stripe processing, optional add-ons and applicable taxes remain separate"),true);
    is("HT3 no lower-bill promise "+path+"/"+width,text.includes("Neither model is a promise of the lower total bill"),true);
    is("HT3 existing official pricing source "+path+"/"+width,await models.locator('a[href="https://hotmart.com/en/pricing"]').count(),1);
    is("HT3 existing official policy source "+path+"/"+width,await models.locator('a[href="https://hotmart.com/en/legal/payments-policy"]').count(),1);
    // Said once on /pricing, above the plans (243 [CF6]); the value list no longer repeats it there.
    is("HT3 closed-sale notice said once, above the plans "+path+"/"+width,[(await page.locator("main header").innerText()).includes("Paid plans and paid selling are not open yet"),await value.locator("[data-pricing-value-closed]").count()],[true,0]);
    is("HT3 reuses existing calculator "+path+"/"+width,await models.getByRole("link",{name:"Compare costs with your applicable fee quotes",exact:true}).getAttribute("href"),path==="/"?"/pricing#calculator-heading":"#calculator-heading");
    is("HT3 benefit section fits "+path+"/"+width,await value.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
    is("HT3 page fits "+path+"/"+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.addScriptTag({content:axeSource});
    const audit=await value.evaluate(async node=>(await window.axe.run(node,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}})).violations.map(v=>v.id));
    is("HT3 benefits accessibility "+path+"/"+width,audit,[]);
   }
   is("HT3 no API write "+width,writes,0);
  }finally{await context.close();}
 }
}
