/** Real hydrated store page; guide replies intercepted locally, no external AI/email/payment. */
export async function checkGuidePlacement({browser,LOCAL,fixture,axeSource,is}){
 const local=new URL(LOCAL);
 if(local.protocol!=="http:"||!["localhost","127.0.0.1"].includes(local.hostname)||!local.port)throw Error("Guide checks require synthetic local services");
 for(const viewport of [{width:390,height:844},{width:1280,height:720}]){
  const context=await browser.newContext({viewport,serviceWorkers:"block"});
  try{
   const page=await context.newPage();let calls=0;const otherWrites=[],hits=[];const first=fixture.products[0];
   await page.route("**/api/**",async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin===local.origin&&url.pathname==="/api/store/guide"&&request.method()==="POST"){
     calls++;const body=request.postDataJSON();
     is("ME1 guide keeps store handle "+viewport.width,body.handle,fixture.handle);
     return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,picks:body.goal==="a trip to the moon"?[]:[{title:first.title,href:"/@"+fixture.handle+"/p/"+first.id,price:"$10",why:"A synthetic catalog match."}]})});
    }
    // The page's visit count goes by fetch, through the host's browser check (components/store-beacon.tsx): kept here, never written.
    if(url.origin===local.origin&&url.pathname==="/api/store/hit"&&request.method()==="POST"){let body=null;try{body=request.postDataJSON();}catch{}hits.push(body);return route.fulfill({status:204,body:""});}
    if(!["GET","HEAD"].includes(request.method())){otherWrites.push(request.method()+" "+url.pathname);return route.abort();}
    return route.continue();
   });
   // Capture the real Blob before transport. WebKit's network driver may
   // report sendBeacon POST bodies as null; validate source bytes instead.
   await page.addInitScript(()=>{
    window.__guideBeacons=[];
    Object.defineProperty(navigator,"sendBeacon",{configurable:true,value:(url,data)=>{
     const entry={url:String(url),settled:false,body:null,error:""};window.__guideBeacons.push(entry);
     Promise.resolve(typeof data==="string"?data:data?.text?.()).then(text=>{
      entry.body=JSON.parse(text);entry.settled=true;
     }).catch(error=>{entry.error=String(error);entry.settled=true;});
     return true; // Synthetic transport only: no request or server write.
    }});
   });
   await page.goto(LOCAL+"/@"+fixture.handle,{waitUntil:"networkidle",timeout:60000});
   const guide=page.getByRole("region",{name:"Not sure which one is for you?",exact:true});
   await guide.waitFor({state:"visible"});await page.evaluate(()=>document.fonts.ready);
   const placement=await guide.evaluate(node=>{
    const products=[...document.querySelectorAll('[data-part="products"] li[data-item^="p:"]')],last=products.at(-1);
    return {count:products.length,reading:Boolean(last&&(last.compareDocumentPosition(node)&Node.DOCUMENT_POSITION_FOLLOWING)),visual:Boolean(last&&node.getBoundingClientRect().top>=last.getBoundingClientRect().bottom)};
   });
   is("ME1 guide after actual catalog "+viewport.width,placement,{count:3,reading:true,visual:true});
   await guide.getByLabel("What are you looking for?").fill("dinners for a busy family");
   await guide.getByRole("button",{name:"Help me choose",exact:true}).click();
   await guide.locator(".st-guide-pick").waitFor();
   is("ME1 guide recommendation still opens own product "+viewport.width,await guide.locator(".st-guide-pick").getAttribute("href"),"/@"+fixture.handle+"/p/"+first.id);
   await guide.getByLabel("What are you looking for?").fill("a trip to the moon");
   await guide.getByRole("button",{name:"Help me choose",exact:true}).click();
   await guide.getByText(/nothing Guide placement fixture sells fits that yet/).waitFor();
   is("ME1 guide no-match removes old recommendation "+viewport.width,await guide.locator(".st-guide-pick").count(),0);
   is("ME1 guide two synthetic replies "+viewport.width,calls,2);
   for(let wait=0;wait<100&&!hits.length;wait++)await page.waitForTimeout(100);
   await page.waitForFunction(()=>window.__guideBeacons.every(entry=>entry.settled));
   const beacons=await page.evaluate(()=>window.__guideBeacons);
   is("ME1 guide one existing visit count "+viewport.width,hits.map(body=>({handle:body?.h,kind:body?.k})),[{handle:fixture.handle,kind:"v"}]);
   const unexpected=beacons.filter(entry=>entry.url!=="/api/store/hit"&&(entry.url!=="/api/store/read"||entry.error||entry.body?.k!=="s"||typeof entry.body?.t!=="string"||!Number.isInteger(entry.body?.n)||entry.body.n<0));
   is("ME1 guide no unexpected beacon "+viewport.width,unexpected,[]);
   is("ME1 guide no unhandled writes "+viewport.width,otherWrites,[]);
   await page.addScriptTag({content:axeSource});
   const issues=await guide.evaluate(async node=>(await window.axe.run(node,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}})).violations.map(v=>v.id));
   is("ME1 moved guide accessibility "+viewport.width,issues,[]);
  }finally{await context.close();}
 }
}
