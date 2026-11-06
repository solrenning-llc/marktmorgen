/**
 * VS1 (queue item 571): the pages in the morning look have no dark surface.
 * Every visible element at least 12px across, in the whole page (menu and
 * footer included), whose own background color is opaque enough to be seen
 * must be light: relative luminance 0.3 or more. Text color is not a ground
 * and is checked by the contrast rules instead. Returns the offenders.
 */
export async function darkGrounds(page){
 return page.evaluate(()=>{
  const lum=color=>{const m=color.match(/rgba?\(([^)]+)\)/);if(!m)return 1;const [r,g,b,a=1]=m[1].split(/[ ,/]+/).filter(Boolean).map(Number);if(a<0.5)return 1;return [r,g,b].map(v=>{v/=255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);};
  return [...document.querySelectorAll("body *")].filter(node=>{const box=node.getBoundingClientRect();if(box.width<12||box.height<12)return false;const style=getComputedStyle(node);return style.visibility!=="hidden"&&style.display!=="none"&&lum(style.backgroundColor)<0.3;}).slice(0,8).map(node=>node.tagName+"."+String(node.className).slice(0,60)+" "+getComputedStyle(node).backgroundColor);
 });
}
