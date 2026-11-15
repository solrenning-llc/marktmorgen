import {waitForReactChangeHandler} from "./react-hydration.mjs";
/** Local calculations only; provider links are read, never submitted. */
export async function checkToolsCalculator({browser,LOCAL,is}){
 const check=(condition,name)=>is(name,condition,true);
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   const page=await context.newPage();let apiRequests=0;
   await page.route("**/api/**",async route=>{apiRequests++;await route.abort();});
   await page.goto(LOCAL+"/pricing",{waitUntil:"domcontentloaded"});
   const calculator=page.getByRole("region",{name:"One plan instead of several tools?"});
   // The tool list and "Add tool" are server-rendered: a choice made before React
   // hydrates is reset to the default tool and the press adds nothing (seen on CI in
   // WebKit at 1280, where the ClickFunnels fields never appeared). The select's
   // React change handler proves the calculator is live; no sleep, no second press.
   const toolList=calculator.getByLabel("Tool to add",{exact:true});
   await waitForReactChangeHandler(page,toolList);
   await toolList.selectOption("clickfunnels");
   await calculator.getByRole("button",{name:"Add tool",exact:true}).click();
   const group=calculator.getByRole("group",{name:"ClickFunnels",exact:true});
   await group.getByLabel("Monthly gross sales (USD)",{exact:true}).fill("1000");
   await group.getByLabel("Paid transactions per month",{exact:true}).fill("10");
   await group.getByLabel("Applicable processing percentage (for example 2.9)",{exact:true}).fill("2.9");
   await group.getByLabel("Processing fixed fee per payment (USD)",{exact:true}).fill("0.30");
   await group.getByLabel("Other applicable fees per month (USD; enter a verified zero if none)",{exact:true}).fill("0");
   await group.getByRole("checkbox").check();
   const own=calculator.getByRole("group",{name:"Your Marktmorgen processing and other costs",exact:true});
   await own.getByLabel("Processing percentage",{exact:true}).fill("2.9");
   await own.getByLabel("Fixed processing fee per payment (USD)",{exact:true}).fill("0.30");
   await own.getByLabel("Other applicable monthly fees (USD)",{exact:true}).fill("0");
   check((await calculator.getByRole("status").innerText()).includes("$129.00/month"),"calculator counts actual fixed charges "+width);
   check((await calculator.getByRole("status").innerText()).includes("$101.00/month"),"own plan includes processing too "+width);
   check((await calculator.getByRole("status").innerText()).includes("$28.00/month"),"difference from complete quotes "+width);
   await group.getByLabel("Paid transactions per month",{exact:true}).fill("");
   check(!(await calculator.getByRole("status").innerText()).includes("Estimated cost difference"),"invalid count removes difference "+width);
   await group.getByLabel("Paid transactions per month",{exact:true}).fill("10");
   await group.getByRole("checkbox").uncheck();
   check(!(await calculator.getByRole("status").innerText()).includes("Estimated cost difference"),"unreviewed conditions remove difference "+width);
   await group.getByRole("button",{name:"Remove ClickFunnels",exact:true}).click();
   await calculator.getByLabel("Tool to add",{exact:true}).selectOption("substack");
   await calculator.getByRole("button",{name:"Add tool",exact:true}).click();
   const substack=calculator.getByRole("group",{name:"Substack",exact:true});
   await substack.getByLabel("Monthly gross sales (USD)",{exact:true}).fill("1000");
   await substack.getByLabel("Paid transactions per month",{exact:true}).fill("10");
   await substack.getByLabel("Applicable processing percentage (for example 2.9)",{exact:true}).fill("2.9");
   await substack.getByLabel("Processing fixed fee per payment (USD)",{exact:true}).fill("0.30");
   await substack.getByLabel("Other applicable fees per month (USD; enter a verified zero if none)",{exact:true}).fill("0");
   await substack.getByRole("checkbox").check();
   check((await substack.innerText()).includes("Payment fees: Quote incomplete"),"unconfirmed Billing is not treated as zero "+width);
   await substack.getByLabel("How does recurring Billing apply to your quote?",{exact:true}).selectOption("separate");
   check((await substack.innerText()).includes("$139.00/month"),"separate recurring Billing is included once "+width);
   check(apiRequests===0,"all calculation interactions stay in browser "+width);
   const fit=await calculator.evaluate(node=>({scroll:node.scrollWidth,client:node.clientWidth,rootScroll:document.documentElement.scrollWidth,rootClient:document.documentElement.clientWidth,internalOverflow:[...node.querySelectorAll("*")].filter(child=>child.scrollWidth>child.clientWidth+1).slice(0,12).map(child=>({tag:child.tagName,html:child.outerHTML.slice(0,300),scroll:child.scrollWidth,client:child.clientWidth,whiteSpace:getComputedStyle(child).whiteSpace})),nativeSelects:[...node.querySelectorAll("select")].map(select=>({id:select.id,width:select.getBoundingClientRect().width,scroll:select.scrollWidth,client:select.clientWidth,appearance:getComputedStyle(select).appearance,overflow:getComputedStyle(select).overflowX})),offenders:[...node.querySelectorAll("*")].filter(child=>child.getBoundingClientRect().right>node.getBoundingClientRect().right).slice(0,8).map(child=>({html:child.outerHTML.slice(0,400),right:child.getBoundingClientRect().right}))}));
   if(fit.scroll>fit.client+1)console.error("CALCULATOR_OVERFLOW_DIAGNOSTIC:"+JSON.stringify({width,...fit}));
   check(fit.scroll<=fit.client+1,"calculator fits viewport "+width);
  }finally{await context.close();}
 }
}
