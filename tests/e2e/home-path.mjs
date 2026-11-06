export async function checkHomePath({browser,LOCAL,axeSource,is}){
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   const page=await context.newPage();let writes=0;
   await page.route("**/api/**",async route=>{if(route.request().method()!=="GET"){writes++;await route.abort();}else await route.continue();});
   // VS1 (owner, 30/10/2026): the Path summary left the home page. The feature
   // page links the Path page, which keeps every mission and caveat.
   await page.goto(LOCAL+"/platform",{waitUntil:"domcontentloaded",timeout:60000});
   const link=page.locator('main a[href="/platform/path"]').first();
   is("Path discovery from the feature page "+width,await link.count(),1);
   await link.scrollIntoViewIfNeeded();await link.focus();is("Path discovery keyboard "+width,await link.evaluate(n=>n===document.activeElement),true);
   await link.click();await page.waitForURL(url=>url.pathname==="/platform/path");
   const details=page.getByRole("region",{name:"Your next step, checked against real facts",exact:true});
   await details.scrollIntoViewIfNeeded();
   is("ME3 existing Path page keeps actual seven missions "+width,await details.locator("li").count(),7);
   const missionBodies=await details.locator("li p").allTextContents();
   is("ME3 all seven creator roles retained "+width,missionBodies.filter(text=>text.includes("What you do:")).length,7);
   is("ME3 all seven platform checks retained "+width,missionBodies.filter(text=>text.includes("What Marktmorgen checks:")).length,7);
   const facts=await details.innerText();
   for(const caveat of ["does not verify file access or delivery","never asked to make a real self-purchase","not marketing consent","No sale or deadline is guaranteed"]){
    is("ME3 Path safety retained "+caveat+" "+width,facts.includes(caveat),true);
   }
   is("ME3 detailed Path fits "+width,await details.evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
   await page.addScriptTag({content:axeSource});
   const movedIssues=await details.evaluate(async n=>(await window.axe.run(n,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}})).violations.map(v=>v.id));
   is("ME3 moved Path accessibility "+width,movedIssues,[]);
   is("home Path makes no API writes "+width,writes,0);
  }finally{await context.close();}
 }
}
