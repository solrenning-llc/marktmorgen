/**
 * The two halves of connecting Google Calendar or Zoom, for their routes
 * (app/api/integrations/<provider>/start and /callback): the same checks for
 * both providers, written once. The rules they follow are in
 * lib/meet-connect.ts; the addresses are fixed in lib/meet-providers.ts.
 *
 * Both answer by sending the person somewhere — the provider's consent page,
 * or back to the studio's Video calls page with a word saying how it went —
 * and neither answers at all (404) while the deployment has not switched the
 * provider on.
 */
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { serviceRefusalCode, withinServiceWhy } from "@/lib/metered-limits";
import { type NextRequest, after } from "next/server";
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import { noticeCreator } from "@/lib/account-notice";
import type { MeetProvider } from "@/lib/call-setup";
import { ACCOUNT_NAMES, beginConsent, finishConsent, takeConsent } from "@/lib/meet-connect";
import { GOOGLE_HOST_SCOPES, ZOOM_REVIEW_QUERY, cameForZoom, hostSyncOn, isConfigured, isZoomReview, offeredProviders } from "@/lib/meet-providers";
import { hostId } from "@/lib/host-claims";
import { clientAddress, withinLimit } from "@/lib/request-guard";
import { originFrom } from "@/lib/request-origin";
import { ensureStatsId } from "@/lib/store";
import { integrationPauseWord } from "@/lib/integration-pause";
import { away, creatorFrom, resolveAccess, studioPath } from "@/lib/studio-route";
import { logTeam } from "@/lib/team";
import { PERMISSION_WORDS } from "@/lib/team-roles";

/** Consents one store may start in ten minutes. */
const STARTS_PER_TEN_MINUTES = 10;
/** Returns from a consent page one address may make in ten minutes. */
const RETURNS_PER_TEN_MINUTES = 30;

const notFound = () => new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });

/**
 * Starts connecting: the owner or an Admin of the store the studio page was
 * drawn for ("settings"), from this site only, a few times in ten minutes.
 */
export async function startConnect(request: NextRequest, provider: MeetProvider): Promise<Response> {
  if (!isConfigured(provider)) return notFound();
  const creator = await creatorFrom(request, "settings");
  if (creator instanceof Response) return creator;
  const { store, ref, email, origin } = creator;
  // The review link's form says so (components/meeting-connections.tsx), and
  // the page it goes back to keeps the word, so the Zoom card stays in sight.
  // A browser that arrived by the listing's link before logging in carries
  // the same word in a cookie (lib/zoom-arrival.ts).
  const review = provider === "zoom" && (isZoomReview(request.nextUrl.searchParams.get("zoom")) || cameForZoom(request.cookies));
  if (!offeredProviders(store, review).includes(provider)) return notFound();
  const kept = review && !offeredProviders(store).includes(provider) ? `&${ZOOM_REVIEW_QUERY}` : "";
  const back = (query: string) => away(origin, studioPath(store, `${query}${kept}`, "meetings"));
  // 232 [CA1] 4b3: no new connection while the plan's costs are paused (lib/integration-pause.ts).
  const paused = integrationPauseWord(store);
  if (paused) return back(`meet=${paused}&p=${provider}`);
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) return back(`meet=funding&p=${provider}`);
  const named = store.statsId ? store : await ensureStatsId(ref);
  if (!named?.statsId || !store.sid) return back(`meet=error&p=${provider}`);
  const refused = await withinServiceWhy("meet-start", named.statsId, STARTS_PER_TEN_MINUTES, 600, named);
  if (refused) return back(`meet=${serviceRefusalCode(refused, "limited")}&p=${provider}`);
  const cookie = request.cookies.get(SESSION_COOKIE)?.value ?? "";
  try {
    const url = await beginConsent(provider, { statsId: named.statsId, sid: store.sid, sessionCookie: cookie, email });
    return new Response(null, { status: 303, headers: { Location: url, "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("starting a meeting connection failed", error);
    return back(`meet=error&p=${provider}`);
  }
}

/**
 * Starts a team host connecting their own Google Calendar for two-way sync
 * (lib/host-calendar.ts): anyone on the store, for themselves only, with the
 * host scopes (GOOGLE_HOST_SCOPES), and only once the deployment has them on
 * its consent screen (hostSyncOn). The consent is bound to their own host id,
 * so the callback can only ever write their own connection.
 */
export async function startHostConnect(request: NextRequest): Promise<Response> {
  if (!hostSyncOn()) return notFound();
  const creator = await creatorFrom(request, "member");
  if (creator instanceof Response) return creator;
  const { store, ref, email, origin } = creator;
  const back = (query: string) => away(origin, studioPath(store, query, "calendar"));
  const paused = integrationPauseWord(store);
  if (paused) return back(`cal=${paused}`);
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) return back("cal=funding");
  const named = store.statsId ? store : await ensureStatsId(ref);
  if (!named?.statsId || !store.sid) return back("cal=error");
  const refused = await withinServiceWhy("meet-start", `${named.statsId}|${email}`, STARTS_PER_TEN_MINUTES, 600, named);
  if (refused) return back(`cal=${serviceRefusalCode(refused, "limited")}`);
  const cookie = request.cookies.get(SESSION_COOKIE)?.value ?? "";
  try {
    const url = await beginConsent("google", { statsId: named.statsId, sid: store.sid, sessionCookie: cookie, email, host: hostId(email), scopes: GOOGLE_HOST_SCOPES });
    return new Response(null, { status: 303, headers: { Location: url, "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("starting a host calendar connection failed", error);
    return back("cal=error");
  }
}

/** The callback's half for a host's own connection: still on that store, and still that very person. */
async function finishHostConnect(
  request: NextRequest,
  origin: string,
  email: string,
  taken: { statsId: string; sid: string; verifier: string; host: string },
): Promise<Response> {
  const allowed = await resolveAccess(email, { pinned: taken.sid, session: request.cookies.get(SESSION_COOKIE)?.value ?? "" }, "member");
  if (!allowed.ok) return away(origin, allowed.store ? studioPath(allowed.store, "team=forbidden") : "/studio?team=gone");
  const { store } = allowed.access;
  const back = (query: string) => away(origin, studioPath(store, query, "calendar"));
  if (store.statsId !== taken.statsId || hostId(email) !== taken.host || !hostSyncOn()) return back("cal=expired");
  const params = request.nextUrl.searchParams;
  const code = params.get("code") ?? "";
  if (params.get("error") || !code) return back("cal=declined");
  if (code.length > 2048 || !/^[A-Za-z0-9._~/+=-]+$/.test(code)) return back("cal=error");
  const paused = integrationPauseWord(store);
  if (paused) return back(`cal=${paused}`);
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) return back("cal=funding");
  try {
    const result = await finishConsent("google", {
      statsId: taken.statsId,
      code,
      verifier: taken.verifier,
      by: email,
      owner: { email: store.email, handle: store.handle },
      host: taken.host,
    });
    if (!result.ok) return back(`cal=${result.error}`);
    return back("cal=connected");
  } catch (error) {
    console.error("finishing a host calendar connection failed", error);
    return back("cal=error");
  }
}

/**
 * Where the provider sends the person back. Reached by a top-level
 * navigation from the provider's page, so it is not a same-site request; the
 * state is what proves it belongs to a consent started here, by this
 * session, for this store.
 */
export async function finishConnect(request: NextRequest, provider: MeetProvider): Promise<Response> {
  if (!isConfigured(provider)) return notFound();
  const origin = originFrom(request);
  if (!(await withinLimit("meet-return", clientAddress(request), RETURNS_PER_TEN_MINUTES, 600))) {
    return away(origin, "/studio?meet=limited");
  }
  const cookie = request.cookies.get(SESSION_COOKIE)?.value ?? "";
  const email = await emailForSession(cookie);
  if (!email) return away(origin, "/signin?status=expired");

  const params = request.nextUrl.searchParams;
  const taken = await takeConsent(provider, params.get("state") ?? "", { sessionCookie: cookie, email });
  if (!taken) return away(origin, `/studio?meet=expired&p=${provider}`);
  // A team host connecting their own calendar: a page of its own, and checks of its own.
  if (taken.host) return finishHostConnect(request, origin, email, taken);
  // Still allowed on that very store, read now: a role taken away while the
  // person was on the provider's page counts.
  const allowed = await resolveAccess(email, { pinned: taken.sid, session: cookie }, "settings");
  if (!allowed.ok) return away(origin, allowed.store ? studioPath(allowed.store, "team=forbidden") : "/studio?team=gone");
  const { store, role } = allowed.access;
  // A consent for a provider the store is not openly offered was started
  // from the review link (startConnect lets nothing else through): the page
  // it comes back to keeps the word, so the card is there to try again from,
  // and stays after a disconnect.
  const kept = offeredProviders(store).includes(provider) ? "" : `&${ZOOM_REVIEW_QUERY}`;
  const back = (query: string) => away(origin, studioPath(store, `${query}${kept}`, "meetings"));
  if (store.statsId !== taken.statsId) return back(`meet=expired&p=${provider}`);

  const code = params.get("code") ?? "";
  // "access_denied": they pressed Cancel on the provider's page.
  if (params.get("error") || !code) return back(`meet=declined&p=${provider}`);
  if (code.length > 2048 || !/^[A-Za-z0-9._~/+=-]+$/.test(code)) return back(`meet=error&p=${provider}`);
  // Paused while the person was on the provider's page: the code is not exchanged.
  const paused = integrationPauseWord(store);
  if (paused) return back(`meet=${paused}&p=${provider}`);
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) return back(`meet=funding&p=${provider}`);

  try {
    const result = await finishConsent(provider, {
      statsId: taken.statsId,
      code,
      verifier: taken.verifier,
      by: email,
      owner: { email: store.email, handle: store.handle },
    });
    if (!result.ok) return back(`meet=${result.error}&p=${provider}`);
    // Buyers' names and addresses go into it from now on: the owner is told
    // at their sign-in address (lib/account-notice.ts), whoever connected it.
    after(() => noticeCreator(store, { kind: "meeting-connected", name: ACCOUNT_NAMES[provider], account: result.view.account }));
    if (role !== "owner") {
      await logTeam(store.sid, { who: email, role, what: `${PERMISSION_WORDS.settings}: connected ${ACCOUNT_NAMES[provider]}` });
    }
    return back(`meet=connected&p=${provider}`);
  } catch (error) {
    console.error("finishing a meeting connection failed", error);
    return back(`meet=error&p=${provider}`);
  }
}
