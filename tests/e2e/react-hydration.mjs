/**
 * Waits until React has hydrated `control`: its own props carry the handler `prop` (onChange, onClick…). A
 * server-rendered control accepts a press or a keystroke before hydration and nothing happens, so a check that acts
 * at once can wait forever for what the handler would have shown (seen on CI in Firefox).
 * @param {import("playwright-core").Page} page @param {import("playwright-core").Locator} control @param {string} prop
 */
export async function waitForReactHandler(page,control,prop){
 const handle=await control.elementHandle();
 if(!handle)throw Error("The control is not attached");
 await page.waitForFunction(([node,name])=>{
  const element=/** @type {Record<string,Record<string,unknown>|undefined>} */(/** @type {unknown} */(node));
  return Object.keys(element).some(key=>key.startsWith("__reactProps$")&&typeof element[key]?.[name]==="function");
 },/** @type {const} */([handle,prop]));
}

/** @param {import("playwright-core").Page} page @param {import("playwright-core").Locator} control */
export async function waitForReactChangeHandler(page,control){
 await waitForReactHandler(page,control,"onChange");
}

/**
 * Waits until React owns a link's click, so pressing it navigates through the client router
 * (the path a reader takes once the page is interactive) instead of racing hydration.
 * @param {import("playwright-core").Page} page @param {import("playwright-core").Locator} link
 */
export async function waitForReactClickHandler(page,link){
 const handle=await link.elementHandle();
 if(!handle)throw Error("The link is not attached");
 await page.waitForFunction(node=>{
  const element=/** @type {Record<string,{onClick?:unknown}>} */(/** @type {unknown} */(node));
  return Object.keys(element).some(key=>key.startsWith("__reactProps$")&&typeof element[key]?.onClick==="function");
 },handle);
}

/**
 * Waits until React has committed the hydration of the page holding `control` and has no
 * rendering left to do. A control can carry React's props while the root is still hydrating
 * (they are attached during the render, before the commit); an input event then makes React
 * finish hydrating at once, and that commit puts the server's value back into a controlled
 * select, so the choice is lost (PAIRS_INITIAL_SELECTION in WebKit; reproduced in Chromium at
 * 4x CPU slowdown, where the studio root was still dehydrated after "networkidle").
 * @param {import("playwright-core").Page} page @param {import("playwright-core").Locator} control
 */
export async function waitForReactHydrated(page,control){
 const handle=await control.elementHandle();
 if(!handle)throw Error("The control is not attached");
 await page.waitForFunction(node=>{
  const element=/** @type {Record<string,any>} */(/** @type {unknown} */(node));
  const key=Object.keys(element).find(name=>name.startsWith("__reactFiber$"));
  /** @type {any} */
  let fiber=key?element[key]:null;
  while(fiber&&fiber.tag!==3)fiber=fiber.return; // 3: the HostRoot fiber
  const root=fiber?.stateNode;
  return Boolean(root&&root.current&&root.current.memoizedState?.isDehydrated===false&&root.pendingLanes===0);
 },handle);
}

/**
 * The document's vertical scroll position over the next animation frames. A route change that
 * lands still reads one number in every frame; an animated scroll moves the links under the pointer.
 * @param {import("playwright-core").Page} page
 */
export async function scrollPositionsOverFrames(page,frames=8){
 return page.evaluate(async count=>{
  const seen=[];
  for(let n=0;n<count;n++){seen.push(Math.round(window.scrollY));await new Promise(done=>requestAnimationFrame(()=>done(undefined)));}
  return seen;
 },frames);
}

/**
 * Applies a draft and waits until the screen holds it: `held` must stay true over `frames` animation frames in a row.
 * In WebKit a late commit after "networkidle" and after hydration can draw an editor again from its saved values,
 * so a draft typed a frame earlier is gone and its action button is disabled or does nothing (common cause no. 2:
 * the waits called from tests/e2e/store-copy.mjs). When the screen drops the draft, it is applied again, up to
 * `tries` times, and each time is logged as DRAFT_REAPPLIED, so a failure names what the page showed. Returns how many
 * applications it took. It never changes what the check expects: only when it starts acting.
 * @param {import("playwright-core").Page} page @param {string} name
 * @param {() => Promise<void>} apply @param {() => Promise<boolean>} held
 * @param {{tries?:number,frames?:number}} [options]
 */
export async function applyUntilHeld(page,name,apply,held,{tries=5,frames=4}={}){
 for(let attempt=1;attempt<=tries;attempt++){
  await apply();
  let stable=0;
  for(let frame=0;frame<frames*4&&stable<frames;frame++){
   await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>done(undefined))));
   stable=(await held().catch(()=>false))?stable+1:0;
  }
  if(stable>=frames)return attempt;
  console.log("DRAFT_REAPPLIED "+JSON.stringify({name,attempt}));
 }
 throw Error("The screen did not hold the draft of "+name+" after "+tries+" tries");
}
