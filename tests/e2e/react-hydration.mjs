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
