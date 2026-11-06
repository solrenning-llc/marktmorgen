/** Full home facts moved to an existing feature page; cold performance is tested separately. */
const expected=[{"icon":"bank","title":"The money lands in your Stripe","body":"Every sale is a direct charge on your own Stripe account. Payouts follow your schedule, and refunds and disputes live in your own dashboard.","example":"If you ever leave us, nothing moves: the account, the customers and the payout history were yours the whole time.","href":"/platform/your-stripe","link":"How the money moves"},{"icon":"tag","title":"Several prices for one product","body":"One week for $27, five weeks for $39. Up to 50 options on any product, compared side by side, and each option delivers its own file.","example":"A week at one price, five weeks at another, the season at a third. The buyer picks; each one hands over its own file.","href":"/platform/price-options","link":"See price options"},{"icon":"bolt","title":"Reliable access after payment","body":"A file downloads, a course opens, a booked call lands on both calendars — but only after we ask Stripe's own record whether the payment settled, and we ask again on every download. A link somebody guesses or forwards opens nothing. The confirmation email links back to the purchase when the buyer leaves checkout.","example":"A buyer on a new phone types the email address they paid with, and every purchase from that store comes back to them — a month or a year later, for as long as the store is open and the product is still there.","href":"/platform/instant-delivery","link":"How delivery works"}];
export async function checkHomeReasons({browser,LOCAL,axeSource,is}){
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   const page=await context.newPage();let writes=0;
   await page.route("**/api/**",async route=>{if(route.request().method()!=="GET"){writes++;await route.abort();}else await route.continue();});
   // VS1 (owner, 30/10/2026): the reasons summary left the home page; the
   // feature page keeps the three full reasons and their limitations.
   await page.goto(LOCAL+"/platform#home-reasons-heading",{waitUntil:"domcontentloaded",timeout:60000});
   const detail=page.getByRole("region",{name:"Built for the people who use it",exact:true});
   await detail.scrollIntoViewIfNeeded();
   const articles=detail.locator("article");
   is("ME3 feature page keeps three full reasons "+width,await articles.count(),3);
   for(let i=0;i<expected.length;i++){
    const article=articles.nth(i),row=expected[i];
    is("ME3 reason title unchanged "+i+"/"+width,(await article.locator("h3").innerText()).trim(),row.title);
    is("ME3 reason body unchanged "+i+"/"+width,(await article.locator("p.measure").nth(0).innerText()).trim(),row.body);
    is("ME3 reason example unchanged "+i+"/"+width,(await article.locator("p.measure").nth(1).innerText()).trim(),row.example);
    const link=article.getByRole("link",{name:row.link,exact:true});
    is("ME3 reason factual destination "+i+"/"+width,await link.getAttribute("href"),row.href);
    await link.focus();is("ME3 reason link focus "+i+"/"+width,await link.evaluate(node=>node===document.activeElement),true);
   }
   is("ME3 current limitations unchanged "+width,await detail.locator("ul").last().locator("li").allTextContents(),["Automatic replies on Instagram","An iPhone app from the App Store","Paying affiliates without a PayPal account of your own"]);
   is("ME3 full reasons fit viewport "+width,await detail.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
   await page.addScriptTag({content:axeSource});
   const audit=await detail.evaluate(async node=>(await window.axe.run(node,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}})).violations.map(v=>v.id));
   is("ME3 full reason section accessibility "+width,audit,[]);
   is("ME3 reason reading makes no API writes "+width,writes,0);
  }finally{await context.close();}
 }
}
