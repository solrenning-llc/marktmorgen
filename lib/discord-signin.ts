export { DISCORD_SIGNIN_APPROVED } from "@/lib/discord-signin-policy";
export const DISCORD_SIGNIN_SCOPES = ["identify", "email"] as const;
export const DISCORD_STATE_COOKIE = "nl_dsi";
export function discordSignInOffered(): boolean { return false; }
export async function beginDiscordSignIn(_handle?: unknown): Promise<{url:string;cookie:string}|null> { return null; }
export async function finishDiscordSignIn(_state:string,_browserState:string,_code:string,_issuer:string,_declined:boolean): Promise<{ok:true;email:string;handle:string}|{ok:false;reason:string}> { return {ok:false,reason:"expired"}; }
