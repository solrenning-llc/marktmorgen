import { darkGrounds } from "./morning-grounds.mjs";
export async function checkSigninTerms({browser,LOCAL,prices,axeSource,is}){
 for(const width of [390,1280]){
 const context=await browser.newContext({viewport:{width,height:1000}});try{
 const page=await context.newPage();let posts=0;await page.route("**/api/**",route=>{if(!["GET","HEAD"].includes(route.request().method())){posts++;return route.abort();}return route.continue();});
 await page.goto(LOCAL+"/signin");const terms=page.locator("[data-signin-terms]");
 is("HT6 monthly prices before free setup "+width,await terms.locator("h2").innerText(),"Monthly plan prices");
 for(const price of prices)is("HT6 canonical monthly price "+price.tier+" "+width,(await terms.locator('[data-signin-price="'+price.tier+'"]').innerText()).includes(price.words),true);
 is("HT6 no card to start "+width,(await terms.innerText()).includes("Store setup starts without a card."),true);
 is("HT6 setup does not sell a plan "+width,(await terms.innerText()).includes("not a free paid plan or an active trial"),true);
 is("HT6 one human field "+width,await page.locator("form input:visible").count(),1);
 is("HT6 human field is email "+width,await page.locator("form input:visible").getAttribute("type"),"email");
 is("HT6 truthful form CTA "+width,await page.getByRole("button",{name:"Email me a link",exact:true}).count(),1);
 is("HT6 no card or password input "+width,await page.locator('input[type="password"],input[autocomplete^="cc-"]').count(),0);
 is("HT6 terms before form "+width,await terms.evaluate(node=>!!(node.compareDocumentPosition(document.querySelector("form"))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
 await page.addScriptTag({content:axeSource});const audit=await page.evaluate(async()=>await window.axe.run(document.querySelector("main"),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}}));
 is("HT6 signup accessibility "+width,audit.violations.map(v=>v.id),[]);
 is("HT6 signup fits "+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 // VS1 unit 2: the home page's morning look, with a line on ease instead of the ownership slogan.
 is("VS1 signup has no dark surface "+width,await darkGrounds(page),[]);
 is("VS1 signup has no ownership slogan "+width,/Your Stripe\. Your money|Your store\. Your Stripe|Your store · Your Stripe/.test(await page.locator("body").innerText()),false);
 is("VS1 signup ease line "+width,await page.getByText("Simple to set up. Easy to run.",{exact:true}).isVisible(),width>=1024);
 is("VS1 signup home link "+width,await page.getByRole("link",{name:"Marktmorgen, home",exact:true}).filter({visible:true}).count(),1);
 await page.goto(LOCAL+"/signin?to=login");is("HT6 returning title "+width,await page.locator("h1").innerText(),"Log in to your store");
 is("VS1 returning has no dark surface "+width,await darkGrounds(page),[]);
 is("HT6 returning flow stays focused "+width,await page.locator("[data-signin-terms]").count(),0);
 is("HT6 no login request or submission "+width,posts,0);
 }finally{await context.close();}
 }
 // VS1 unit 2: the panel's sun (5.72:1 with the text) never sits behind any of the panel's words,
 // measured on the circle itself, at the widths where the panel shows (2048px is 1024px at 200% zoom).
 for(const width of [1024,1100,1180,1280,1440,1920]){
  const context=await browser.newContext({viewport:{width,height:800}});try{
   const page=await context.newPage();await page.goto(LOCAL+"/signin");
   const hits=await page.evaluate(()=>{
    const sun=document.querySelector(".hm-sun-signin").getBoundingClientRect(),r=sun.width/2,cx=sun.left+r,cy=sun.top+r;
    const words=[...document.querySelectorAll(".hm-signin-panel :is(p,li,a)")];
    return words.filter(node=>[...node.getClientRects()].some(box=>{const x=Math.max(box.left,Math.min(cx,box.right)),y=Math.max(box.top,Math.min(cy,box.bottom));return Math.hypot(x-cx,y-cy)<r;})).map(node=>node.textContent.trim().slice(0,40));
   });
   is("VS1 sun behind no words "+width,hits,[]);
  }finally{await context.close();}
 }
}
