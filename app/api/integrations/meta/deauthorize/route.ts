import { type NextRequest, after } from "next/server";
import { noticeCreator } from "@/lib/account-notice";
import { forgetMetaUser, isMetaConfigured, signedUser } from "@/lib/meta-ads";
import { clientAddress, limited, withinLimit, unknownLimit, limitUnknownResponse } from "@/lib/request-guard";
import { SITE_URL } from "@/lib/site-url";

/**
 * Meta's notice that a person removed the app from their Facebook account,
 * or asked for their data to be deleted: registered with the Meta app as
 * both its Deauthorize callback and its Data Deletion Request callback,
 * https://marktmorgen.com/api/integrations/meta/deauthorize. The request is
 * signed with the app's secret (signed_request); every store that person
 * connected forgets the connection and what was read from it at once, and
 * its owner is told. Answered as Meta asks of a deletion callback: where to
 * read about it, and a code for the request.
 */
export async function POST(request: NextRequest) {
  if (!isMetaConfigured()) return new Response("Not found.", { status: 404 });
  const room = await withinLimit("metaads-deauth", clientAddress(request), 60, 600).catch(unknownLimit);
  if (room === "unknown") return limitUnknownResponse();
  if (!room) return new Response("Too many requests.", { status: 429 });
  let raw: unknown = null;
  try {
    const form = await (await limited(request, 8_192)).formData();
    raw = form.get("signed_request");
  } catch {
    return Response.json({ error: "invalid" }, { status: 400 });
  }
  const user = signedUser(raw);
  if (!user) return Response.json({ error: "invalid" }, { status: 400 });
  const forgot = await forgetMetaUser(user);
  if (forgot.length) after(async () => {
    for (const store of forgot) await noticeCreator(store.owner, { kind: "metaads-disconnected", byMeta: true });
  });
  const code = `meta-${Date.now().toString(36)}-${forgot.length}`;
  return Response.json({ url: `${SITE_URL}/privacy#meta-ads`, confirmation_code: code }, { headers: { "Cache-Control": "no-store" } });
}
