import { type NextRequest, after } from "next/server";
import { noticeCreator } from "@/lib/account-notice";
import { createHash } from "node:crypto";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { META_NOTICE_MAX_AGE_SECONDS, MetaIncompleteForget, forgetMetaUser, isMetaConfigured, signedNotice } from "@/lib/meta-ads";
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
  const notice = signedNotice(raw);
  if (!notice) return Response.json({ error: "invalid" }, { status: 400 });
  const { user } = notice;
  // Once only, as the Zoom callback: a notice already acted on is answered and does nothing, so one sent again never
  // forgets a connection made since. A notice we failed to act on lets go of its mark, so Meta's retry is heard. Read
  // exactly (CX-123 rule 24): a mark that cannot be read acts on nothing and is not confirmed.
  const seenKey = `nl:metaads:deauthseen:${createHash("sha256").update(notice.signature).digest("hex").slice(0, 40)}`;
  const mine = claimValue();
  const fresh = await claimMark(seenKey, META_NOTICE_MAX_AGE_SECONDS + 600, mine);
  if (fresh === "taken") return Response.json({ url: `${SITE_URL}/privacy#meta-ads`, confirmation_code: "meta-already-done" }, { headers: { "Cache-Control": "no-store" } });
  if (fresh === "unknown") {
    await releaseMark(seenKey, mine);
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  // Nothing is confirmed to Meta unless every store was read and forgotten exactly (CX-123 rule 24): an unknown reply
  // answers 503 with no confirmation code, the user's index kept, so Meta asks again.
  let forgot: Awaited<ReturnType<typeof forgetMetaUser>>;
  try {
    forgot = await forgetMetaUser(user);
  } catch (error) {
    console.error("forgetting a Meta user failed", error);
    // The stores this pass did forget are told now: the next pass reads them as gone (Claude 5 on #2869).
    if (error instanceof MetaIncompleteForget) tell(error.forgot);
    await releaseMark(seenKey, mine);
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
