import { checkAdText, type AdContext } from "@/lib/ad-creative-check";
import { done, is } from "./check";
const context:AdContext={priceCents:4900,currency:"usd",ownHosts:["marktmorgen.com"],realDeadline:false,realStockLimit:false,verifiedReviews:[]};
const check=(headline:string)=>checkAdText({headline,text:"",description:"",button:""},context);
is("ordinary urgency is refused",check("Last chance").sendable,false);
is("contiguous Cyrillic disguise is refused",check("L\u0430st chance").sendable,false);
is("contiguous Greek disguise is refused",check("Limit\u03b5d time").sendable,false);
for(const join of ["\u200c","\u200d","\u200e","\u200f"]){
 const text=`L${join}\u0430${join}st chance`;
 const result=check(text);
 console.log("joined mixed script",JSON.stringify(text),result);
 is("joiner cannot hide Cyrillic urgency U+"+join.codePointAt(0)!.toString(16),result.sendable,false);
}
is("legitimate joined emoji remains allowed",check("Family 👨\u200d👩\u200d👧 yoga course").sendable,true);
is("legitimate Arabic direction mark remains allowed",check("دورة الخبز\u200f في البيت").sendable,true);
done();
