/**
 * Connecting and disconnecting a store's Meta ad account, for the routes in
 * app/api/integrations/meta (lib/meta-ads.ts says what is kept and why).
 * Each answers by sending the person back to the numbers with a word saying
 * how it went, and none answers at all (404) while the deployment has no
 * Meta app.
 */
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { serviceRefusalCode, withinServiceWhy } from "@/lib/metered-limits";
import { type NextRequest, after } from "next/server";
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import { noticeCreator } from "@/lib/account-notice";
import { MetaError, beginMeta, disconnectMeta, finishMeta, isMetaConfigured, readMetaSpend, takeMeta } from "@/lib/meta-ads";
import { clientAddress, withinLimit } from "@/lib/request-guard";
import { originFrom } from "@/lib/request-origin";
import { ensureStatsId, type Store } from "@/lib/store";
import { integrationPauseWord } from "@/lib/integration-pause";
import { away, creatorFrom, resolveAccess, studioPath } from "@/lib/studio-route";
import { logTeam } from "@/lib/team";
import { PERMISSION_WORDS } from "@/lib/team-roles";

const notFound = () => new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
const back = (origin: string, store: Pick<Store, "sid">, word: string) => away(origin, `${studioPath(store, `metaads=${word}`)}#numbers`);
const CALLBACK = "/api/integrations/meta/callback";

/** Starts connecting: the owner or an Admin, from this site only, a few times in ten minutes. */
export async function startMeta(request: NextRequest): Promise<Response> {
  if (!isMetaConfigured()) return notFound();
  const creator = await creatorFrom(request, "settings");
  if (creator instanceof Response) return creator;
  const { store, ref, email, origin } = creator;
  // 232 [CA1] 4b3: no new connection while the plan's costs are paused (lib/integration-pause.ts).
  const paused = integrationPauseWord(store);
  if (paused) return back(origin, store, paused);
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) return back(origin, store, "funding");
  const named = store.statsId ? store : await ensureStatsId(ref);
  if (!named?.statsId || !store.sid) return back(origin, store, "error");
  const refused = await withinServiceWhy("metaads-start", named.statsId, 10, 600, named);
  if (refused) return back(origin, store, serviceRefusalCode(refused, "limited"));
  try {
    const url = await beginMeta({ statsId: named.statsId, sid: store.sid, sessionCookie: request.cookies.get(SESSION_COOKIE)?.value ?? "", email, redirect: `${origin}${CALLBACK}` });
    return new Response(null, { status: 303, headers: { Location: url, "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("starting the Meta connection failed", error);
    return back(origin, store, "error");
  }
}

/**
 * Where Meta sends the person back. A top-level navigation from Meta's page,
 * so not a same-site request: the state is what proves it was started here,
 * by this session, for this store.
 */
export async function finishMetaConnect(request: NextRequest): Promise<Response> {
  if (!isMetaConfigured()) return notFound();
  const origin = originFrom(request);
  if (!(await withinLimit("metaads-return", clientAddress(request), 30, 600))) return away(origin, "/studio?metaads=limited");
  const cookie = request.cookies.get(SESSION_COOKIE)?.value ?? "";
  const email = await emailForSession(cookie);
  if (!email) return away(origin, "/signin?status=expired");
  const params = request.nextUrl.searchParams;
  const taken = await takeMeta(params.get("state") ?? "", { sessionCookie: cookie, email });
  if (!taken) return away(origin, "/studio?metaads=expired#numbers");
  // Still allowed on that very store, read now.
  const allowed = await resolveAccess(email, { pinned: taken.sid }, "settings");
  if (!allowed.ok) return away(origin, allowed.store ? studioPath(allowed.store, "team=forbidden") : "/studio?team=gone");
  const { store, role } = allowed.access;
  if (store.statsId !== taken.statsId) return back(origin, store, "expired");
  const code = params.get("code") ?? "";
  // They pressed Cancel on Meta's page.
  if (params.get("error") || !code) return back(origin, store, "declined");
  if (code.length > 2048 || !/^[A-Za-z0-9._~/+=#-]+$/.test(code)) return back(origin, store, "error");
  const paused = integrationPauseWord(store);
  if (paused) return back(origin, store, paused);
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) return back(origin, store, "funding");
  try {
    const result = await finishMeta({
      statsId: taken.statsId,
      sid: taken.sid,
      code,
      redirect: taken.redirect,
      by: email,
      owner: { email: store.email, handle: store.handle },
      currency: store.currency,
    });
    if (!result.ok) return back(origin, store, result.error);
    // The first read at once, so the numbers show it on the way back; the daily job reads it from then on.
    if (result.account) await readMetaSpend(taken.statsId, store.currency).catch(() => "error");
    after(() => noticeCreator(store, { kind: "metaads-connected", account: result.account?.name ?? "" }));
    if (role !== "owner") await logTeam(store.sid, { who: email, role, what: `${PERMISSION_WORDS.settings}: connected Meta ads` });
    return back(origin, store, result.account ? "connected" : "choose");
  } catch (error) {
    console.error("finishing the Meta connection failed", error);
    return back(origin, store, error instanceof MetaError && error.kind === "busy" ? "busy" : "error");
  }
}

/** Disconnects: the owner or an Admin, from this site only. */
export async function stopMeta(request: NextRequest): Promise<Response> {
  if (!isMetaConfigured()) return notFound();
  const creator = await creatorFrom(request, "settings");
  if (creator instanceof Response) return creator;
  const { store, email, role, origin } = creator;
  if (!store.statsId) return back(origin, store, "disconnected");
  try {
    const gone = await disconnectMeta(store.statsId);
    if (gone !== false) {
      after(() => noticeCreator(store, { kind: "metaads-disconnected" }));
      if (role !== "owner") await logTeam(store.sid, { who: email, role, what: `${PERMISSION_WORDS.settings}: disconnected Meta ads` });
    }
    return back(origin, store, "disconnected");
  } catch (error) {
    console.error("disconnecting Meta ads failed", error);
    return back(origin, store, "error");
  }
}
