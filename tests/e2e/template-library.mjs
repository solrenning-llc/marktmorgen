import {waitForReactHandler,waitForReactHydrated} from "./react-hydration.mjs";

export async function checkTemplateLibrary({browser,LOCAL,fixture,axeSource,is}){
 for(const width of [390,1280]){
 const context=await browser.newContext({viewport:{width,height:1000}});try{
 await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
 const page=await context.newPage();let writes=0,sectionReads=0,recipientReads=0;
 await page.route("**/api/**",route=>{const request=route.request();if(request.url().includes("/saved-blocks")){sectionReads++;return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,sections:[]})});}if(request.method()==="POST"&&new URL(request.url()).pathname==="/api/store/mail"&&request.postDataJSON()?.action==="count"){recipientReads++;return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,count:0,partial:false})});}if(!["GET","HEAD"].includes(request.method())){writes++;console.log("HT15_UNEXPECTED_MUTATION",request.method(),new URL(request.url()).pathname);return route.abort();}return route.continue();});
 await page.goto(LOCAL+"/studio/growth?store="+fixture.sid+"#template-library");
 const library=page.locator("[data-template-library]");await library.waitFor();
 is("HT15 all model families visible "+width,await library.locator("li > h3").count()>15,true);
 is("HT15 no automatic saved-section read "+width,sectionReads,0);
 await library.getByLabel("Goal",{exact:true}).selectOption("leads");
 await library.getByLabel("Template type",{exact:true}).selectOption("sequence");
 is("HT15 combined filters "+width,await library.locator("li > h3").allInnerTexts(),["Welcome sequence"]);
 await library.getByLabel("Find a template",{exact:true}).fill("missing-928337");is("HT15 empty search "+width,await library.locator("li > h3").count(),0);
 await library.getByLabel("Find a template",{exact:true}).fill("");
 await library.getByText("Preview Welcome sequence",{exact:true}).click();is("HT15 existing sequence text preview "+width,(await library.innerText()).includes("Welcome, and what to expect"),true);
 await library.getByRole("button",{name:"Load my saved sections",exact:true}).click();await library.getByText("No saved sections were returned for this store.",{exact:true}).waitFor();
 is("HT15 one explicit existing read "+width,sectionReads,1);
 await page.addScriptTag({content:axeSource});const audit=await page.evaluate(async()=>await window.axe.run(document.querySelector("[data-template-library]"),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}}));is("HT15 library accessibility "+width,audit.violations.map(v=>v.id),[]);
 is("HT15 library fits "+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await library.getByLabel("Goal",{exact:true}).selectOption("all");await library.getByLabel("Template type",{exact:true}).selectOption("page");
 const pageLink=library.getByRole("link",{name:/^Use .+ page template$/}).first();const href=await pageLink.getAttribute("href");is("HT15 page intent explicit "+width,href.includes("&template="),true);
 await pageLink.click();await page.getByText("Template opened as an unsaved draft. Review every block before saving; nothing has been published.",{exact:true}).waitFor();
 is("HT15 page draft starts from actual product "+width,(await page.locator("main").innerText()).includes("Synthetic template product"),true);
 page.on("dialog",dialog=>void dialog.accept());
 // The preserved-page message is server-rendered. The depth read starts in
 // PageEditor's useEffect, proving its controls have hydrated before clicking.
 // Wait for that existing GET rather than sleeping, retrying the click or
 // weakening the exact preserved-content assertion.
 const preservedEditorHydrated=page.waitForRequest(request=>{
  const url=new URL(request.url());
  return request.method()==="GET"&&url.pathname==="/api/store/depth"&&url.searchParams.get("id")===fixture.preservedProduct;
 });
 await page.goto(LOCAL+"/studio/pages?store="+fixture.sid+"&product="+fixture.preservedProduct+"&template=course");
 await preservedEditorHydrated;
 await page.getByText("Your saved page was preserved. Library templates only start an empty page; use the editor to change existing content.",{exact:true}).waitFor();
 const keepHeadline=page.getByRole("button",{name:/Keep my creator headline/});
 // Press only once React has hydrated the editor and owns this button: a press on the server-drawn button selects
 // nothing, and the wait below then ran out in WebKit (common cause no. 2, #4000's merge group, template-library.mjs:40).
 await waitForReactHydrated(page,keepHeadline);await waitForReactHandler(page,keepHeadline,"onClick");
 await keepHeadline.click();
 // The editor selection renders asynchronously; assert the preserved value after
 // that state is observable, without changing the exact content requirement.
 await page.waitForFunction(()=>[...document.querySelectorAll("input,textarea")].some(node=>node.value==="Keep my creator headline"));
 is("HT15 saved creator headline intact "+width,await page.locator("input,textarea").evaluateAll(nodes=>nodes.some(node=>node.value==="Keep my creator headline")),true);
 const mailCount=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/store/mail"&&response.request().method()==="POST"&&response.request().postDataJSON()?.action==="count");
 await page.goto(LOCAL+"/studio/email?store="+fixture.sid+"&emailTemplate=news");
 await mailCount;
 await page.getByText("Library email opened as an unsaved draft. Replace every placeholder and review consent before saving or sending.",{exact:true}).waitFor();
 is("HT15 mail placeholders preserved "+width,await page.locator("textarea").evaluateAll(nodes=>nodes.some(node=>node.value.includes("What this issue is about"))),true);
 const sequenceCount=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/store/mail"&&response.request().method()==="POST"&&response.request().postDataJSON()?.action==="count");
 await page.goto(LOCAL+"/studio/email?store="+fixture.sid+"&sequenceTemplate=welcome");
 await sequenceCount;
 await page.getByText("Library sequence opened as an unsaved paused draft. Review every step before saving; activation is a separate action.",{exact:true}).waitFor();
 is("HT15 sequence opens existing editor "+width,await page.getByRole("textbox",{name:"Name, for you",exact:true}).inputValue(),"Welcome");
 is("HT15 sequence remains paused "+width,(await page.locator("main").innerText()).includes("New workflows are saved paused."),true);
 is("HT15 only existing recipient-count reads "+width,recipientReads,2);
 is("HT15 no save/send/publish/AI write "+width,writes,0);
 }finally{await context.close();}
 }
}
