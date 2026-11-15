/**
 * The block picker opened, then the screen turned wide (375 [TB1]): a press on
 * "Add a block" that came before the page editor measured the screen, or a
 * window made wider while a place waits. Under the blocks the picker is no
 * longer drawn on a wide screen, so the column beside them must show it,
 * never the page with no picker anywhere (seen in WebKit, where the press
 * landed before the measurement). The focus, which was in the picker's search,
 * goes to the search beside. Nothing is added, saved or asked of the AI.
 */
export async function checkBlockPickerTurnsWide({browser,LOCAL,session,sid,product,is}){
 const context=await browser.newContext({viewport:{width:1000,height:900}});
 try{
  await context.addCookies([{name:"nl_session",value:session,url:LOCAL}]);
  const page=await context.newPage();
  let writes=0;page.on("request",request=>{if(request.method()==="POST")writes++;});
  await page.goto(LOCAL+"/studio/pages?store="+sid+"&product="+product,{waitUntil:"domcontentloaded",timeout:60000});
  await page.getByRole("button",{name:/^Add a block \(/}).click();
  const below=page.getByRole("region",{name:/^Add a block /});
  await below.waitFor({state:"visible"});
  is("narrow: the picker opens under the blocks, its search focused",await page.evaluate(()=>document.activeElement?.id??""),"block-find");
  await page.setViewportSize({width:1300,height:900});
  const beside=page.locator("#side-panel").getByRole("region",{name:/^Add a block /});
  const shown=await beside.waitFor({state:"visible",timeout:10000}).then(()=>true,()=>false);
  is("made wide with a place waiting: the column beside shows the picker, not the page",shown,true);
  is("and only there",await page.getByRole("region",{name:/^Add a block /}).count(),1);
  const focused=await page.waitForFunction(()=>document.activeElement?.id==="menu-block-find",null,{timeout:5000}).then(()=>true,()=>false);
  is("the focus goes with it, to the search beside",focused,true);
  is("opening and moving the picker never posts",writes,0);
 }finally{await context.close();}
}
