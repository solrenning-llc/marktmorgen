/** Browser-safe destinations. Never accept a caller-supplied redirect URL. */
import {HANDLE_PATTERN} from "@/lib/store-handle-pattern";
export const BUYER_PROVIDERS = ["google","apple","discord"] as const;
export type BuyerProvider = typeof BUYER_PROVIDERS[number];
export type BuyerSignInTarget = {kind:"library"}|{kind:"manage";handle:string};
export function buyerSignInTarget(raw:unknown):BuyerSignInTarget|null{
 if(raw==="library")return{kind:"library"};
 if(typeof raw!=="string" || !raw.startsWith("manage:") || raw.length>31)return null;
 const handle=raw.slice(7);
 return HANDLE_PATTERN.test(handle) && handle===handle.toLowerCase() && !handle.startsWith("_") ? {kind:"manage",handle} : null;
}
export function buyerSignInReturnPath(target:BuyerSignInTarget):string|null{
 if(target.kind==="library")return"/library";
 const parsed=buyerSignInTarget(`manage:${target.handle}`);
 return parsed?.kind==="manage" ? `/@${parsed.handle}/manage` : null;
}
/** Only exact server-approved options; unknown evidence displays none. */
export function buyerSignInOptions(offered:unknown):BuyerProvider[]{
 if(!Array.isArray(offered) || offered.length>12 || Reflect.ownKeys(offered).length!==offered.length+1)return[];
 const values:BuyerProvider[]=[];
 for(let i=0;i<offered.length;i++){
  const d=Object.getOwnPropertyDescriptor(offered,String(i));
  if(!d || !("value" in d) || !BUYER_PROVIDERS.includes(d.value))return[];
  values.push(d.value);
 }
 return BUYER_PROVIDERS.filter(p=>values.includes(p));
}
