export const BUYER_PROVIDERS = ["google","apple","discord"] as const;
export type BuyerProvider = typeof BUYER_PROVIDERS[number];
export type BuyerSignInTarget = {kind:"library"}|{kind:"manage";handle:string};
export function buyerSignInTarget(_raw:unknown):BuyerSignInTarget|null{return null;}
export function buyerSignInReturnPath(_target:BuyerSignInTarget):string|null{return null;}
export function buyerSignInOptions(_offered:unknown):BuyerProvider[]{return [];}
