import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { fromAnotherSite } from "@/lib/studio-route";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { readLetter } from "@/lib/letters";
import { LETTER_ID, membersOnly } from "@/lib/letter-rules";
import { requestLetterLink } from "@/lib/letter-access";
import { clientIp } from "@/lib/visit";
import { limited } from "@/lib/request-guard";
import { restingAway, takeBuyerRead } from "@/lib/buyer-actions";

/** "Send me the link": a reader proving their address to read an email kept for members (lib/letter-access.ts). */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });

  let handle = "";
  let id = "";
  let email = "";
  try {
    const form = await (await limited(request, 8_000)).formData();
    handle = normaliseHandle(String(form.get("handle") ?? ""));
    id = String(form.get("letter") ?? "").slice(0, 40);
    email = String(form.get("email") ?? "").slice(0, 300);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle && LETTER_ID.test(id) ? await storeForHandle(handle) : null;
  if (!store || store.suspended) return new Response("Not found.", { status: 404 });

  // One of the store's public requests on the buyers' side (lib/buyer-actions.ts); the email it sends is an access email.
  if (!(await takeBuyerRead(store))) return restingAway(origin, store);
  const letter = await readLetter(store, id);
  if (!letter || !membersOnly(letter)) return new Response("Not found.", { status: 404 });
  let result: string;
  try {
    result = await requestLetterLink({ store, letter, email, ip: clientIp(request), origin: linkOrigin(request, store) });
  } catch (error) {
    console.error("sending a link to read an email failed", error);
    result = "error";
  }
  return new Response(null, {
    status: 303,
    headers: { Location: `${origin}/@${store.handle}/letters/${letter.id}?link=${result}`, "Cache-Control": "no-store" },
  });
}
