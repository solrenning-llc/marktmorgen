/** Public navigation only; no accounts or external writes. */
export async function checkMenuMounting({browser,LOCAL,is}){
 const context=await browser.newContext({viewport:{width:390,height:900}});
 try{
  const page=await context.newPage();let writes=0;
  await page.route("**/api/**",async route=>{
   if(route.request().method()==="GET"){await route.continue();return;}
   writes++;await route.abort();
  });
  await page.goto(LOCAL+"/platform",{waitUntil:"networkidle",timeout:60000}); // VS1: the home page has its own short menu; the shared menu is checked on a feature page.
  const drawer=page.locator("#mobile-drawer");
  const toggle=page.getByRole("button",{name:"Open the menu",exact:true});
  is("closed mobile menu keeps its controlled container",await drawer.count(),1);
  is("closed mobile menu avoids hidden link hydration",await drawer.locator("a").count(),0);
  is("closed mobile menu toggle state",await toggle.getAttribute("aria-expanded"),"false");
  is("menu controlled ID preserved",await toggle.getAttribute("aria-controls"),"mobile-drawer");
  await toggle.focus();await page.keyboard.press("Enter");
  await page.getByRole("button",{name:"Close the menu",exact:true}).waitFor();
  is("opened mobile menu retains its links",(await drawer.locator("a").count())>20,true);
  await page.waitForFunction(()=>document.activeElement===document.querySelector("#mobile-drawer a"));
  is("mobile menu body scroll locked",await page.evaluate(()=>document.body.style.overflow),"hidden");
  await page.keyboard.press("Escape");
  await page.getByRole("button",{name:"Open the menu",exact:true}).waitFor();
  is("Escape returns focus to menu toggle",await page.evaluate(()=>document.activeElement?.getAttribute("aria-controls")),"mobile-drawer");
  await page.waitForFunction(()=>document.body.style.overflow==="");
  is("closed menu releases hidden links",await drawer.locator("a").count(),0);
  is("closed menu restores page scrolling",await page.evaluate(()=>document.body.style.overflow),"");
  await page.getByRole("button",{name:"Open the menu",exact:true}).click();
  await drawer.getByRole("link",{name:"Pricing",exact:true}).click();
  await page.waitForURL(url=>url.pathname==="/pricing");
  is("menu link reaches requested page",new URL(page.url()).pathname,"/pricing");
  is("navigation menu made no API writes",writes,0);
 }finally{await context.close();}
}
