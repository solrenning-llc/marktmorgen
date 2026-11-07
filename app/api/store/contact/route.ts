import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { sendContact } from "@/lib/store-contact";

const MAX_BODY_BYTES = 6_000;

/**
 * The contact form on a store page (lib/store-contact.ts): a plain form, so it
 * works without JavaScript. The answer is always the store's contact page,
 * and nothing the visitor typed goes in its address.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let handle = "";
  let name = "";
  let email = "";
  let message = "";
  let honeypot = "";
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const read = (field: string) => {
      const value = form.get(field);
      return typeof value === "string" ? value : "";
    };
    handle = normaliseHandle(read("handle"));
    name = read("name").slice(0, 200);
    email = read("email").slice(0, 300);
    message = read("message").slice(0, 4_000);
    honeypot = read("website");
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return new Response("No such store.", { status: 404 });
  // One of the store's public requests for its window (lib/traffic.ts).
  if (!(await takePublicRequest(store))) return new Response("This store can't take messages right now. Please try again later.", { status: 429 });
  const away = (status: string) =>
    new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}/contact?status=${status}`, "Cache-Control": "no-store" } });
  // A field no person can see: whatever filled it in is told it worked, and nothing is sent.
  if (honeypot.trim()) return away("sent");
  try {
    return away(await sendContact({ store, name, email, message, ip: clientAddress(request) }));
  } catch (error) {
    console.error("sending a message to a creator failed", error);
    return away("error");
  }
}
