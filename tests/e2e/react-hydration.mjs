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
