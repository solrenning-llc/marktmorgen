/** Native skip activation: no scripted focus and no application writes. */
export async function checkHomeSkipFocus({page,is,label}){
 await page.bringToFront();
 await page.keyboard.press("Tab");
 is("home skip link is the first keyboard target "+label,await page.locator('a[href="#content"]').evaluate(node=>node===document.activeElement),true);
 await page.keyboard.press("Enter");
 await page.waitForFunction(()=>document.activeElement===document.querySelector("main#content"),undefined,{timeout:3000});
 is("home skip link focuses its main destination "+label,await page.locator("main#content").evaluate(node=>node===document.activeElement),true);
 await page.keyboard.press("Tab");
 is("home next Tab continues inside content "+label,await page.locator("main#content").evaluate(node=>node.contains(document.activeElement)),true);
}

/** VS1 (owner, 30/10/2026): one start action in the menu, the address field at the top and at the end, one plan button; all lead to the existing start page. No writes. */
export async function checkHomeActions({browser,LOCAL,axeSource,is}){
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   const page=await context.newPage();let writes=0;
   await page.route("**/api/**",async route=>{if(route.request().method()!=="GET"){writes++;await route.abort();}else await route.continue();});
   await page.goto(LOCAL+"/",{waitUntil:"domcontentloaded",timeout:60000});
   await checkHomeSkipFocus({page,is,label:String(width)});
   // 498 [ME3] (owner, 28/10/2026): at most 600 words and 30 links on the whole home page, header, footer and closed answers included.
   if(width===1280){
    // One measure for both: everything in the document, closed answers included, scripts and styles left out.
    const size=await page.evaluate(()=>{const copy=document.body.cloneNode(true);copy.querySelectorAll("script,style,noscript,template").forEach(node=>node.remove());return {words:copy.textContent.split(/\s+/).filter(word=>/[A-Za-z0-9]/.test(word)).length,links:copy.querySelectorAll("a[href]").length};});
    is("ME3 home page at most 600 words and 30 links",[size.words<=600,size.links<=30,size],[true,true,size]);
   }
   const nav=page.getByRole("navigation",{name:"Main",exact:true});
   is("menu has the home link, Pricing, Log in and Start your store "+width,await nav.locator("a").evaluateAll(nodes=>nodes.map(node=>node.getAttribute("aria-label")??node.textContent.trim())),["Marktmorgen, home","Pricing","Log in","Start your store"]);
   is("menu destinations "+width,await nav.locator("a").evaluateAll(nodes=>nodes.map(node=>node.getAttribute("href"))),["/","/pricing","/signin?to=login","/signin"]);
   const forms=page.locator("[data-home-claim]");
   is("address field at the top and at the end "+width,await forms.count(),2);
   for(const form of await forms.all()){
    is("address form goes to the start page "+width,[await form.getAttribute("action"),await form.getAttribute("method")],["/signin","get"]);
    is("address form label "+width,await form.locator("label").innerText(),"Pick your store address");
    const button=form.getByRole("button",{name:"Claim it",exact:true});
    is("address button large "+width,await button.evaluate(n=>n.getBoundingClientRect().height>=44),true);
    await form.scrollIntoViewIfNeeded();
    is("address form fits "+width,await form.evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
    await page.addScriptTag({content:axeSource});const issues=await form.evaluate(async n=>(await window.axe.run(n,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}})).violations.map(v=>v.id));is("address form accessibility "+width,issues,[]);
   }
   const plan=page.locator("[data-home-plan]");
   is("plan button goes to the start page "+width,await plan.getByRole("link",{name:"Start your store",exact:true}).getAttribute("href"),"/signin");
   is("compare all plans "+width,await page.getByRole("link",{name:"Compare Store, Studio and Scale",exact:true}).getAttribute("href"),"/pricing#plans");
   // The end form submits as a plain form, before or without any script.
   const end=forms.nth(1);await end.getByLabel("Pick your store address",{exact:true}).fill("ada");
   const arrival=page.waitForURL(url=>url.pathname==="/signin");await end.getByRole("button",{name:"Claim it",exact:true}).click();await arrival;
   is("end form carries the address "+width,new URL(page.url()).searchParams.get("handle"),"ada");
   is("home actions make no API writes "+width,writes,0);
  }finally{await context.close();}
 }
 // The skip link is native and must work before or without application scripts.
 const plain=await browser.newContext({viewport:{width:390,height:900},javaScriptEnabled:false,serviceWorkers:"block"});
 try{
  let writes=0;
  await plain.route("**/*",route=>{
   if(!["GET","HEAD"].includes(route.request().method())){writes++;return route.abort();}
   return route.continue();
  });
  const page=await plain.newPage();
  await page.goto(LOCAL+"/",{waitUntil:"domcontentloaded",timeout:60000});
  await checkHomeSkipFocus({page,is,label:"390 without application JavaScript"});
  is("home skip link without scripts performs no writes",writes,0);
 }finally{await plain.close();}
}
