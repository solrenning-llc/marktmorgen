import { checkToolsCalculator } from "./tools-calculator.mjs";
import { darkGrounds } from "./morning-grounds.mjs";
/** Public pricing only: no account, payment or outbound submission. */
export async function checkPricing({browser,LOCAL,axeSource,is}){
 await checkToolsCalculator({browser,LOCAL,is});
 const check=(condition,name)=>is(name,condition,true);
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   const page=await context.newPage();let writes=0;const errors=[];
   page.on("pageerror",error=>errors.push(error.message));
   await page.route("**/api/**",async route=>{if(route.request().method()!=="GET"){writes++;await route.abort();}else await route.continue();});
   await page.goto(LOCAL+"/pricing",{waitUntil:"domcontentloaded"});
   await page.locator("main h1").waitFor({state:"visible"});
   check(new URL(page.url()).pathname==="/pricing","pricing route is not redirected "+width);
   await page.locator('a[href="#content"]').first().focus();await page.keyboard.press("Enter");
   check(await page.locator("main").evaluate(node=>node===document.activeElement),"skip link focuses content "+width);
   check((await page.title()).includes("Pricing"),"pricing title "+width);
   // VS1 unit 2: the home page's menu, the page marked current in it, and no dark surface or slogan.
   check(JSON.stringify(await page.locator('nav[aria-label="Main"] a').evaluateAll(nodes=>nodes.map(node=>node.getAttribute("href"))))===JSON.stringify(["/","/pricing","/signin?to=login","/signin"]),"pricing has the home menu "+width);
   check(await page.locator('nav[aria-label="Main"] a[aria-current="page"]').getAttribute("href")==="/pricing","pricing marked current "+width);
   is("pricing has no dark surface "+width,await darkGrounds(page),[]);
   // The switch's names stay its words alone in either state (no drawn check mark read aloud).
   const cycle=page.getByRole("group",{name:"How often you pay"});
   check(await cycle.getByRole("button",{name:"Monthly",exact:true}).getAttribute("aria-pressed")==="true","pricing switch name and state "+width);
   check(await cycle.getByRole("button",{name:/^Yearly/}).count()===1,"pricing yearly name "+width);
   check(!/Your Stripe\. Your money|Your store\. Your Stripe|Your store · Your Stripe/.test(await page.locator("body").innerText()),"pricing has no ownership slogan "+width);
   check(await page.locator("main header").getByText("Paid plans and paid selling are not open yet.",{exact:false}).isVisible(),"pricing keeps paid selling closed "+width);
   // The page streams: React moves later parts into main from hidden holders
   // after the heading shows, so read the cards only once every price sentence
   // is inside main. A missing price still times out and fails below.
   await page.waitForFunction(()=>{const main=document.querySelector("main");return !!main&&["$690","$4,490","$9,990"].every(price=>main.textContent.includes("Or "+price+" once a year"))},null,{timeout:10000}).catch(()=>{});
   const text=await page.locator("main").innerText();
   // VS1: the plan cards with the monthly/yearly switch (components/home-parts.tsx) show each
   // monthly price with "a month" beside it and the annual price as "Or $690 once a year".
   for(const price of ["$69","$449","$999"])check(await page.locator("[data-plan-prices] [data-pricing-card]").filter({hasText:price+"a month"}).count()+await page.locator("[data-plan-prices] [data-pricing-card]").filter({hasText:price+" a month"}).count()>=1,"pricing shows "+price+" a month "+width);
   for(const price of ["$690","$4,490","$9,990"])check(text.includes("Or "+price+" once a year"),"pricing shows "+price+" a year "+width);
   check(await page.locator("main a[href='/proof/comparisons']").count()===1,"real comparison destination "+width);
   for(const summary of await page.locator("main summary").all()){
    await summary.focus();
    check(await summary.evaluate(node=>node===document.activeElement),"FAQ summary has keyboard focus "+width);
    await page.keyboard.press("Enter");
    // Native disclosure state settles in the browser; an immediate read can
    // race the keyboard default action. A broken toggle must still time out.
    await page.waitForFunction(node=>node.parentElement?.open===true,await summary.elementHandle(),{timeout:5000});
    check(await summary.evaluate(node=>node.parentElement.open),"FAQ opens by keyboard "+width);
    await page.keyboard.press("Enter");
    await page.waitForFunction(node=>node.parentElement?.open===false,await summary.elementHandle(),{timeout:5000});
    check(await summary.evaluate(node=>node.parentElement.open===false),"FAQ closes by keyboard "+width);
   }
   check((await page.locator("main").innerText()).includes("Stripe charges its own processing fee"),"processing separate "+width);
   check(await page.locator("main").evaluate(node=>node.scrollWidth<=node.clientWidth+1),"pricing fits viewport "+width);
   await page.addScriptTag({content:axeSource});
   const audit=await page.evaluate(async()=>await window.axe.run(document.querySelector("main"),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}}));
   check(audit.violations.length===0,"pricing accessibility "+width+" "+audit.violations.map(v=>v.id).join(","));
   check(errors.length===0,"pricing no browser errors "+width);check(writes===0,"pricing no API writes "+width);
  }finally{await context.close();}
 }
 // 243 [CF6], the owner's complement of 31/10/2026 23h14: on a 1280 x 720 screen the three plans, with their price,
 // start on the first screen, and no card shows a limit figure twice (its itemized list is closed until pressed).
 {
  const context=await browser.newContext({viewport:{width:1280,height:720}});
  try{
   const page=await context.newPage();
   await page.goto(LOCAL+"/pricing",{waitUntil:"domcontentloaded"});
   await page.locator("main h1").waitFor({state:"visible"});
   await page.waitForFunction(()=>document.querySelectorAll("main [data-plan-prices] [data-pricing-card]").length===3,null,{timeout:10000}).catch(()=>{});
   const cards=page.locator("main [data-plan-prices] [data-pricing-card]");
   check(await cards.count()===3,"pricing three plan cards 1280x720");
   const tops=await cards.evaluateAll(nodes=>nodes.map(node=>{const price=node.querySelector("[data-cycle-text]");return [node.getBoundingClientRect().top,price?price.getBoundingClientRect().bottom:Infinity];}));
   check(tops.length===3&&tops.every(([top,price])=>top<720&&price<=720),"pricing plans and their prices on the first screen 1280x720 "+JSON.stringify(tops));
   const texts=await cards.evaluateAll(nodes=>nodes.map(node=>node.innerText));
   const repeated=texts.map(text=>{const seen=new Map();for(const m of text.matchAll(/(?<![\d,.])(\d{1,3}(?:,\d{3})+|\d+)(?![\d,])\s+(visits|orders|list emails|emails|sends|AI writing jobs|visitor answers|GB)/g)){const unit=m[2]==="emails"||m[2]==="sends"?"list emails":m[2];const key=m[1]+" "+unit;seen.set(key,(seen.get(key)??0)+1);}return [...seen].filter(([,n])=>n>1).map(([k])=>k);});
   is("pricing no limit figure twice in a card 1280x720",repeated,[[],[],[]]);
   check(await page.locator("main [data-plan-terms]").count()===1,"pricing terms said once under the plans 1280x720");
  }finally{await context.close();}
 }
}
