import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { fromAnotherSite } from "@/lib/studio-route";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { postForMembers, postSegment, readPost } from "@/lib/store-blog";
import { requestMemberLink } from "@/lib/letter-access";
import { clientIp } from "@/lib/visit";
import { limited } from "@/lib/request-guard";
import { restingAway, takeBuyerRead } from "@/lib/buyer-actions";

const POST_ID = /^[0-9a-f]{10}$/;

/**
 * "Send me the link": a reader proving their address to read a blog post
 * kept for members, on the door published emails use (lib/letter-access.ts):
 * the same answer at once, the same limits, the same link.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });

  let handle = "";
  let id = "";
  let email = "";
  try {
    const form = await (await limited(request, 8_000)).formData();
    handle = normaliseHandle(String(form.get("handle") ?? ""));
    id = String(form.get("post") ?? "").slice(0, 20);
    email = String(form.get("email") ?? "").slice(0, 300);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle && POST_ID.test(id) ? await storeForHandle(handle) : null;
  if (!store || store.suspended) return new Response("Not found.", { status: 404 });

  // One of the store's public requests on the buyers' side (lib/buyer-actions.ts); the email it sends is an access email.
  if (!(await takeBuyerRead(store))) return restingAway(origin, store);
  const post = await readPost(store.statsId, id);
  if (!post || post.draft || !postForMembers(post)) return new Response("Not found.", { status: 404 });
  let result: string;
  try {
    result = await requestMemberLink({ store, door: { kind: "post", id: post.id, title: post.title, products: post.products }, email, ip: clientIp(request), origin: linkOrigin(request, store) });
  } catch (error) {
    console.error("sending a link to read a post failed", error);
    result = "error";
  }
  return new Response(null, {
    status: 303,
    headers: { Location: `${origin}/@${store.handle}/blog/${postSegment(post)}?link=${result}`, "Cache-Control": "no-store" },
  });
}
