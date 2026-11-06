import { withinStore } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { fromAnotherSite } from "@/lib/studio-route";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { readOrder } from "@/lib/store-checkout";
import {
  BUYER_COOKIE,
  buyerFingerprint,
  mintPass,
  passCookie,
  recordEnrollment,
  sendCourseLink,
  touchStudent,
} from "@/lib/learn";
import { clientAddress, limited, withinLimit } from "@/lib/request-guard";
import { courseToStart } from "@/lib/order-courses";

/**
 * The thanks page's "Start the course" button.
 *
 * In the browser that paid, the course opens at once: the checkout left a
 * secret here and its fingerprint is on the charge, so this browser is the
 * buyer's. Anywhere else — a thanks link opened on another device — the way
 * in goes to the address that paid instead, because a link can be forwarded
 * and an inbox cannot.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  const away = (path: string, cookie?: string) => {
    const headers = new Headers({ Location: `${origin}${path}`, "Cache-Control": "no-store" });
    if (cookie) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 303, headers });
  };

  let handle = "";
  let sessionId = "";
  let asked = "";
  try {
    const form = await (await limited(request, 8_000)).formData();
    handle = normaliseHandle(String(form.get("handle") ?? ""));
    sessionId = String(form.get("session_id") ?? "");
    // A course named by its id: only one this order hands over (lib/order-courses.ts).
    asked = String(form.get("product") ?? "").slice(0, 64);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return new Response("No such store.", { status: 404 });
  // A press may email the buyer a link, so it is counted like the other
  // forms that send one: per connection, and per order.
  if (
    !(await withinStore("course-start", `${clientAddress(request)}|${store.handle}`, 10, 3600, store, "buyer")) ||
    !(await withinLimit("course-start-order", sessionId.slice(0, 220), 5, 3600))
  ) {
    return away(`/@${store.handle}`);
  }

  const order = await readOrder(store, sessionId);
  if (order.state !== "paid" || order.gift || order.group || order.preorder) return away(`/@${store.handle}`);
  // The course named, when this order hands it over (lib/order-courses.ts): in a bundle, or a cart's product after its first.
  const product = courseToStart(order, asked);
  if (!product?.course) return away(`/@${store.handle}`);
  const course = product.course!;
  const path = `/@${store.handle}/course/${product.id}`;
  if (!order.email) return away(`${path}?link=ask`);

  await recordEnrollment(store, order.email, product.id, order.created);
  const secret = request.cookies.get(BUYER_COOKIE)?.value ?? "";
  if (secret && order.buyerKey && buyerFingerprint(secret) === order.buyerKey) {
    await touchStudent(course.id, order.email, order.created, store);
    const token = await mintPass(store, order.email, [course.id]);
    return away(path, passCookie(store, token, origin.startsWith("https://")));
  }
  const sent = await sendCourseLink(store, product, order.email, linkOrigin(request, store));
  return away(`${path}?link=${sent ? "sent" : "error"}`);
}
