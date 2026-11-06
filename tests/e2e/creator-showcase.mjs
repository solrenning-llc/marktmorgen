export async function checkCreatorShowcase({browser,LOCAL,axeSource,is}){
 for(const width of [390,1280]){
 const context=await browser.newContext({viewport:{width,height:1000}});try{
 const page=await context.newPage();let writes=0;await page.route("**/api/**",route=>{if(!["GET","HEAD"].includes(route.request().method())){writes++;return route.abort();}return route.continue();});
 // VS1 (owner, 30/10/2026): with no real creators yet, the home page shows no
 // showcase at all; its phone is labeled a preview with demo products and
 // links the demo store. The showcase page keeps its own conditions.
 await page.goto(LOCAL+"/");
 is("HT7 no showcase on home "+width,await page.locator("[data-creator-showcase]").count(),0);
 const hero=page.locator("[data-home-hero]");
 is("HT7 demo labeled on home "+width,(await hero.innerText()).includes("Preview with demo products"),true);
 const demo=hero.getByRole("link",{name:"Open the demo store",exact:true});
 is("HT7 existing demo route "+width,await demo.getAttribute("href"),"/demo");
 await demo.focus();is("HT7 keyboard demo "+width,await demo.evaluate(node=>node===document.activeElement),true);
 is("HT7 demo target "+width,await demo.evaluate(node=>node.getBoundingClientRect().height>=44),true);
 is("HT7 no invented result on home "+width,/earned \$|made \$|customers earned|guaranteed sales|followers/i.test(await page.locator("main").innerText()),false);
 await page.goto(LOCAL+"/proof/creator-showcase");
 const main=await page.locator("main").innerText();is("HT7 page permission condition "+width,main.includes("No real creator listing has recorded permission"),true);
 is("HT7 page demo-only listing "+width,await page.locator('section[aria-labelledby="explore-the-store-listings"] a[href="/demo"]').count(),1);
 is("HT7 no invented result "+width,/earned \$|made \$|customers earned|guaranteed sales/i.test(main),false);
 is("HT7 showcase fits "+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.addScriptTag({content:axeSource});const audit=await page.evaluate(async()=>await window.axe.run(document.querySelector("main"),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}}));if(audit.violations.length)console.log("HT7_AXE_DETAILS",JSON.stringify(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary,html:n.html}))}))));is("HT7 page accessibility "+width,audit.violations.map(v=>v.id),[]);
 is("HT7 showcase no API writes "+width,writes,0);
 }finally{await context.close();}
 }
}
