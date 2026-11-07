import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { clientAddress, fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { storeForId } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { LINK_ID, MAX_PASSWORD, cookieName, linkStore, passCookie, passwordFits } from "@/lib/numbers-links";

const MAX_BODY_BYTES = 600;

/**
 * The password form on a numbers link (app/numbers/[id]): a right password
 * leaves a signed cookie for that link only, for twelve hours at most; a
 * wrong one says so. Ten tries in ten minutes from one connection.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let id = "";
  let password = "";
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    id = typeof form.get("id") === "string" ? String(form.get("id")) : "";
    password = typeof form.get("password") === "string" ? String(form.get("password")).slice(0, MAX_PASSWORD) : "";
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!LINK_ID.test(id)) return new Response("Not found", { status: 404 });
  const back = (query = "") => new Response(null, { status: 303, headers: { Location: `${origin}/numbers/${id}${query}`, "Cache-Control": "no-store" } });
  if (!(await withinLimit("numbers-link", `${clientAddress(request)}|${id}`, 10, 600))) return back("?tries=1");
  // A link that could not be read just now is said so (rule 24): never sent back as ended, never a crash.
  let store: Awaited<ReturnType<typeof storeForId>>;
  try {
    const sid = await linkStore(id);
    store = sid ? await storeForId(sid) : null;
  } catch (error) {
    console.error("a numbers link could not be read for its password", error);
    // Back to the page's own notice, in its language and layout, never a bare text page (Claude 5 on #2971).
    return back("?unread=1");
  }
  const link = store?.numbersLinks.find((l) => l.id === id);
  const now = Date.now();
  if (!link || link.expires <= Math.floor(now / 1000)) return back();
  // A password tried is one of the store's public requests for its window (lib/traffic.ts).
  if (!store) return back();
  // The store's window refused, or not known to be taken: not "too many tries", which is this connection's own count.
  if (!(await takePublicRequest(store, "public", now))) return back("?busy=1");
  if (!passwordFits(link, password)) return back("?wrong=1");
  const cookie = passCookie(link, now);
  if (!cookie) return back("?wrong=1");
  const response = back();
  const seconds = Math.max(1, Number(cookie.split(".")[0]) - Math.floor(now / 1000));
  response.headers.append(
    "Set-Cookie",
    `${cookieName(id)}=${cookie}; Path=/numbers/${id}; Max-Age=${seconds}; HttpOnly; SameSite=Lax${origin.startsWith("https://") ? "; Secure" : ""}`,
  );
  return response;
}
