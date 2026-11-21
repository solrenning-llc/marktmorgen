import {checkAdText,type AdContext} from '@/lib/ad-creative-check';
import {done,is} from './check';
const context:AdContext={priceCents:4900,currency:'usd',ownHosts:['marktmorgen.com'],realDeadline:false,realStockLimit:false,verifiedReviews:[]};
const check=(headline:string)=>checkAdText({headline,text:'',description:'',button:''},context);
for(const selector of ['\uFE0E','\uFE0F','\u{E0100}']){
const headline=`L${selector}\u0430${selector}st chance`;
console.log(JSON.stringify(headline),check(headline));
is('variation selector cannot disguise mixed-script urgency '+selector.codePointAt(0),check(headline).sendable,false);
}
is('ordinary urgency refused',check('Last chance').sendable,false);
is('legitimate emoji selector preserved',check('Love ❤️ baking course').sendable,true);
is('legitimate Cyrillic text preserved',check('Хлеб дома').sendable,true);
done();
