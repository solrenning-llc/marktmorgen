/** Native target reachability and fragment-center hit tests; not a complete keyboard audit. */
export async function checkPublicKeyboardCycle({page,path,is,onFocusSettled=undefined}) {
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const state=await page.evaluateHandle(()=>{
  const nodes=[...document.querySelectorAll("*")];
  const rendered=node=>{
   if(!(node instanceof HTMLElement)||node.tabIndex<0||node.matches(":disabled")||node.closest("[inert]"))return false;
   for(let parent=node.parentElement;parent;parent=parent.parentElement){
    if(parent.tagName==="DETAILS"&&!parent.open){
     const summary=[...parent.children].find(child=>child.tagName==="SUMMARY");
     if(!summary||!summary.contains(node))return false;
    }
   }
   const style=getComputedStyle(node),box=node.getBoundingClientRect();
   return style.display!=="none"&&style.visibility!=="hidden"&&box.width>0&&box.height>0&&node.getClientRects().length>0;
  };
  const candidates=nodes.filter(rendered),groups=[];
  for(const node of candidates){
   if(!(node instanceof HTMLInputElement)||node.type!=="radio"||!node.name)continue;
   if(groups.some(group=>group.includes(node)))continue;
   groups.push(candidates.filter(other=>other instanceof HTMLInputElement&&other.type==="radio"&&other.name===node.name&&other.form===node.form&&other.getRootNode()===node.getRootNode()));
  }
  const unsupported=groups.filter(group=>group.filter(node=>node.checked).length!==1||group.some(node=>node.closest('[role="toolbar"]'))).length;
  const expected=candidates.filter(node=>{
   const group=groups.find(group=>group.includes(node));
   return !group||node.checked;
  });
  return {nodes,expected,groups,unsupported};
 });
 try {
  const snapshot=await state.evaluate(({nodes,expected,groups,unsupported})=>({expected:expected.map(node=>nodes.indexOf(node)),groups:groups.map(group=>group.map(node=>nodes.indexOf(node))),unsupported}));
  const expected=snapshot.expected;
  is("keyboard fixture exposes native targets "+path,expected.length>0,true);
  is("native radio fixture has one selected option and is outside toolbars "+path,snapshot.unsupported,0);
  if(!expected.length||snapshot.unsupported)throw Error("Unsupported native keyboard fixture on "+path);
  const read=()=>state.evaluate(({nodes})=>{
   const node=document.activeElement,documentFocused=document.hasFocus();
   if(!documentFocused)return {outside:true,key:null};
   if(!node||node===document.body||node===document.documentElement)return {outside:false,key:null};
   const box=node.getBoundingClientRect();
   const style=getComputedStyle(node),radio=node instanceof HTMLInputElement&&node.type==="radio";
   const color=style.outlineColor.trim().toLowerCase();
   // Computed rgb(r,g,b) is opaque even when its blue channel is zero.
   // Only an explicit alpha (legacy rgba or slash notation) can make it clear.
   const alpha=color.includes("/")?color.slice(color.lastIndexOf("/")+1,-1):/^(?:rgba|hsla)\(/.test(color)?color.slice(color.lastIndexOf(",")+1,-1):"1";
   const painted=Boolean(color)&&color!=="transparent"&&Number.isFinite(parseFloat(alpha))&&parseFloat(alpha)>0;
   const outlined=style.outlineStyle==="solid"&&parseFloat(style.outlineWidth)>=3&&painted;
   return {outside:false,key:nodes.indexOf(node),visible:radio?outlined:node.matches(":focus-visible"),focusVisible:node.matches(":focus-visible"),outlined,outlineWidth:style.outlineWidth,outlineStyle:style.outlineStyle,outlineColor:style.outlineColor,width:box.width,height:box.height,checked:node instanceof HTMLInputElement?node.checked:null};
  });
  let focusChecks=0;
  const checkUnobscured=async key=>{
   const target=await state.evaluateHandle(({nodes},key)=>nodes[key],key);
   try {
    // Native focus can scroll smoothly. Observe the captured focused target;
    // never assign focus, scroll it by script, or retry a keyboard action.
    await page.waitForFunction(node=>{
     if(!document.hasFocus()||document.activeElement!==node)return false;
     const rects=[...node.getClientRects()].filter(rect=>rect.width>0&&rect.height>0);
     return rects.length>0&&rects.every(rect=>{
      const x=rect.left+rect.width/2,y=rect.top+rect.height/2;
      if(x<0||x>=innerWidth||y<0||y>=innerHeight)return false;
      const hit=document.elementFromPoint(x,y);
      return Boolean(hit&&(hit===node||node.contains(hit)));
     });
    },target,{timeout:3000});
    focusChecks++;
   } catch(error) {
    const geometry=await target.evaluate(node=>{
     const describe=element=>{
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      return {tag:element.tagName,id:element.id,classes:typeof element.className==="string"?element.className.slice(0,250):"",top:rect.top,height:rect.height,opacity:style.opacity,transform:style.transform,overflowY:style.overflowY,scrollTop:element.scrollTop,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight,scrollMarginTop:style.scrollMarginTop,scrollMarginBottom:style.scrollMarginBottom,scrollPaddingTop:style.scrollPaddingTop,scrollPaddingBottom:style.scrollPaddingBottom};
     };
     const parents=[];
     for(let parent=node.parentElement;parent&&parents.length<10;parent=parent.parentElement)parents.push(describe(parent));
     return {tag:node.tagName,id:node.id,text:node.textContent?.trim().slice(0,100),scrollY,viewport:{width:innerWidth,height:innerHeight},target:describe(node),children:[...node.children].slice(0,4).map(describe),parents,fragments:[...node.getClientRects()].map(rect=>{const x=rect.left+rect.width/2,y=rect.top+rect.height/2,hit=document.elementFromPoint(x,y);return {left:rect.left,top:rect.top,width:rect.width,height:rect.height,hitTag:hit?.tagName,hitId:hit?.id,hitClass:typeof hit?.className==="string"?hit.className:"",inside:Boolean(hit&&(hit===node||node.contains(hit)))};})};
    });
    console.log("AX2_KEYBOARD_OBSCURED:"+JSON.stringify({path,key,actual:await read(),geometry}));
    throw new Error("Keyboard focus obscured on "+path+" at target "+key,{cause:error});
   } finally {await target.dispose();}
  };
  const radioReports=[],testedGroups=new Set();
  const checkRadios=async current=>{
   const groupIndex=snapshot.groups.findIndex(group=>group.includes(current.key));
   if(groupIndex<0||testedGroups.has(groupIndex))return;
   testedGroups.add(groupIndex);
   const group=snapshot.groups[groupIndex],start=group.indexOf(current.key),reached=[current.key],steps=[];
   // Walk to both native ends and back to the initial option. WebKit does not
   // wrap native radio arrows; no browser-specific skip or focus assignment.
   for(let index=start+1;index<group.length;index++)steps.push({key:"ArrowRight",target:group[index]});
   for(let index=group.length-2;index>=0;index--)steps.push({key:"ArrowLeft",target:group[index]});
   for(let index=1;index<=start;index++)steps.push({key:"ArrowRight",target:group[index]});
   for(const {key,target} of steps){
    await page.keyboard.press(key);
    const targetHandle=await state.evaluateHandle(({nodes},key)=>nodes[key],target);
    try{
     // Controlled native radios may commit React state after keyup. Observe that
     // real focus and selection settled before issuing the next native key.
     await page.waitForFunction(node=>document.activeElement===node&&node.checked,targetHandle,{timeout:3000});
    }catch(error){
     console.log("AX2_RADIO_UNSETTLED:"+JSON.stringify({path,target,actual:await read()}));
     throw error;
    }finally{await targetHandle.dispose();}
    const actual=await read();
    is("native radio arrow reaches next option "+path,actual.key,target);
    is("native radio arrow checks focused visible option "+path,actual.checked&&actual.visible&&actual.width>0&&actual.height>0,true);
    await checkUnobscured(actual.key);
    reached.push(actual.key);
   }
   const restored=await read();
   is("native radio traversal restores original selection "+path,restored.key,current.key);
   is("native radio traversal covers every option "+path,new Set(reached).size,group.length);
   radioReports.push({group:groupIndex,expected:group.length,reached:new Set(reached).size,keys:steps.length,keyBound:2*(group.length-1),restored:restored.key===current.key});
  };
  const reports=[];
  for(const direction of ["Tab","Shift+Tab"]) {
   await page.bringToFront();
   const visited=new Set();let innerLoop=false,leftDocument=false;
   let current=await read();
   // The reverse journey starts at the last target reached by the forward journey.
   for(let step=0;step<expected.length+5;step++){
    if(current.outside){leftDocument=true;break;}
    if(current.key!==null){
     is("keyboard focus belongs to settled sequential targets "+path,expected.includes(current.key),true);
     is("native keyboard focus is visible "+path,current.visible&&current.width>0&&current.height>0,true);
     await checkUnobscured(current.key);
     if(visited.has(current.key)){innerLoop=true;break;}
     visited.add(current.key);
     await onFocusSettled?.({key:current.key,direction});
     await checkRadios(current);
     if(expected.every(key=>visited.has(key)))break;
    }
    await page.keyboard.press(direction);
    current=await read();
   }
   const missing=await state.evaluate(({nodes,expected},keys)=>expected.filter(node=>!keys.includes(nodes.indexOf(node))).map(node=>({key:nodes.indexOf(node),tag:node.tagName,href:node.getAttribute("href"),text:node.textContent?.trim().slice(0,100)})),[...visited]);
   is("native keyboard does not loop before all targets are reached "+path,!innerLoop,true);
   is("keyboard reaches every captured sequential target "+direction+" "+path,missing.length,0);
   reports.push({direction,expected:expected.length,reached:visited.size,leftDocument,innerLoop,missing});
  }
  is("native keyboard verifies every captured radio group "+path,testedGroups.size,snapshot.groups.length);
  console.log("AX2_KEYBOARD_CYCLE:"+JSON.stringify({path,reports,radioReports,focusChecks,scope:"Native target reachability and fragment-center hit tests in this settled state only. Pointer-transparent overlays, contrast, full visual obstruction, browser-chrome exit, semantic order, other disclosure states, menus, dialogs, real devices and conformance remain unverified."}));
  if(reports.some(report=>report.innerLoop||report.missing.length))throw Error("Native keyboard reachability failed for "+path);
 }finally{await state.dispose();}
}
