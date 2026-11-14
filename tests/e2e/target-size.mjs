/**
 * 2.5.5 Target Size (Enhanced, AAA): every control in `scope` is at least 44 by 44 CSS px.
 * A link inside a sentence is the criterion's inline exception; a box counts with its label,
 * which presses it too. Shared by the buyer actions and the studio matrix (AX274 Part A item 4).
 */
export const targetsUnder44=(page,scope="body")=>page.evaluate(scope=>{
 const out=[],shown=n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.visibility!=="hidden"&&!n.closest("[hidden],[inert],.sr-only");};
 for(const n of document.querySelector(scope)?.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button]")??[]){
  const label=n.matches("input")?(n.labels?.[0]??n.closest("label")):null;
  if(!shown(n)&&!(label&&shown(label)))continue;
  if(n.tagName==="A"&&getComputedStyle(n).display==="inline"){const p=n.parentElement;if(p&&(p.textContent||"").trim().length>(n.textContent||"").trim().length+3)continue;}
  const r=n.getBoundingClientRect(),l=label?label.getBoundingClientRect():r,width=Math.max(r.width,l.width),height=Math.max(r.height,l.height);
  if(width<43.5||height<43.5)out.push({tag:n.tagName,name:(n.getAttribute("aria-label")||n.textContent||"").trim().slice(0,60),width:Math.round(width),height:Math.round(height)});
 }
 return out;
},scope);
