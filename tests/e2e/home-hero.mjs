/** HT1, renewed for VS1 (owner, 30/10/2026): public hero hierarchy, the live address preview and the keyboard journey; no account, checkout or API write. */
export async function checkHomeHero({browser,LOCAL,axeSource,is}){
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:1000}});
  try{
   const page=await context.newPage();let writes=0;
   await page.route("**/api/**",async route=>{if(route.request().method()!=="GET"){writes++;await route.abort();}else await route.continue();});
   await page.goto(LOCAL+"/",{waitUntil:"domcontentloaded",timeout:60000});
   const hero=page.locator("[data-home-hero]");
   is("HT1 one page heading "+width,await page.locator("h1").count(),1);
   is("HT1 creator result "+width,(await hero.locator("h1").innerText()).replace(/\s+/g," ").trim(),"Your link in bio, now a store.");
   is("HT1 subhead "+width,(await hero.locator(".hm-hero-lead").innerText()).trim(),"Simple to set up, easy to run, and every sale goes straight to your own account.");
   // The closed-sale truth stays in two places: the line above the page and the offer under the field.
   const compact=page.locator(".hm-preview-toggle");
   if(await compact.isVisible())await page.locator(".hm-preview-compact").click();
   is("HT1 closed-sale notice above the page "+width,(await page.locator("[data-preview-bar]").innerText()).includes("its paid plans are not on sale yet"),true);
   if(await compact.isVisible())await page.locator(".hm-preview-compact").click();
   is("HT1 closed-sale offer line "+width,(await hero.locator("[data-home-offer]").innerText()).trim(),"Free to set up. When plans open: 14 days free, then $69 a month.");
   const field=hero.getByLabel("Pick your store address",{exact:true});
   const claim=hero.getByRole("button",{name:"Claim it",exact:true});
   is("HT1 one hero action "+width,await hero.locator("button[type=submit]").count(),1);
   const target=await claim.boundingBox();is("HT1 large claim target "+width,Boolean(target&&target.height>=44&&target.width>=44),true);
   is("HT1 no guarantee copy "+width,/guaranteed (income|sales|profit)|earn \$|make \$/.test(await hero.innerText()),false);
   // The phone follows what is typed, under the existing handle alphabet.
   await field.focus();await page.keyboard.type("Jenny Cooks!");
   is("HT1 typed value kept as typed "+width,await field.inputValue(),"Jenny Cooks!");
   is("HT1 phone shows the cleaned address "+width,(await hero.locator(".hm-phone-url").innerText()).trim(),"marktmorgen.com/@jennycooks");
   is("HT1 phone labeled as a preview with demo products "+width,(await hero.locator(".hm-phone-note").innerText()).trim(),"Preview with demo products");
   is("HT1 demo store reachable "+width,await hero.getByRole("link",{name:"Open the demo store",exact:true}).getAttribute("href"),"/demo");
   is("HT1 hero fits "+width,await hero.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
   is("HT1 page fits "+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.evaluate(()=>document.fonts.ready);
   await hero.evaluate(async node=>{const animations=node.getAnimations({subtree:true}).filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().iterations));await Promise.all(animations.map(animation=>animation.finished.catch(()=>{})));});
   await checkHomeHeroLayout({page,width,is});
   await page.addScriptTag({content:axeSource});
   const audit=await hero.evaluate(async node=>(await window.axe.run(node,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}})).violations.map(v=>v.id));
   is("HT1 hero accessibility "+width,audit,[]);
   const capture=await page.screenshot({type:"jpeg",quality:70});
   is("HT1 capture byte ceiling "+width,capture.length<=140000,true);
   console.log("HOME_HERO_CAPTURE:"+width+":"+capture.toString("base64"));
   // Keyboard: from the field, Tab reaches the button, Enter opens the existing start page with the address.
   await field.fill("harborkitchen");await field.focus();await page.keyboard.press("Tab");
   is("HT1 keyboard reaches claim "+width,await claim.evaluate(node=>node===document.activeElement),true);
   const arrival=page.waitForURL(url=>url.pathname==="/signin");await page.keyboard.press("Enter");await arrival;
   const url=new URL(page.url());
   is("HT1 keyboard enters setup "+width,[url.pathname,url.searchParams.get("handle")],["/signin","harborkitchen"]);
   is("HT1 start page says the address back "+width,(await page.locator("[data-signin-handle]").innerText()).includes("marktmorgen.com/@harborkitchen"),true);
   is("HT1 start page reserves nothing "+width,(await page.locator("[data-signin-handle]").innerText()).includes("It is not held for you yet"),true);
   is("HT1 no API write "+width,writes,0);
  }finally{await context.close();}
 }
}

/** Real rendered rectangles, also exercised by the opt-in wider breakpoint proof. */
export async function checkHomeHeroLayout({page,width,is}){
 const geometry=await page.locator(".hm-hero-art").evaluate(art=>{
  const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
  const phone=rect(art.querySelector(".hm-phone"));
  const cards=[...art.querySelectorAll(".hm-float-card")].map(rect);
  const overlaps=(a,b)=>Math.min(a.right,b.right)>Math.max(a.left,b.left)&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top);
  return {phone,cards,overlap:cards.map(card=>overlaps(card,phone))};
 });
 is("Encanto7 all example cards retained "+width,geometry.cards.length,3);
 is("Encanto7 no card covers the phone "+width,geometry.overlap,[false,false,false]);
 const compact=page.locator(".hm-preview-compact");
 if(width<640){
  is("Encanto14 native compact notice visible "+width,await compact.isVisible(),true);
  if(await compact.count()){
   const toggle=page.getByRole("checkbox",{name:"Show full notice: Still being built. Plans closed.",exact:true});
   const size=await compact.evaluate(node=>({height:node.getBoundingClientRect().height,text:node.querySelector("[data-preview-summary]").textContent}));
   is("Encanto14 factual summary "+width,size.text,"Still being built. Plans closed.");
   is("Encanto14 single line at default text size "+width,size.height,44);
   await toggle.focus();await page.keyboard.press("Space");
   is("Encanto14 keyboard opens full notice "+width,await toggle.isChecked(),true);
   is("Encanto14 open notice is rendered "+width,await page.locator(".hm-preview-full").isVisible(),true);
   is("Encanto14 visible label carries the keyboard ring "+width,await compact.evaluate(node=>getComputedStyle(node).outlineWidth),"3px");
   is("Encanto14 full closed-plan fact visible "+width,(await page.locator(".hm-preview-full").innerText()).includes("its paid plans are not on sale yet"),true);
   const link=page.locator(".hm-preview-full").getByRole("link",{name:"See what is built",exact:true});
   is("Encanto14 original detail destination "+width,await link.getAttribute("href"),"/mission");
   await page.keyboard.press("Tab");
   is("Encanto14 keyboard reaches detail link "+width,await link.evaluate(node=>node===document.activeElement),true);
   await toggle.focus();await page.keyboard.press("Space");
   is("Encanto14 keyboard closes notice "+width,await toggle.isChecked(),false);
   is("Encanto14 closed notice is hidden "+width,await page.locator(".hm-preview-full").isVisible(),false);
  }
 }else{
  is("Encanto14 desktop keeps complete notice visible "+width,(await page.locator("[data-preview-bar]").innerText()).includes("its paid plans are not on sale yet"),true);
 }
 is("Encanto hero page fits "+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 console.log("HERO_GEOMETRY",JSON.stringify({width,...geometry}));
}
