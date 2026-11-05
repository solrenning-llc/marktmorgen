/** The actual guard must retain the typed profiles when navigation is declined. */
export async function checkSocialDraftProtection({page,is,label}){
 const before=page.url(),form=page.locator("form[data-socials-editor]");
 const values=()=>form.locator("select,input").evaluateAll(nodes=>nodes.map(node=>node.value));
 const draft=await values();
 is("unsaved profiles protect unload "+label,await page.evaluate(()=>!window.dispatchEvent(new Event("beforeunload",{cancelable:true}))),true);
 const notices=[];
 const dismiss=async dialog=>{notices.push(dialog.message());await dialog.dismiss();};
 page.on("dialog",dismiss);
 try{const path=page.getByRole("link",{name:"Path",exact:true});await path.focus();await path.press("Enter");}finally{page.off("dialog",dismiss);}
 is("unsaved profiles ask before leaving "+label,notices,["You have changes that are not saved. Leave without saving them?"]);
 is("staying keeps profile document "+label,page.url(),before);
 is("staying keeps exact profile draft "+label,await values(),draft);
}

/** All profile writes are intercepted. No account, message or external profile request. */
export async function checkSocialAcknowledgment({browser,LOCAL,fixture,axeSource,is}){
 const profileCases=[
  {name:"HTTP failure",status:500,body:value=>({ok:true,socials:value})},
  {name:"truthy confirmation",body:value=>({ok:"true",socials:value})},
  {name:"missing snapshot",body:()=>({ok:true})},
  {name:"different URL",body:value=>({ok:true,socials:[{...value[0],url:"https://www.instagram.com/other"},value[1]]})},
  {name:"different network",body:value=>({ok:true,socials:[{...value[0],network:"youtube"},value[1]]})},
  {name:"different order",body:value=>({ok:true,socials:[...value].reverse()})},
  {name:"extra profile",body:value=>({ok:true,socials:[...value,{network:"website",url:"https://example.test/"}]})},
  {name:"missing profile",body:value=>({ok:true,socials:value.slice(0,1)})},
  {name:"null",body:()=>null},
  {name:"array",body:value=>[{ok:true,socials:value}]},
  {name:"malformed",raw:"<html>temporary error</html>"},
  {name:"contradictory error",body:value=>({ok:true,socials:value,error:"server_error"})},
  {name:"inherited object error",body:()=>({ok:false,error:"__proto__"})},
  {name:"inherited function error",body:()=>({ok:false,error:"constructor"})},
  {name:"lost reply",abort:true},
  {name:"known profile refusal",status:400,body:()=>({ok:false,error:"not_a_profile",bad:[0]}),specific:true},
  {name:"invalid rejected indexes",body:()=>({ok:false,error:"not_a_profile",bad:[-1,99,"0",null]}),badIndexes:true},
  {name:"matching canonical profiles",body:value=>({ok:true,socials:value}),confirmed:true},
 ];
 const removalCases=[
  {name:"HTTP failure",status:500,body:value=>({ok:true,socials:value})},
  {name:"truthy confirmation",body:value=>({ok:"true",socials:value})},
  {name:"missing snapshot",body:()=>({ok:true})},
  {name:"unrequested profile",body:()=>({ok:true,socials:[{network:"website",url:"https://example.test/"}]})},
  {name:"null snapshot",body:()=>({ok:true,socials:null})},
  {name:"matching empty profiles",body:value=>({ok:true,socials:value}),confirmed:true},
 ];
 for(const width of [390,1280])for(const mode of ["profiles","remove"]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:"nl_session",value:fixture.session,url:LOCAL}]);
   const page=await context.newPage();let pending=null,requests=0;
   await page.route("**/api/store/socials",async route=>{
    if(!pending)throw Error("Unexpected social-profile write");
    const work=pending;requests++;const input=route.request().postDataJSON().socials;
    const value=input.map(s=>({network:s.network,url:s.network==="instagram"?"https://www.instagram.com/"+s.url.trim().replace(/^@/,""):"https://www.tiktok.com/@"+s.url.trim().replace(/^@/,"")}));
    await work.release;if(work.scenario.abort){await route.abort("failed");return;}
    await route.fulfill({status:work.scenario.status??200,contentType:"application/json",body:work.scenario.raw??JSON.stringify(work.scenario.body(value))});
   });
   await page.goto(LOCAL+"/studio?store="+fixture.sid,{waitUntil:"networkidle",timeout:60000});
   await page.locator("main details").evaluateAll(nodes=>nodes.forEach(n=>{n.open=true;}));
   await page.getByRole("button",{name:/^(Add|Edit) your profiles$/}).click();
   const form=page.locator("form[data-socials-editor]");await form.waitFor({state:"visible"});
   while(await form.getByRole("button",{name:/^Remove /}).count())await form.getByRole("button",{name:/^Remove /}).first().click();
   if(mode==="profiles"){
    await form.getByRole("button",{name:"Add a profile",exact:true}).click();
    await form.getByRole("textbox",{name:"Handle or address",exact:true}).first().fill("  @harborkitchenpreview  ");
    await form.getByRole("button",{name:"Add a profile",exact:true}).click();
    await form.getByRole("textbox",{name:"Handle or address",exact:true}).last().fill("@harborrecipes");
    await checkSocialDraftProtection({page,is,label:"local draft/"+width});
   }
   await page.addScriptTag({content:axeSource});
   const scenarios=mode==="profiles"?profileCases:removalCases;
   const success=mode==="profiles"?"Profiles saved.":"Profiles removed from your store.";
   for(const scenario of scenarios){
    let release;const held=new Promise(resolve=>{release=resolve;});pending={scenario,release:held};
    const seen=page.waitForRequest(r=>r.method()==="POST"&&new URL(r.url()).pathname==="/api/store/socials");seen.catch(()=>{});
    const name=scenario.name+"/"+mode+"/"+width;
    try{
     await form.getByRole("button",{name:"Save profiles",exact:true}).click();const sent=(await seen).postDataJSON().socials;
     is("profile request retains chosen rows "+name,sent.length,mode==="profiles"?2:0);
     if(mode==="profiles")is("profile input stays creator-authored "+name,sent[0].url,"  @harborkitchenpreview  ");
     for(const field of await form.locator("select,input,button").all())is("all profile editing locks "+name,await field.isDisabled(),true);
     is("profile form announces pending "+name,await form.getAttribute("aria-busy"),"true");
    }finally{release();}
    if(scenario.confirmed){
     await page.locator(".nb-toast-region [role=status]").getByText(success,{exact:true}).waitFor({state:"attached"});
     is("confirmed profile editor closes "+name,await form.count(),0);
     is("confirmed profiles release unload protection "+name,await page.evaluate(()=>!window.dispatchEvent(new Event("beforeunload",{cancelable:true}))),false);
    }else{
     const alert=form.getByRole("alert");await alert.waitFor();
     is("profile errors stay honest "+name,(await alert.innerText()).includes(scenario.specific?"It is marked below":"Reload this page to check before trying again"),true);
     is("no false profile success "+name,await page.getByText(success,{exact:true}).count(),0);
     for(const field of await form.locator("select,input").all())is("profile fields unlock "+name,await field.isEnabled(),true);
     is("profile cancel unlocks "+name,await form.getByRole("button",{name:"Cancel",exact:true}).isEnabled(),true);
     if(mode==="profiles")is("profile input preserved after refusal "+name,await form.getByRole("textbox",{name:"Handle or address",exact:true}).first().inputValue(),"  @harborkitchenpreview  ");
     if(mode==="profiles"&&["HTTP failure","malformed JSON","lost reply"].includes(scenario.name))await checkSocialDraftProtection({page,is,label:name});
     if(scenario.specific)is("known rejected row marked "+name,await form.locator('[aria-invalid="true"]').count(),1);
     if(scenario.badIndexes)is("invalid rejected indexes mark no rows "+name,await form.locator('[aria-invalid="true"]').count(),0);
     const contrast=await alert.evaluate(async node=>{const r=await window.axe.run(node,{runOnly:{type:"rule",values:["color-contrast-enhanced"]}});return{violations:r.violations.map(v=>v.id),incomplete:r.incomplete.map(v=>v.id),passed:r.passes.some(v=>v.id==="color-contrast-enhanced")};});
     is("profile error enhanced contrast "+name,contrast,{violations:[],incomplete:[],passed:true});
    }
    is("profile controls fit "+name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   }
   is("all profile writes stayed intercepted "+mode+"/"+width,requests,scenarios.length);
  }finally{await context.close();}
 }
}
