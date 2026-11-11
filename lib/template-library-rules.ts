export const TEMPLATE_GOALS=["all","leads","sales","teaching","services"] as const;
export type TemplateGoal=typeof TEMPLATE_GOALS[number];
export type LibraryCard={id:string;kind:"page"|"funnel"|"email"|"sequence"|"course"|"saved";label:string;hint:string;goal:Exclude<TemplateGoal,"all">;preview:string[];free?:boolean};
export function matchingLibrary(cards:readonly LibraryCard[],goal:TemplateGoal,kind:string,query:string){
 const terms=query.trim().slice(0,100).toLowerCase().split(/\s+/).filter(Boolean);
 return cards.filter(card=>(goal==="all"||card.goal===goal)&&(kind==="all"||card.kind===kind)&&terms.every(term=>[card.label,card.hint,...card.preview].join(" ").toLowerCase().includes(term)));
}
export function libraryDestination(card:LibraryCard,sid:string,product=""){
 const query="store="+encodeURIComponent(sid)+(product?"&product="+encodeURIComponent(product):"");
 if(card.kind==="funnel")return "/studio/funnels?"+query+"&campaignGoal="+card.goal+"#starter="+encodeURIComponent(card.id);
 if(card.kind==="course")return product?"/studio/course/"+encodeURIComponent(product)+"?store="+encodeURIComponent(sid)+"&template="+encodeURIComponent(card.id):"/studio?store="+encodeURIComponent(sid)+"#products";
 if(card.kind==="page")return "/studio/pages?"+query+"&template="+encodeURIComponent(card.id);
 if(card.kind==="saved")return "/studio/pages?"+query+"&sectionTemplate="+encodeURIComponent(card.id);
 return "/studio/email?"+query+"&"+(card.kind==="email"?"emailTemplate":"sequenceTemplate")+"="+encodeURIComponent(card.id);
}
