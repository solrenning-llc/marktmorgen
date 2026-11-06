export async function checkPublicTrustDesign({browser,LOCAL,axeSource,is}){
 for(const width of [390,1280]){
 const context=await browser.newContext({viewport:{width,height:1000}});try{
 const page=await context.newPage();let writes=0;await page.route("**/api/**",route=>{if(!["GET","HEAD"].includes(route.request().method())){writes++;return route.abort();}return route.continue();});
 // VS1 (owner, 30/10/2026): the home page reads at once and keeps no first-fold
 // fade; the trust links stay on pricing and the feature pages, and the legal
 // pages stay in the footer of every page, the home page included.
 await page.goto(LOCAL+"/");
 is("HT16 home content stays fully readable "+width,await page.locator("[data-static-reading] .reveal").evaluateAll(nodes=>nodes.every(node=>getComputedStyle(node).opacity==="1")),true);
 is("HT16 no first-fold opacity entrance "+width,await page.locator("[data-home-hero] .nb-fade-up").count(),0);
 for(const href of ["/privacy","/terms","/refunds"])is("HT16 home footer keeps "+href+"/"+width,await page.locator('footer a[href="'+href+'"]').count()>0,true);
 for(const [path,place]of [["/pricing","pricing"],["/platform/sales-pages","feature"]]){
 await page.goto(LOCAL+path);const trust=page.locator("[data-trust-checks]");await trust.waitFor();
 is("HT16 trust controls "+place+"/"+width,await trust.getByRole("link").count(),4);
 for(const href of ["/platform/your-stripe","/privacy","/terms#closing","/refunds"])is("HT16 genuine policy path "+href+"/"+place+"/"+width,await trust.locator('a[href="'+href+'"]').count(),1);
 is("HT16 trust no guaranteed result "+place+"/"+width,/guaranteed sales|guaranteed profit|instant payout/i.test(await trust.innerText()),false);
 is("HT16 trust fits "+place+"/"+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await trust.scrollIntoViewIfNeeded();await page.addScriptTag({content:axeSource});const audit=await page.evaluate(async()=>await window.axe.run(document.querySelector("[data-trust-checks]"),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}}));if(audit.violations.length)console.log("HT16_AXE_DETAILS",JSON.stringify(audit.violations));is("HT16 trust accessibility "+place+"/"+width,audit.violations.map(v=>v.id),[]);
 if(place==="feature"){
 await page.goto(LOCAL+"/platform#studio-screens-title");
 const screens=page.locator("[data-studio-screens]");is("HT16 two distinct actual captures "+width,await screens.locator("img").evaluateAll(nodes=>nodes.length===2&&new Set(nodes.map(node=>node.src)).size===2&&nodes.every(node=>node.src.startsWith("data:image/jpeg;base64,")&&node.width>0)),true);
 for(const img of await screens.locator("img").all()){await img.scrollIntoViewIfNeeded();await page.waitForFunction(node=>node.complete&&node.naturalWidth>0,await img.elementHandle(),{timeout:10000});await img.evaluate(node=>node.decode());is("HT16 captured pixels decode "+width,await img.evaluate(node=>node.naturalWidth===1280&&node.naturalHeight===820),true);}
 is("HT16 captures synthetic and dated "+width,(await screens.innerText()).includes("isolated fictional test content"),true);
 }
 }
 is("HT16 no payment/send/AI write "+width,writes,0);
 }finally{await context.close();}
 }
}
