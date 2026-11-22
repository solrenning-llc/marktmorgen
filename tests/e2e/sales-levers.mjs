export async function checkSalesLevers({browser,LOCAL,fixture,axeSource,is}){
 for(const width of [390,1280]){
 const context=await browser.newContext({viewport:{width,height:1000}});try{
 await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);const page=await context.newPage();let writes=0;
 await page.route("**/api/**",route=>{if(!["GET","HEAD"].includes(route.request().method())){writes++;return route.abort();}return route.continue();});
 await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"domcontentloaded",timeout:60000});
 const root=page.locator("[data-sales-levers]");is("HT9 six levers "+width,await root.locator(":scope > ul > li").count(),6);
 is("HT9 lever titles "+width,await root.locator("h3").allInnerTexts(),["Order bump","Upsell","Downsell","Bundle","Checkout recovery","Next offer"]);
 const text=await root.innerText();for(const phrase of ["before refunds, fees, taxes","must not be added together","Not measured yet","Not automatically enabled","Existing opt-outs and permissions are preserved"])is("HT9 honest scope "+phrase+" "+width,text.includes(phrase),true);
 is("HT9 no projected earnings "+width,/will earn|guaranteed|estimated revenue/i.test(text),false);
 is("HT9 no activation inputs "+width,await root.locator("input,button").count(),0);
 await root.getByRole("link",{name:"Review order bump settings",exact:true}).focus();
 is("HT9 setting link keyboard "+width,await root.getByRole("link",{name:"Review order bump settings",exact:true}).evaluate(node=>node===document.activeElement),true);
 await page.addScriptTag({content:axeSource});const audit=await root.evaluate(async node=>await window.axe.run(node,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}}));
 is("HT9 levers accessibility "+width,audit.violations.map(v=>v.id),[]);
 is("HT9 levers fit "+width,await root.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
 is("HT9 no setting or provider write "+width,writes,0);
 }finally{await context.close();}
 }
}
