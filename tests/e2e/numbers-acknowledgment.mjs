import {waitForReactChangeHandler} from "./react-hydration.mjs";

/** Synthetic intercepted replies only; never opens or sends a numbers link. */
export async function checkNumbersAcknowledgment({browser,LOCAL,fixture,is}){
 const draft="  Partenaire   Étoile  ",canonical="Partenaire Étoile",password="synthetic-password";
 const common=[
 {name:"HTTP",status:500,reply:v=>v},{name:"truthy",reply:v=>({...v,ok:"true"})},
 {name:"missing",reply:()=>({ok:true})},{name:"null",reply:()=>null},{name:"array",reply:v=>[v]},
 {name:"contradiction",reply:v=>({...v,error:"server_error"})},{name:"malformed",raw:"invalid"},
 {name:"lost",abort:true},{name:"inherited",reply:()=>({ok:false,error:"__proto__"})}
 ];
 const createCases=[...common,
 {name:"bad id",reply:v=>({...v,link:{...v.link,id:"bad"}})},
 {name:"wrong URL",reply:v=>({...v,link:{...v.link,url:"https://example.test/numbers/other"}})},
 {name:"wrong label",reply:v=>({...v,link:{...v.link,label:"Other"}})},
 {name:"wrong revenue",reply:v=>({...v,link:{...v.link,money:!v.link.money}})},
 {name:"missing creation time",reply:v=>({...v,link:{...v.link,made:undefined}})},
 {name:"bad creation time",reply:v=>({...v,link:{...v.link,made:"today"}})},
 {name:"wrong expiry",reply:v=>({...v,link:{...v.link,expires:v.link.expires+86400}})},
 {name:"fractional expiry",reply:v=>({...v,link:{...v.link,expires:v.link.expires+0.5}})},
 {name:"confirmed",reply:v=>v,confirmed:true}];
 const removeCases=[...common,{name:"wrong id",reply:v=>({...v,id:"other"})},{name:"confirmed",reply:v=>v,confirmed:true}];
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let pending=null,requests=0;
   await page.route("**/api/store/numbers-links",async route=>{
    if(!pending)throw Error("Unexpected numbers link write");requests++;
    const work=pending,input=route.request().postDataJSON();await work.release;
    if(work.scenario.abort){await route.abort("failed");return;}
    const id="syntheticlink0000001";
    const created=Math.floor(Date.now()/1000);
    const good=input.action==="remove"?{ok:true,id:input.id}:{ok:true,link:{id,label:canonical,money:input.money,made:created,expires:created+input.days*86400,url:"https://marktmorgen.com/numbers/"+id}};
    await route.fulfill({status:work.scenario.status??200,contentType:"application/json",body:work.scenario.raw??JSON.stringify(work.scenario.reply(good))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.waitForLoadState("networkidle");
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   const section=page.locator("[data-numbers-links]");await section.waitFor();
   const label=section.locator("#numbers-link-label"),pass=section.locator("#numbers-link-password"),days=section.locator("#numbers-link-days"),money=section.locator("#numbers-link-money");
   await waitForReactChangeHandler(page,label);
   is("numbers revenue default off "+width,await money.isChecked(),false);
   async function attempt(scenario,action,revenue){
    let release;const held=new Promise(resolve=>{release=resolve;});pending={scenario,release:held};
    const name=action+"/"+revenue+"/"+scenario.name+"/"+width;
    const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/numbers-links");seen.catch(()=>{});
    try{
     const button=section.getByRole("button",{name:action==="create"?"Make the link":"Take it back",exact:true});
     await button.focus();await page.keyboard.press("Enter");
     is("numbers exact request "+name,(await seen).postDataJSON(),action==="create"?{action,label:draft,password,days:7,money:revenue}:{action,id:fixture.numbersLinkId});
     is("numbers pending announced "+name,await section.getAttribute("aria-busy"),"true");
     for(const field of await section.locator("input,select,button").all())is("numbers pending locked "+name,await field.isDisabled(),true);
    }catch(error){console.error("NUMBERS_ACTIVATION_DIAGNOSTIC:"+JSON.stringify({name,requests,busy:await section.getAttribute("aria-busy"),buttons:await section.getByRole("button").allTextContents(),active:await page.evaluate(()=>({tag:document.activeElement?.tagName,text:document.activeElement?.textContent?.slice(0,80)}))}));throw error;}finally{release();}
    await page.waitForFunction(()=>document.querySelector("[data-numbers-links]")?.getAttribute("aria-busy")==="false");
    if(scenario.confirmed){
     is("numbers confirms "+name,await section.getByRole("alert").count(),0);
     if(action==="create"){
      is("numbers clears confirmed label "+name,await label.inputValue(),"");
      is("numbers clears confirmed password "+name,await pass.inputValue(),"");
      is("numbers exact safe URL "+name,await section.locator("[data-numbers-link-made] a").getAttribute("href"),"https://marktmorgen.com/numbers/syntheticlink0000001");
     }else is("numbers confirms revocation "+name,await page.getByText("Taken back. The link no longer opens.",{exact:true}).count()>0,true);
    }else{
     const alert=section.getByRole("alert");await alert.waitFor();
     is("numbers honest uncertainty "+name,(await alert.innerText()).includes("Reload this page to check before trying again"),true);
     is("numbers preserves label "+name,await label.inputValue(),draft);
     is("numbers preserves password "+name,await pass.inputValue(),password);
     is("numbers preserves revenue "+name,await money.isChecked(),revenue);
    }
    if(scenario.confirmed)await page.waitForLoadState("networkidle");
    is("numbers settings fit "+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   }
   for(const revenue of [false,true]){
    await label.fill(draft);await pass.fill(password);await days.selectOption("7");await money.setChecked(revenue);
    for(const scenario of createCases)await attempt(scenario,"create",revenue);
   }
   await label.fill(draft);await pass.fill(password);
   for(const scenario of removeCases)await attempt(scenario,"remove",true);
   is("all numbers writes intercepted "+width,requests,createCases.length*2+removeCases.length);
  }finally{await context.close();}
 }
}
