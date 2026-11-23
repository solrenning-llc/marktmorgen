import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { openReport } from "@/lib/takedown";
import { decideAppeal, tellCreatorAgain } from "@/lib/takedown-appeals";
import { MAX_APPEAL_REASON } from "@/lib/takedown-appeal-rules";

/**
 * A person at Marktmorgen answers a creator's request to look again (646 [WG6], unit 3), from the notice's own page:
 * `{ token, decision, to, reason }` moves it (Under review, Upheld or Reversed, a final answer with its reason) and
 * emails the creator; `{ token, decision, action: "again" }` emails the creator the state they were not told of. The
 * token is the one in the email the notice was sent in, as for app/api/takedown: only the store that notice is about,
 * and only its decisions about that notice, can be answered with it.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const raw: unknown = await (await limited(request, MAX_APPEAL_REASON * 4 + 1_000)).json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    body = raw as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  const opened = await openReport(typeof body.token === "string" ? body.token : "");
  if (!opened) return Response.json({ ok: false, error: "gone" }, { status: 404 });
  if (!opened.store) return Response.json({ ok: false, error: "no_store" }, { status: 400 });
  const decision = typeof body.decision === "string" ? body.decision.slice(0, 200) : "";
  try {
    const result = body.action === "again"
      ? await tellCreatorAgain(opened.report, opened.store, decision, originFrom(request))
      : await decideAppeal(opened.report, opened.store, decision, body.to, typeof body.reason === "string" ? body.reason.slice(0, MAX_APPEAL_REASON * 2) : undefined, new Date(), originFrom(request));
    if (!result) return Response.json({ ok: false, error: "nothing" }, { status: 404 });
    if (!result.ok) return Response.json({ ok: false, error: result.problem, message: result.words }, { status: result.problem === "busy" ? 409 : 400 });
    return Response.json({ ok: true, state: result.kept.appeal.state, number: result.kept.appeal.number, emailed: result.emailed });
  } catch (error) {
    // An unknown read or write: nothing is said to have moved.
    console.error("a request to look again could not be answered", error);
    return Response.json({ ok: false, error: "error", message: "We could not read or write this request just now, so nothing changed. Try again in a moment." }, { status: 503 });
  }
}
