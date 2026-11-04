import { readDiscountConfirmation } from "@/lib/discount-confirmation";
import { done,is,part } from "./check";

// An answer from before the optional rules (554 [DS1]) reads with none of them.
const none={minimum:null,firstOrder:false,duration:null,otherRules:false};
const code={id:"promo_kept",code:"Creator-Édition",off:{kind:"percent",percent:12.5},timesRedeemed:0,maxRedemptions:null,expiresAt:null,active:true};
part("Discount confirmation requires exact readable evidence");
for(const reply of [null,[],{}, {ok:"true",codes:[]},{ok:1,codes:[]},{ok:true},{ok:true,codes:null},{ok:true,codes:{}},{ok:true,codes:[null]},{ok:true,codes:[{}]},{ok:true,codes:[],error:"stripe"},Object.create({ok:true,codes:[]})]){
 is("unknown and contradictory replies are not empty success",readDiscountConfirmation(reply,true),null);
}
is("HTTP failure cannot confirm valid data",readDiscountConfirmation({ok:true,codes:[code]},false),null);
for(const row of [{...code,id:""},{...code,active:1},{...code,timesRedeemed:-1},{...code,timesRedeemed:NaN},{...code,timesRedeemed:0.5},{...code,maxRedemptions:0},{...code,expiresAt:Infinity},{...code,expiresAt:8640000000001},{...code,off:{}},{...code,off:{kind:"percent",percent:101}},{...code,off:{kind:"amount",cents:1,currency:"invalid"}},Object.create(code)]){
 is("malformed rows do not confirm a list",readDiscountConfirmation({ok:true,codes:[row]},true),null);
}
is("duplicate IDs are ambiguous",readDiscountConfirmation({ok:true,codes:[code,code]},true),null);
is("confirmed empty list is explicit",readDiscountConfirmation({ok:true,codes:[]},true),[]);
is("creator code spelling and fractional percent are preserved",readDiscountConfirmation({ok:true,codes:[code]},true),[{...code,...none}]);
const amount={...code,id:"promo_amount",off:{kind:"amount",cents:100,currency:"eur"},active:false,maxRedemptions:2,expiresAt:1790000000};
is("inactive amount code remains readable",readDiscountConfirmation({ok:true,codes:[amount]},true),[{...amount,...none}]);
is("provider code without discount details remains readable",readDiscountConfirmation({ok:true,codes:[{...code,off:null}]},true),[{...code,off:null,...none}]);
done();
