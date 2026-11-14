/** Discord proves only its verified email. Nothing from its account is persisted. */
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { isRedisConfigured } from "@/lib/redis";
import { isHouseAddress } from "@/lib/house-store";
import { prefillHandle } from "@/lib/handle-prefill";
import { SITE_URL } from "@/lib/site-url";
import { timed } from "@/lib/fetch-timeout";
import { discordSignInReady } from "@/lib/discord-signin-policy";
import { keepProviderSignInState, takeProviderSignInState, PROVIDER_STATE_SECONDS } from "@/lib/provider-signin-state";
export { DISCORD_SIGNIN_APPROVED } from "@/lib/discord-signin-policy";
export const DISCORD_SIGNIN_SCOPES = ["identify", "email"] as const;
export const DISCORD_STATE_COOKIE = "nl_dsi";
export const DISCORD_CALLBACK_PATH = "/api/integrations/discord/signin";
const STATE = /^dsi\.[A-Za-z0-9_-]{43}$/;
const env = (name: string) => process.env[name]?.trim() ?? "";
export function discordSignInOffered(): boolean {
  return discordSignInReady() && isRedisConfigured() && Boolean(env("DISCORD_SIGNIN_CLIENT_ID") && env("DISCORD_SIGNIN_CLIENT_SECRET"));
}
export function discordSignInShown(host: string | null | undefined): boolean {
  return discordSignInOffered() && (host ?? "").toLowerCase() === new URL(SITE_URL).host;
}
export function discordStateCookie(state = ""): string {
  return `${DISCORD_STATE_COOKIE}=${state}; Path=${DISCORD_CALLBACK_PATH}; Max-Age=${state ? PROVIDER_STATE_SECONDS : 0}; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
export async function beginDiscordSignIn(handle?: unknown): Promise<{url: string; cookie: string} | null> {
  if (!discordSignInOffered()) return null;
  const state = `dsi.${randomBytes(32).toString("base64url")}`;
  const verifier = randomBytes(48).toString("base64url");
  const kept = JSON.stringify({ verifier, handle: prefillHandle(handle) ?? "" });
  if (!(await keepProviderSignInState(state, kept))) return null;
  const query = new URLSearchParams({ client_id: env("DISCORD_SIGNIN_CLIENT_ID"), response_type: "code", redirect_uri: `${SITE_URL}${DISCORD_CALLBACK_PATH}`, scope: DISCORD_SIGNIN_SCOPES.join(" "), state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", prompt: "consent" });
  return { url: `https://discord.com/oauth2/authorize?${query}`, cookie: discordStateCookie(state) };
}
/** Count body bytes as they arrive, including chunked answers; never follow a redirect with credentials. */
async function discordJson(url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
  return timed(5000, async signal => {
    const response = await fetch(url, { ...init, signal, cache: "no-store", redirect: "error" });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const {done,value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16384) { await reader.cancel(); return null; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = Buffer.concat(chunks);
    const json: unknown = JSON.parse(body.toString("utf8"));
    return json !== null && typeof json === "object" && !Array.isArray(json) ? json as Record<string,unknown> : null;
  });
}
export type DiscordSignInResult = {ok: true; email: string; handle: string} | {ok: false; reason: "expired" | "declined" | "unverified" | "error"};
export async function finishDiscordSignIn(state: string, browserState: string, code: string, issuer: string, declined: boolean): Promise<DiscordSignInResult> {
  if (!discordSignInOffered() || !STATE.test(state) || state !== browserState || issuer !== "https://discord.com") return {ok:false,reason:"expired"};
  const raw = await takeProviderSignInState(state);
  if (!raw) return {ok:false,reason:"expired"};
  try {
    const kept: unknown = JSON.parse(raw);
    if (!kept || typeof kept !== "object" || Array.isArray(kept)) return {ok:false,reason:"expired"};
    const {verifier,handle} = kept as Record<string,unknown>;
    if (Object.keys(kept).sort().join(",") !== "handle,verifier" || typeof verifier !== "string" || !/^[A-Za-z0-9_-]{64}$/.test(verifier) || typeof handle !== "string" || (handle !== "" && prefillHandle(handle) !== handle)) return {ok:false,reason:"expired"};
    if (declined || !code) return {ok:false,reason:"declined"};
    if (code.length > 2048 || !/^[A-Za-z0-9._~/-]+$/.test(code)) return {ok:false,reason:"error"};
    const token = await discordJson("https://discord.com/api/oauth2/token", { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body:new URLSearchParams({client_id:env("DISCORD_SIGNIN_CLIENT_ID"),client_secret:env("DISCORD_SIGNIN_CLIENT_SECRET"),grant_type:"authorization_code",code,redirect_uri:`${SITE_URL}${DISCORD_CALLBACK_PATH}`,code_verifier:verifier}).toString() });
    if (!token || typeof token.access_token !== "string" || !/^[A-Za-z0-9._~-]{1,4096}$/.test(token.access_token) || token.token_type !== "Bearer" || typeof token.scope !== "string" || token.scope.split(" ").sort().join(" ") !== "email identify" || !Number.isSafeInteger(token.expires_in) || (token.expires_in as number) <= 0) return {ok:false,reason:"error"};
    const person = await discordJson("https://discord.com/api/v10/users/@me", {headers:{Authorization:`Bearer ${token.access_token}`}});
    if (!person || typeof person.id !== "string" || !/^[0-9]{17,20}$/.test(person.id) || typeof person.email !== "string") return {ok:false,reason:"error"};
    if (person.verified !== true) return {ok:false,reason:"unverified"};
    const email = normaliseEmail(person.email);
    if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email) || isHouseAddress(email)) return {ok:false,reason:"error"};
    return {ok:true,email,handle};
  } catch { return {ok:false,reason:"error"}; }
}
