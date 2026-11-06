import { checkAdText, type AdContext, type AdText } from "@/lib/ad-creative-check";
import { done, is } from "./check";
const context:AdContext={priceCents:4900,currency:"usd",ownHosts:["marktmorgen.com"],realDeadline:false,realStockLimit:false,verifiedReviews:[]};
const ad=(field:keyof AdText,value:string):AdText=>({headline:"Bake at home",text:"",description:"",button:"",[field]:value});
const points=[...Array.from({length:16},(_,i)=>0xfe00+i),...Array.from({length:240},(_,i)=>0xe0100+i)];
for(const field of ["headline","text","description","button"] as const) for(const cp of points){
const mark=String.fromCodePoint(cp);
const result=checkAdText(ad(field,`L${mark}\u0430${mark}st chance`),context);
is(`selector ${cp.toString(16)} in ${field} cannot disguise mixed script`,result.refusals.some(r=>r.field===field&&r.rule==="disguised")&&!result.sendable,true);
}
for(const text of ["Love ❤️ baking course","Family 👨\u200d👩\u200d👧 yoga course","Flag 🏳️\u200d🌈 pride guide","Crème brûlée à la maison","Хлеб дома","Пе\u0301карь дома","دورة الخبز\u200f في البيت","קורס אפייה\u200f בבית","Δelta Yoga","Ωmega 3 guide","ᠠ᠋ ᠨ᠌","Bread and recipes"]){
is(`legitimate text remains sendable: ${text}`,checkAdText(ad("headline",text),context).sendable,true);
}
done();
