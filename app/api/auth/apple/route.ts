import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { clientAddress, essentialLimitState, fromAnotherSite, limited } from "@/lib/request-guard";
import { beginAppleSignIn, appleSignInOffered } from "@/lib/apple-signin";
import { SITE_URL } from "@/lib/site-url";
/** Supplier configuration and full cost admission are both absent by default. */
export async function POST(request: NextRequest): Promise<Response> {
  if (!appleSignInOffered()) return new Response("not found",{status:404});
  if (fromAnotherSite(request)) return new Response("forbidden",{status:403});
  const back=(status:string)=>new Response(null,{status:303,headers:{Location:`${SITE_URL}/signin?status=apple-${status}`,"Cache-Control":"no-store"}});
  if (originFrom(request)!==SITE_URL) return back("error");
  // Past the limit is "slow"; a counter that cannot be read is an error, never "too many tries".
  const tries=await essentialLimitState("apple-signin",clientAddress(request),20,600);
  if (tries!=="within") return back(tries==="exceeded"?"slow":"error");
  try {
    const form=await(await limited(request,4000)).formData();
    const begun=await beginAppleSignIn(form.get("handle"));
    if(!begun)return back("error");
    const response=new Response(null,{status:303,headers:{Location:begun.url,"Cache-Control":"no-store"}});
    response.headers.append("Set-Cookie",begun.cookie);
    return response;
  }catch{return back("error");}
}
