/** Every discount POST is intercepted: no real code is created, changed or submitted. */
export async function checkDiscountAcknowledgment({browser,LOCAL,fixture,is}){
 const kept={id:"promo_synthetic_kept",code:"KEPT20",off:{kind:"percent",percent:20},timesRedeemed:2,maxRedemptions:null,expiresAt:null,active:true};
 const cases=[
 {name:"missing more",body:{ok:true,codes:[kept],schedules:[]}},
 {name:"invalid more",body:{ok:true,codes:[kept],schedules:[],more:"false"}},
 {name:"HTTP failure",status:500,body:{ok:true,codes:[],schedules:[],more:false}},
 {name:"truthy success",body:{ok:"true",codes:[],schedules:[],more:false}},
 {name:"missing codes",body:{ok:true,schedules:[],more:false}},
 {name:"missing schedules",body:{ok:true,codes:[kept],more:false}},
 {name:"invalid list",body:{ok:true,codes:{},schedules:[],more:false}},
 {name:"invalid row",body:{ok:true,codes:[null],schedules:[],more:false}},
 {name:"invalid active",body:{ok:true,codes:[{...kept,active:"true"}],schedules:[],more:false}},
 {name:"contradictory error",body:{ok:true,codes:[],schedules:[],more:false,error:"stripe"}},
 {name:"inherited error name",body:{ok:false,error:"__proto__"}},
 {name:"malformed JSON",raw:"<html>unknown</html>"},
 {name:"lost reply",abort:true},
 ];
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:1000}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let reply={body:{ok:true,codes:[kept],schedules:[],more:false}},requests=0,otherWrites=0;
   await page.route("**/api/**",async route=>{
    const request=route.request();
    if(["GET","HEAD"].includes(request.method())){await route.continue();return;}
    if(new URL(request.url()).pathname!=="/api/store/discount"){otherWrites++;await route.abort();return;}
    requests++;
    const sent=request.postDataJSON();is("discount action stays explicit "+width,["list","stop"].includes(sent.action),true);
    if(reply.abort){await route.abort();return;}
    await route.fulfill({status:reply.status??200,contentType:"application/json",body:reply.raw??JSON.stringify(reply.body)});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   const panel=page.getByText("Discount codes",{exact:true}).locator("..");
   is("opening settings never requests discount list "+width,requests,0);
   await panel.getByRole("button",{name:"Load discount codes",exact:true}).click();
   await panel.getByText("KEPT20",{exact:true}).waitFor();
   for(const scenario of cases){
    reply=scenario;
    await panel.getByRole("button",{name:"Refresh discount codes",exact:true}).click();
    const error=panel.getByRole("alert");await error.waitFor();
    is("unknown discount reply stays uncertain "+scenario.name+"/"+width,(await error.innerText()).includes("We could not confirm the discount codes"),true);
    is("unknown discount reply preserves known code "+scenario.name+"/"+width,await panel.getByText("KEPT20",{exact:true}).count(),1);
    is("unknown discount reply never claims empty list "+scenario.name+"/"+width,(await panel.innerText()).includes("No live code right now"),false);
    is("discount refresh unlocks after refusal "+scenario.name+"/"+width,await panel.getByRole("button",{name:"Refresh discount codes",exact:true}).isEnabled(),true);
   }
   reply={body:{ok:true,codes:[{...kept,active:false}],schedules:[],more:false}};
   await panel.getByRole("button",{name:"Switch it off",exact:true}).click();
   await panel.getByText(/1 code is switched off/).waitFor();
   await page.locator('.nb-toast-region [role="status"]').getByText("KEPT20 switched off.",{exact:true}).waitFor();
   is("confirmed stop removes active-code control "+width,await panel.getByRole("button",{name:"Switch it off",exact:true}).count(),0);
   is("discount controls fit viewport "+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   is("all discount writes are synthetic "+width,requests,cases.length+2);
   is("discount check makes no unrelated writes "+width,otherWrites,0);
  }finally{await context.close();}
 }
}
