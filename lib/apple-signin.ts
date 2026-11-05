export { APPLE_SIGNIN_APPROVED } from "@/lib/apple-signin-policy";
export function appleSignInOffered(): boolean { return false; }
export function appleClientSecret(_now=Date.now()): string | null { return null; }
export async function beginAppleSignIn(_handle?: unknown): Promise<{url:string;cookie:string}|null> { return null; }
export async function finishAppleSignIn(_state:string,_browserState:string,_code:string,_declined:boolean): Promise<{ok:true;email:string;handle:string;privateRelay:boolean}|{ok:false;reason:string}> { return {ok:false,reason:"expired"}; }
