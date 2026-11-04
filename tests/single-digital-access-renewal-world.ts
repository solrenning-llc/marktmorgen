/** Existing synthetic Stripe/Undici boundary; no real provider can connect. */
export { fixture, blobReads } from "./single-digital-access-targeted-world";
export async function expireGrant(token: string) {
  const { store } = await import("./redis-stub");
  const { createHash } = await import("node:crypto");
  const key = `nl:orders:link:${createHash("sha256").update(`nimbus-orders:${token}`).digest("hex").slice(0,40)}`;
  store.run(["DEL",key]);
}

import { store as redis } from "./redis-stub";
import { SHIPMENT_MAIL_SCRIPT } from "@/lib/shipment-mail-outbox";
import { fixture } from "./single-digital-access-targeted-world";
export async function renewalFixture() {
  const f=await fixture();
  f.runtime.policy={...f.runtime.policy!,coveredOrigins:["single-digital-confirmation","single-digital-access-renewal"],
    singleDigitalAccessEvidence:"SYNTHETIC_ONLY token/access coverage",singleDigitalRenewalEvidence:"SYNTHETIC_ONLY lifetime custody/trigger/send/token coverage"};
  const base=f.runtime.pipeline!;
  f.runtime.pipeline=async commands=>{
    const output:unknown[]=[];
    for(const c of commands){
      if(c[0]==="EVAL" && c[1]===SHIPMENT_MAIL_SCRIPT && c[3+Number(c[2])]==="renewal-prepare"){
        const raw=redis.run(["GET",String(c[3])]);
        if(raw!==c[4+Number(c[2])])output.push(["changed"]);
        else{redis.run(["SET",String(c[3]),String(c[5+Number(c[2])])]);output.push(["prepared",String(c[5+Number(c[2])])]);}
      }else output.push(...await base([c]));
    }
    return output;
  };
  await expireGrant(f.token);
  return f;
}
export const request = (url:URL,body:URLSearchParams,origin=url.origin) => {
  const r=new Request(url,{method:"POST",headers:{origin,host:url.host,"content-type":"application/x-www-form-urlencoded"},body});
  Object.defineProperty(r,"nextUrl",{value:url});return r as unknown as import("next/server").NextRequest;
};
export function formFields(html:string):URLSearchParams{
  const form=new URLSearchParams();
  for(const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g))form.set(match[1],match[2].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
  return form;
}
export function tokenKeys(){return [...redis.keys()].filter(k=>k.startsWith("nl:orders:link:"));}
