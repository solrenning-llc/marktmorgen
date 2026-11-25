import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { clientAddress, fromAnotherSite, limited, withinEssentialLimit } from "@/lib/request-guard";
import { beginDiscordSignIn, discordSignInOffered } from "@/lib/discord-signin";
import { SITE_URL } from "@/lib/site-url";
/** Nothing is read or written while approval or funded cost evidence is missing. */
export async function POST(request: NextRequest): Promise<Response> {
  if (!discordSignInOffered()) return new Response("not found", {status:404});
  if (fromAnotherSite(request)) return new Response("forbidden", {status:403});
  const origin = originFrom(request);
  const back = (status: string) => new Response(null, {status:303,headers:{Location:`${SITE_URL}/signin?status=discord-${status}`,"Cache-Control":"no-store"}});
  if (origin !== SITE_URL) return back("error");
  if (!(await withinEssentialLimit("discord-signin",clientAddress(request),20,600))) return back("slow");
  try {
    const form = await (await limited(request,4000)).formData();
    const begun = await beginDiscordSignIn(form.get("handle"));
    if (!begun) return back("error");
    const response = new Response(null,{status:303,headers:{Location:begun.url,"Cache-Control":"no-store"}});
    response.headers.append("Set-Cookie",begun.cookie);
    return response;
  } catch { return back("error"); }
}
