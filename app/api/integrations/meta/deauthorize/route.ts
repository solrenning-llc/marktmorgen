import { type NextRequest, after } from "next/server";
import { noticeCreator } from "@/lib/account-notice";
import { MetaIncompleteForget, forgetMetaUser, isMetaConfigured, signedUser } from "@/lib/meta-ads";
import { clientAddress, limited, withinLimit } from "@/lib/request-guard";
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
  if (!(await withinLimit("metaads-deauth", clientAddress(request), 60, 600))) return new Response("Too many requests.", { status: 429 });
  let raw: unknown = null;
  try {
    const form = await (await limited(request, 8_192)).formData();
    raw = form.get("signed_request");
  } catch {
    return Response.json({ error: "invalid" }, { status: 400 });
  }
  const user = signedUser(raw);
  if (!user) return Response.json({ error: "invalid" }, { status: 400 });
  // Nothing is confirmed to Meta unless every store was read and forgotten exactly (CX-123 rule 24): an unknown reply
  // answers 503 with no confirmation code, the user's index kept, so Meta asks again.
  let forgot: Awaited<ReturnType<typeof forgetMetaUser>>;
  try {
    forgot = await forgetMetaUser(user);
  } catch (error) {
    console.error("forgetting a Meta user failed", error);
    // The stores this pass did forget are told now: the next pass reads them as gone (Claude 5 on #2869).
    if (error instanceof MetaIncompleteForget) tell(error.forgot);
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  tell(forgot);
  const code = `meta-${Date.now().toString(36)}-${forgot.length}`;
  return Response.json({ url: `${SITE_URL}/privacy#meta-ads`, confirmation_code: code }, { headers: { "Cache-Control": "no-store" } });
}

function tell(forgot: { owner: { email: string; handle: string } }[]): void {
  if (forgot.length) after(async () => {
    for (const store of forgot) await noticeCreator(store.owner, { kind: "metaads-disconnected", byMeta: true });
  });
}
