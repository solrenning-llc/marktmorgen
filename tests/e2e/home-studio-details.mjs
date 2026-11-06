/** ME3: follow the actual discovery link; keep original synthetic pixels on an existing detail page. */
export async function checkHomeStudioDetails({browser,LOCAL,axeSource,is}){
 const expected=[
  {title:"See the next step for your store",alt:"Marktmorgen studio showing the setup checklist for the fictional Harbor Kitchen fixture.",href:"/platform/path",length:109427},
  {title:"Build a page around your own offer",alt:"Marktmorgen sales page editor and phone preview for a fictional Weekly Meal Planner fixture.",href:"/platform/sales-pages",length:109611}
 ];
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   const page=await context.newPage();let writes=0;
   await page.route("**/*",route=>{const r=route.request(),u=new URL(r.url());if(u.origin!==LOCAL)return route.abort();if(!["GET","HEAD"].includes(r.method())){writes++;return route.abort();}return route.continue();});
   const response=await page.goto(LOCAL+"/",{waitUntil:"domcontentloaded",timeout:60000});
   is("ME3 studio summary home response "+width,response.status(),200);
   const html=await response.text();
   is("ME3 home does not serialize full studio screenshots "+width,html.includes("data-studio-screens"),false);
   is("ME3 full screen section moved off home "+width,await page.locator("[data-studio-screens]").count(),0);
   // VS1 (owner, 30/10/2026): the home page no longer links the studio examples
   // itself; the feature page keeps them, reached from the footer of every page.
   is("ME3 footer reaches the feature page "+width,await page.locator('footer a[href="/platform"]').count()>0,true);
   await page.goto(LOCAL+"/platform#studio-screens-title",{waitUntil:"domcontentloaded",timeout:60000});
   const section=page.locator("[data-studio-screens]");await section.scrollIntoViewIfNeeded();
   is("ME3 original studio heading retained "+width,(await section.locator("h2").innerText()).trim(),"See the work before you start");
   is("ME3 original synthetic provenance retained "+width,(await section.innerText()).includes("captured on October 20, 2026 with isolated fictional test content"),true);
   is("ME3 both original screens retained "+width,await section.locator("article").count(),2);
   for(let i=0;i<expected.length;i++){
    const article=section.locator("article").nth(i),image=article.locator("img"),wanted=expected[i];
    is("ME3 original screen title "+width+" "+i,(await article.locator("h3").innerText()).trim(),wanted.title);
    is("ME3 original screen alt "+width+" "+i,await image.getAttribute("alt"),wanted.alt);
    const imageSource=await image.getAttribute("src");
    is("ME3 original inline image length "+width+" "+i,imageSource.length,wanted.length);
    is("ME3 no new image operation "+width+" "+i,imageSource.startsWith("data:image/jpeg;base64,"),true);
    is("ME3 original screen destination "+width+" "+i,await article.locator("a").getAttribute("href"),wanted.href);
    await image.scrollIntoViewIfNeeded();
    const size=await image.evaluate(async n=>{await n.decode();return [n.naturalWidth,n.naturalHeight,n.getAttribute("loading"),n.getAttribute("decoding")];});
    is("ME3 original image dimensions and lazy decoding "+width+" "+i,size,[1280,820,"lazy","async"]);
   }
   is("ME3 moved studio section fits "+width,await section.evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
   await page.addScriptTag({content:axeSource});
   const issues=await section.evaluate(async n=>(await window.axe.run(n,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}})).violations.map(v=>v.id));
   is("ME3 moved studio section accessibility "+width,issues,[]);
   is("ME3 studio discovery no writes "+width,writes,0);
   console.log("HOME_STUDIO_HTML_SCOPE:"+JSON.stringify({width,homeHtmlBytes:Buffer.byteLength(html,"utf8"),inlineScreenshotCharactersMoved:219038,scope:"Payload/provenance check only; strict mobile cold samples remain separate, no field p75 claim."}));
  }finally{await context.close();}
 }
}
