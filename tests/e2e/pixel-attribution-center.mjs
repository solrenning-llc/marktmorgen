export async function checkPixelAttributionCenter({browser,LOCAL,fixture,axeSource,is}){
 for(const width of [390,1280]){
 const context=await browser.newContext({viewport:{width,height:1000}});try{
 await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);const page=await context.newPage();let intercepted=0;
 let attrReply={status:200,body:{ok:"true",days:60}};
 let reply={status:200,body:{ok:"true",pixels:{meta:"123456789012345",google:"G-AB12CD34EF",tiktok:"C4ABCDEFGH1234567890",pinterest:null}}};
 await page.route("**/api/**",route=>{const request=route.request();if(request.method()==="POST"&&new URL(request.url()).pathname==="/api/store/attribution"){intercepted++;return route.fulfill({status:attrReply.status,contentType:"application/json",body:JSON.stringify(attrReply.body)});}if(request.method()==="POST"&&new URL(request.url()).pathname==="/api/store/pixels"){intercepted++;return route.fulfill({status:reply.status,contentType:"application/json",body:JSON.stringify(reply.body)});}if(!["GET","HEAD"].includes(request.method()))return route.abort();return route.continue();});
 await page.goto(LOCAL+"/studio?store="+fixture.sid);const panel=page.locator('section[aria-labelledby="pixels-title"]');
 is("HT10 central consent visible "+width,(await panel.locator("[data-pixel-consent]").innerText()).includes("Brazil"),true);
 is("HT10 existing channel anchor "+width,await panel.getByRole("link",{name:"Attribution by channel",exact:true}).getAttribute("href"),"#numbers");
 const change=panel.getByRole("button",{name:"Change pixels",exact:true});
 // Ready when its fields are: the summary opens without script and is never marked off (inbox C4-35); the fieldset is held until the page is ready.
 await page.waitForFunction(()=>document.querySelector('section[aria-labelledby="pixels-title"] fieldset')?.disabled===false);
 await change.focus();await page.keyboard.press("Enter");
 is("HT10 keyboard disclosure opens "+width,await panel.locator("details").evaluate(node=>node.open),true);
 const meta=panel.getByRole("textbox",{name:"Meta Pixel ID",exact:true});await meta.fill("999999999999999");
 await panel.getByRole("button",{name:"Save pixels",exact:true}).click();await panel.getByRole("alert").waitFor();
 is("HT10 truthy save refused "+width,await meta.inputValue(),"999999999999999");
 is("HT10 refusal retains form "+width,await panel.getByRole("button",{name:"Save pixels",exact:true}).isEnabled(),true);
 await panel.scrollIntoViewIfNeeded();await page.addScriptTag({content:axeSource});const audit=await page.evaluate(async()=>await window.axe.run(document.querySelector('section[aria-labelledby="pixels-title"]'),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}}));is("HT10 center accessibility "+width,audit.violations.map(v=>v.id),[]);
 is("HT10 center fits "+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 for(const error of ["__proto__","constructor"]){
 reply={status:400,body:{error}};
 await panel.getByRole("button",{name:"Save pixels",exact:true}).click();
 await panel.getByRole("alert").getByText("Your pixel IDs are still here. Saving could not be confirmed. Reload to check the saved IDs before trying again.",{exact:true}).waitFor();
 is("HT10 inherited error retains draft "+error+" "+width,await meta.inputValue(),"999999999999999");
 is("HT10 inherited error retains enabled form "+error+" "+width,await panel.getByRole("button",{name:"Save pixels",exact:true}).isEnabled(),true);
 }
 reply={status:200,body:{ok:true,pixels:{meta:"999999999999999",google:"G-AB12CD34EF",tiktok:"C4ABCDEFGH1234567890",pinterest:null}}};
 await panel.getByRole("button",{name:"Save pixels",exact:true}).click();await panel.getByRole("button",{name:"Change pixels",exact:true}).waitFor();
 is("HT10 both saves synthetic "+width,intercepted,4);
 const attribution=page.locator("[data-attribution]");await attribution.waitFor();const window=attribution.locator("select");
 await window.selectOption("60");await attribution.getByRole("alert").waitFor();
 is("HT10 rejected window choice retained "+width,await window.inputValue(),"60");
 is("HT10 unknown save not used in report "+width,(await attribution.innerText()).includes("within the 30 days before"),true);
 attrReply={status:200,body:{ok:true,days:60}};
 await attribution.getByRole("button",{name:"Retry window change",exact:true}).click();await attribution.getByRole("alert").waitFor({state:"hidden"});await attribution.getByText(/within the 60 days before;/).waitFor();
 is("HT10 matching window confirmed "+width,(await attribution.innerText()).includes("within the 60 days before"),true);
 is("HT10 attribution links same center "+width,await attribution.getByRole("link",{name:"Review pixel IDs and consent",exact:true}).getAttribute("href"),"#pixels-title");
 is("HT10 all center writes intercepted "+width,intercepted,6);
 }finally{await context.close();}
 const gpc=await browser.newContext({viewport:{width,height:1000},extraHTTPHeaders:{"Sec-GPC":"1"}});try{
 await gpc.addInitScript(()=>{Object.defineProperty(navigator,"globalPrivacyControl",{configurable:true,get:()=>true});localStorage.setItem("nl_px_consent:templatelibraryfixture","yes");});
 await gpc.addCookies([{name:"nl_ads_templatelibraryfixture",value:"y",url:LOCAL}]);
 await gpc.addInitScript(()=>{
  window.__mmVisitBodies=[];
  const send=navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon=(url,body)=>{
   if(new URL(url,location.href).origin===location.origin&&new URL(url,location.href).pathname==="/api/store/hit"){
    window.__mmVisitBodies.push(body instanceof Blob?body.text():Promise.resolve(String(body)));
   }
   return send(url,body);
  };
 });
 const page=await gpc.newPage();let vendor=0,adWrites=0,visitHits=0;const unexpectedWrites=[];
 await page.route("**/*",async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==new URL(LOCAL).origin){if(/facebook|google-analytics|googletagmanager|tiktok|pinterest/.test(url.hostname))vendor++;return route.abort();}if(!["GET","HEAD"].includes(request.method())){let payload;try{payload=request.postDataJSON();}catch{}
 if(!request.postData()&&browser.browserType().name()==="webkit"&&url.pathname==="/api/store/hit"&&request.method()==="POST"&&new URL(request.frame().url()).pathname==="/@templatelibraryfixture"){
  const captured=await page.evaluate(async()=>await window.__mmVisitBodies.at(-1));
  if(captured)payload=JSON.parse(captured);
 }
 if(url.pathname==="/api/store/hit"&&request.method()==="POST"&&payload?.h==="templatelibraryfixture"&&payload?.k==="v"&&Object.keys(payload).every(key=>["h","k","r","u","m","g"].includes(key)&&typeof payload[key]==="string")){visitHits++;return route.fulfill({status:204,body:""});}if(url.pathname==="/api/store/ads-event")adWrites++;else unexpectedWrites.push({method:request.method(),path:url.pathname});return route.abort();}return route.continue();});
 const visitAcknowledged=page.waitForResponse(response=>new URL(response.url()).origin===new URL(LOCAL).origin&&new URL(response.url()).pathname==="/api/store/hit"&&response.request().method()==="POST"&&response.status()===204);visitAcknowledged.catch(()=>{});
 await page.goto(LOCAL+"/@templatelibraryfixture");await page.getByText("Your browser’s Global Privacy Control keeps ad measurement off. Manage this signal in your browser settings.",{exact:true}).waitFor();
 // Consent rendering and the cookieless visit hydrate independently. Wait for
 // the strictly validated local route acknowledgement before reading its count.
 await visitAcknowledged;
 is("HT10 GPC beats previous yes "+width,await page.getByRole("button",{name:"Allow",exact:true}).count(),0);
 is("HT10 GPC clears server yes "+width,(await gpc.cookies()).some(cookie=>cookie.name==="nl_ads_templatelibraryfixture"),false);
 is("HT10 no ad platform request "+width,vendor,0);is("HT10 no ad event write "+width,adWrites,0);is("HT10 existing cookieless visit intercepted "+width,visitHits,1);is("HT10 no unexpected write "+width,unexpectedWrites,[]);
 }finally{await gpc.close();}
 }
}
