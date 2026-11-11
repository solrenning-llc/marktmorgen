/** Apple identity proof only. Program enrollment and all provider setup belong to the owner. */
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { isRedisConfigured } from "@/lib/redis";
import { isHouseAddress } from "@/lib/house-store";
import { prefillHandle } from "@/lib/handle-prefill";
import { SITE_URL } from "@/lib/site-url";
import { timed } from "@/lib/fetch-timeout";
import { appleSignInReady } from "@/lib/apple-signin-policy";
import { keepProviderSignInState, takeProviderSignInState, PROVIDER_STATE_SECONDS } from "@/lib/provider-signin-state";
export { APPLE_SIGNIN_APPROVED } from "@/lib/apple-signin-policy";
/** __Secure-: a SameSite=None cookie is only ever set and read over HTTPS (Claude 5 / Claude 1 LOW). */
export const APPLE_STATE_COOKIE = "__Secure-nl_asi";
export const APPLE_CALLBACK_PATH = "/api/integrations/apple/signin";
const ISSUER = "https://appleid.apple.com";
const STATE = /^asi\.[A-Za-z0-9_-]{43}$/;
const RELAY = new Set(["privaterelay.appleid.com", "private.icloud.com"]);
const env = (name: string) => process.env[name]?.trim() ?? "";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function clientKey() {
  try {
    const key = createPrivateKey(env("APPLE_SIGNIN_PRIVATE_KEY"));
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1" ? key : null;
  } catch { return null; }
}
/** A short-lived ES256 client secret, generated in memory, never stored. */
export function appleClientSecret(now = Date.now()): string | null {
  const client = env("APPLE_SIGNIN_CLIENT_ID"), team = env("APPLE_SIGNIN_TEAM_ID"), kid = env("APPLE_SIGNIN_KEY_ID");
  if (!Number.isFinite(now) || now < 0 || !client || client.length > 255 || !/^[A-Z0-9]{10}$/.test(team) || !/^[A-Z0-9]{10}$/.test(kid)) return null;
  const key = clientKey();
  if (!key) return null;
  const iat = Math.floor(now / 1000);
  const input = `${encode({alg:"ES256",kid,typ:"JWT"})}.${encode({iss:team,iat,exp:iat+300,aud:ISSUER,sub:client})}`;
  try { return `${input}.${sign("sha256",Buffer.from(input),{key,dsaEncoding:"ieee-p1363"}).toString("base64url")}`; } catch { return null; }
}
export function appleSignInOffered(): boolean {
  return appleSignInReady() && isRedisConfigured() && Boolean(env("APPLE_SIGNIN_CLIENT_ID") && /^[A-Z0-9]{10}$/.test(env("APPLE_SIGNIN_TEAM_ID")) && /^[A-Z0-9]{10}$/.test(env("APPLE_SIGNIN_KEY_ID")) && clientKey());
}
export function appleSignInShown(host: string | null | undefined): boolean {
  return appleSignInOffered() && (host ?? "").toLowerCase() === new URL(SITE_URL).host;
}
/** Apple's email scope requires a cross-site form POST, so Lax would drop the binding. */
export function appleStateCookie(state = ""): string {
  return `${APPLE_STATE_COOKIE}=${state}; Path=${APPLE_CALLBACK_PATH}; Max-Age=${state ? PROVIDER_STATE_SECONDS : 0}; HttpOnly; SameSite=None; Secure`;
}
export async function beginAppleSignIn(handle?: unknown): Promise<{url:string;cookie:string}|null> {
  if (!appleSignInOffered()) return null;
  const state = `asi.${randomBytes(32).toString("base64url")}`, nonce = randomBytes(32).toString("base64url");
  if (!(await keepProviderSignInState(state,JSON.stringify({nonce,handle:prefillHandle(handle) ?? ""})))) return null;
  const query = new URLSearchParams({client_id:env("APPLE_SIGNIN_CLIENT_ID"),redirect_uri:`${SITE_URL}${APPLE_CALLBACK_PATH}`,response_type:"code",response_mode:"form_post",scope:"email",state,nonce});
  return {url:`${ISSUER}/auth/authorize?${query}`,cookie:appleStateCookie(state)};
}
async function appleJson(path: "/auth/token" | "/auth/keys", init: RequestInit): Promise<Record<string,unknown>|null> {
  return timed(5000,async signal=>{
    const response = await fetch(`${ISSUER}${path}`,{...init,signal,redirect:"error",cache:"no-store"});
    if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); return null; }
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];
    let bytes=0;
    try { for (;;) { const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>16384){await reader.cancel();return null;}chunks.push(value); } } finally { reader.releaseLock(); }
    const json:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return json && typeof json === "object" && !Array.isArray(json) ? json as Record<string,unknown> : null;
  });
}
function objectFromPart(part: string): Record<string,unknown>|null {
  if (!/^[A-Za-z0-9_-]+$/.test(part) || Buffer.from(part,"base64url").toString("base64url")!==part) return null;
  const value:unknown=JSON.parse(Buffer.from(part,"base64url").toString("utf8"));
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : null;
}
/** JWT algorithm is pinned; keys are only ever fetched from the fixed Apple endpoint. */
async function verifiedClaims(idToken: unknown): Promise<Record<string,unknown>|null> {
  if (typeof idToken !== "string" || idToken.length>8000) return null;
  const parts=idToken.split(".");
  if(parts.length!==3)return null;
  const h=objectFromPart(parts[0]),claims=objectFromPart(parts[1]);
  if(!h || !claims || h.alg!=="RS256" || typeof h.kid!=="string" || !/^[A-Za-z0-9_-]{1,128}$/.test(h.kid) || h.crit!==undefined || h.b64!==undefined || !/^[A-Za-z0-9_-]+$/.test(parts[2]))return null;
  const jwks=await appleJson("/auth/keys",{});
  if(!jwks || !Array.isArray(jwks.keys) || jwks.keys.length===0 || jwks.keys.length>8)return null;
  const matches=jwks.keys.filter((k:unknown)=>k && typeof k==="object" && !Array.isArray(k) && (k as Record<string,unknown>).kid===h.kid);
  if(matches.length!==1)return null;
  const k=matches[0] as Record<string,unknown>;
  if(k.kty!=="RSA" || k.alg!=="RS256" || k.use!=="sig" || typeof k.n!=="string" || !/^[A-Za-z0-9_-]{342,683}$/.test(k.n) || k.e!=="AQAB")return null;
  const key=createPublicKey({format:"jwk",key:{kty:"RSA",n:k.n,e:k.e}});
  const bits=key.asymmetricKeyDetails?.modulusLength ?? 0;
  if(bits<2048 || bits>4096 || !verify("RSA-SHA256",Buffer.from(`${parts[0]}.${parts[1]}`),key,Buffer.from(parts[2],"base64url")))return null;
  return claims;
}
export type AppleSignInResult={ok:true;email:string;handle:string;privateRelay:boolean}|{ok:false;reason:"expired"|"declined"|"unverified"|"error"};
export async function finishAppleSignIn(state:string,browserState:string,code:string,declined:boolean):Promise<AppleSignInResult>{
  if(!appleSignInOffered() || !STATE.test(state) || state!==browserState)return{ok:false,reason:"expired"};
  const raw=await takeProviderSignInState(state);
  if(!raw)return{ok:false,reason:"expired"};
  try {
    const kept:unknown=JSON.parse(raw);
    if(!kept || typeof kept!=="object" || Array.isArray(kept))return{ok:false,reason:"expired"};
    const {nonce,handle}=kept as Record<string,unknown>;
    if(Object.keys(kept).sort().join(",")!=="handle,nonce" || typeof nonce!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(nonce) || typeof handle!=="string" || (handle!=="" && prefillHandle(handle)!==handle))return{ok:false,reason:"expired"};
    if(declined || !code)return{ok:false,reason:"declined"};
    if(code.length>2048 || !/^[A-Za-z0-9._~/-]+$/.test(code))return{ok:false,reason:"error"};
    const secret=appleClientSecret();
    if(!secret)return{ok:false,reason:"error"};
    const token=await appleJson("/auth/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:env("APPLE_SIGNIN_CLIENT_ID"),client_secret:secret,code,grant_type:"authorization_code",redirect_uri:`${SITE_URL}${APPLE_CALLBACK_PATH}`}).toString()});
    if(!token || token.token_type!=="Bearer" || !Number.isSafeInteger(token.expires_in) || (token.expires_in as number)<=0)return{ok:false,reason:"error"};
    const c=await verifiedClaims(token.id_token),now=Math.floor(Date.now()/1000);
    if(!c || c.iss!==ISSUER || c.aud!==env("APPLE_SIGNIN_CLIENT_ID") || c.nonce!==nonce || typeof c.sub!=="string" || !c.sub || c.sub.length>255 || !Number.isSafeInteger(c.exp) || (c.exp as number)<=now || !Number.isSafeInteger(c.iat) || (c.iat as number)>now+60 || (c.iat as number)<now-600 || (c.exp as number)<=(c.iat as number) || typeof c.email!=="string")return{ok:false,reason:"error"};
    // Apple documents boolean and string forms; no truthiness or numeric coercion.
    if(c.email_verified!==true && c.email_verified!=="true")return{ok:false,reason:"unverified"};
    if(c.is_private_email!==undefined && ![true,false,"true","false"].includes(c.is_private_email as boolean|string))return{ok:false,reason:"error"};
    const email=normaliseEmail(c.email);
    if(email.length>MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email) || isHouseAddress(email))return{ok:false,reason:"error"};
    const privateRelay=c.is_private_email===true || c.is_private_email==="true" || RELAY.has(email.slice(email.lastIndexOf("@")+1));
    return{ok:true,email,handle,privateRelay};
  }catch{return{ok:false,reason:"error"};}
}
