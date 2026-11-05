/** @param {import("playwright-core").Page} page @param {import("playwright-core").Locator} control */
export async function waitForReactChangeHandler(page,control){
 const handle=await control.elementHandle();
 if(!handle)throw Error("The controlled field is not attached");
 await page.waitForFunction(element=>Object.keys(element).some(key=>key.startsWith("__reactProps$")&&typeof element[key]?.onChange==="function"),handle);
}
