/**
 * The checks every studio route makes before it does anything.
 *
 * They run in this order on purpose: a request from another site is turned
 * away before we look at the cookie, and the cookie is settled before any
 * network call goes out. Nothing reaches Stripe on behalf of someone who has
 * not proved they hold the session.
 *
 * Then two questions, answered here and nowhere else:
 *
 *   - Which store? A person can own up to five stores and help run others
 *     (lib/team.ts), so "the store for this session" is a choice. A studio
 *     page tells every request it makes which store it was drawn for — the
 *     x-nimbus-store header on a fetch (components/studio-store-pin.tsx),
 *     `?store=` on a form or a link — and that store is the one acted on, so
 *     two tabs open on two stores each keep editing their own. A request
 *     that names no store gets the one chosen last in the switcher (the
 *     nl_store cookie), and without that the person's own first store: for
 *     an account with one store, exactly what it always got.
 *
 *   - May they? Every route names the one permission it needs
 *     (lib/team-roles.ts), and the person's role on that store is read from
 *     the store's own records on every request. A store the request names
 *     that the person cannot open is refused outright, never swapped for
 *     another one, so nothing meant for one store can land in a different
 *     store.
 *
 * What someone on a team changes is written into the store's activity log
 * here too (lib/team.ts), so no route can forget to.
 */
import type { NextRequest } from "next/server";
import { redirect } from "next/navigation";
import { originFrom } from "@/lib/request-origin";
import { fromAnotherSite as crossSite } from "@/lib/request-guard";
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import { LOCKED_MESSAGE } from "@/lib/locked-words";
import { lockedOut, lockedUntil } from "@/lib/two-step";
import { type Store, STORE_ID_PATTERN, accountStores, ensureStoreId, storeForEmail, storeForId, storeRef } from "@/lib/store";
import { type Permission, type Role, PERMISSION_WORDS, can } from "@/lib/team-roles";
import { logTeam, memberStores, roleIn, teamTwoStepBlocks } from "@/lib/team";
import { UnknownReplyError } from "@/lib/redis-reply";
import { withinEssentialLimit } from "@/lib/request-guard";
import { forceAllowance, giveAllowance, takeAllowance } from "@/lib/store-allowance";
import { refreshPeriod } from "@/lib/billing-sync";
import { ESSENTIAL_NEEDS, ESSENTIAL_PER_DAY, STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";

/** The store last chosen in the studio's switcher: only a preference. */
export const STORE_COOKIE = "nl_store";
/** The store a studio page was drawn for, sent with each of its requests. */
export const PIN_HEADER = "x-nimbus-store";

export function away(origin: string, path: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `${origin}${path}` },
  });
}

/**
 * True when the request came from somewhere that is not this site: by its
 * Origin, or, when it has none, by what the browser says in Sec-Fetch-Site
 * (lib/request-guard.ts).
 */
export function fromAnotherSite(request: NextRequest): boolean {
  return crossSite(request);
}

/** One person, on one store, in one role. */
export type Access = {
  /** Who is signed in. */
  email: string;
  store: Store;
  /** The key the store is kept under (lib/store.ts), for its setters. */
  ref: string;
  role: Role;
};

/** The same, with what a route needs to answer. */
export type Creator = Access & {
  origin: string;
  /** "/studio?store=<id>" and the query given, for sending the person back to this store. */
  studio: (query?: string) => string;
};

/**
 * `locked`: a session let in without its second step, for what waits until two-step login turns off (lib/two-step.ts).
 * `used`: the store's studio requests for its window are used (lib/store-allowance-rules.ts).
 */
export type Refusal = "signed_out" | "no_store" | "forbidden" | "gone" | "locked" | "used" | "two_step";

/**
 * What a check asks of a role: one permission, or "member" — any role at all
 * on the store, for what is the person's own business there, such as choosing
 * it in the switcher or leaving its team.
 */
export type Need = Permission | "member";

/**
 * The studio's own address for one store — a page of it when `page` is given
 * ("funnels", "team"…) — with a query.
 */
export function studioPath(store: Pick<Store, "sid">, query = "", page = ""): string {
  const parts = [store.sid ? `store=${store.sid}` : "", query.replace(/^[?&]/, "")].filter(Boolean);
  const base = page ? `/studio/${page}` : "/studio";
  return parts.length ? `${base}?${parts.join("&")}` : base;
}

/**
 * Settles which store a signed-in person is acting on, and in what role.
 *
 * `pinned` is the store the request names; when it names one the person
 * cannot open, the answer is "gone", never another store. `remembered` is the
 * switcher's cookie, only a preference: when it no longer fits, the person's
 * own first store is used, then their first store as one of a team.
 * `session` is the session asking: a team that requires two-step sign-in
 * reads how it was opened (lib/team.ts teamTwoStepBlocks); left out, a member
 * of such a team is held, never let through.
 */
export async function resolveAccess(
  email: string,
  wanted: { pinned?: string | null; remembered?: string | null; session?: string },
  need: Need | null,
): Promise<{ ok: true; access: Access } | { ok: false; reason: Refusal; store?: Store }> {
  const pick = async (sid: string): Promise<Access | null> => {
    const store = await storeForId(sid);
    if (!store) return null;
    const role = await roleIn(store, email);
    return role ? { email, store, ref: storeRef(store), role } : null;
  };

  let access: Access | null = null;
  const pinned = wanted.pinned ?? "";
  if (pinned) {
    if (!STORE_ID_PATTERN.test(pinned)) return { ok: false, reason: "gone" };
    access = await pick(pinned);
    if (!access) return { ok: false, reason: "gone" };
  } else {
    const remembered = wanted.remembered ?? "";
    // Only a preference: a remembered store whose team answers in an unknown shape is "not this one" (rule 24:
    // no role is granted on it), and the person's own store is used, never a studio closed by another store's record.
    if (STORE_ID_PATTERN.test(remembered))
      access = await pick(remembered).catch((error: unknown) => {
        if (error instanceof UnknownReplyError) return null;
        throw error;
      });
    if (!access) {
      const own = await storeForEmail(email);
      if (own) access = { email, store: own, ref: storeRef(own), role: "owner" };
    }
    if (!access) {
      const owned = await accountStores(email);
      if (owned[0]) access = { email, store: owned[0], ref: storeRef(owned[0]), role: "owner" };
    }
    if (!access) {
      const [first] = await memberStores(email);
      if (first) access = { email, store: first.store, ref: storeRef(first.store), role: first.role };
    }
  }
  if (!access) return { ok: false, reason: "no_store" };
  // 612 [WP11]: the owner may require two-step sign-in of the whole team; a
  // member opens nothing of this store unless this session was opened with a
  // second step (the app's code, a recovery code or a passkey), whatever the
  // account owns; the studio page says how to log in again or set one up.
  if (await teamTwoStepBlocks(access.store, email, access.role, wanted.session)) return { ok: false, reason: "two_step", store: access.store };
  if (need && need !== "member" && !can(access.role, need)) return { ok: false, reason: "forbidden", store: access.store };
  return { ok: true, access };
}

/** The store a request names: its header first, then `?store=`. */
export function pinnedStore(request: NextRequest): string | null {
  return request.headers.get(PIN_HEADER) || request.nextUrl.searchParams.get("store") || null;
}

/**
 * The central check, for a route: who, which store, and whether their role
 * has `need`. A write by someone on the team is written into the store's
 * activity log, as is any download of buyers' data.
 */
export async function studioAccess(
  request: NextRequest,
  need: Need,
  action = "",
): Promise<{ ok: true; access: Access } | { ok: false; reason: Refusal; store?: Store; message?: string; why?: "used" | "unknown" | "pool" | "daily" }> {
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  const email = await emailForSession(session);
  if (!email) return { ok: false, reason: "signed_out" };
  // Let in without the second step: what moves money or data out waits (lib/two-step.ts).
  if (lockedOut(need, action) && (await lockedUntil(session)) > 0) return { ok: false, reason: "locked" };
  const result = await resolveAccess(
    email,
    { pinned: pinnedStore(request), remembered: request.cookies.get(STORE_COOKIE)?.value ?? null, session },
    need,
  );
  if (!result.ok) return result;
  const { access } = result;
  // Every request the studio makes for a store is one of its window's
  // (lib/store-allowance-rules.ts). Moving to a larger plan, cancelling,
  // deleting the store, downloading its data and leaving a team are never
  // refused for it: they have a small daily bound of their own instead.
  const counted = await countStudio(access.store, need);
  // Its message already says which: the figure used, no place this month, or no count just now.
  if (!counted.ok) return { ok: false, reason: "used", store: access.store, message: counted.message, why: counted.reason };
  if (counted.store) result.access = { ...result.access, store: counted.store };
  const reading = request.method === "GET" || request.method === "HEAD";
  // The team's own route writes its lines itself, in words of its own.
  // Counting who an email would reach changes nothing, and would fill the log.
  // An import is logged when it starts, finishes uploading or is cancelled,
  // not for each of the batches and steps in between, nor for its dry runs,
  // which change nothing; a funnel import when it is made.
  const selfLogged =
    request.nextUrl.pathname === "/api/store/team" ||
    action === "count" ||
    (request.nextUrl.pathname === "/api/store/import" && (action === "rows" || action === "step" || action === "preview")) ||
    (request.nextUrl.pathname === "/api/store/import/funnel" && (action === "page" || action === "plan"));
  if (access.role !== "owner" && !selfLogged && (!reading || need === "export")) {
    const route = request.nextUrl.pathname.replace(/^\/api\/(store\/)?/, "");
    const detail = action || request.nextUrl.searchParams.get("what") || request.nextUrl.searchParams.get("who") || "";
    await logTeam(access.store.sid, {
      who: access.email,
      role: access.role,
      what: `${need === "member" ? "Team" : PERMISSION_WORDS[need]}: ${route}${detail ? ` (${detail.slice(0, 40)})` : ""}`,
    });
  }
  return result;
}

/**
 * One studio request for a store, taken from its window: `units` of them for
 * a page drawn. What the owner needs to leave or pay is taken from a small
 * daily figure instead, so it is never shut out by the month's.
 */
export async function countStudio(store: Store, need: Need | null, units = 1): Promise<{ ok: true; store?: Store } | { ok: false; reason: "used" | "unknown" | "pool" | "daily"; message: string; left?: number; reset?: string }> {
  if (need && ESSENTIAL_NEEDS.includes(need)) {
    return (await withinEssentialLimit("studio-essential", store.sid || store.handle, ESSENTIAL_PER_DAY, 86_400))
      ? { ok: true }
      : { ok: false, reason: "daily", message: "Too many of these today. Try again tomorrow, or write to support." };
  }
  // A paying store whose billing month is not known has it read from Stripe first (lib/billing-sync.ts).
  const current = await refreshPeriod(store);
  const taken = await takeAllowance(current, "studio", units);
  if (!taken.ok) return { ok: false, reason: taken.reason, message: taken.message, left: taken.left, reset: taken.reset };
  return current === store ? { ok: true } : { ok: true, store: current };
}

/**
 * Takes `units` of the store's studio requests before a reading whose size is known only once it is read, at that
 * reading's worst; `give(n)` then gives back, in the same window (the same moment's), what the reading did not need,
 * and `force(n)` counts what it read beyond them (forceAllowance).
 * The caller gives back only down to the measured size, never below; a measure it cannot trust gives nothing back.
 */
export async function holdStudio(
  store: Store,
  units: number,
): Promise<{ ok: true; give: (n: number) => Promise<void>; force: (n: number) => Promise<void> } | { ok: false; message: string }> {
  const now = Date.now();
  const current = await refreshPeriod(store);
  const taken = await takeAllowance(current, "studio", units, now);
  if (!taken.ok) return { ok: false, message: taken.message };
  return {
    ok: true,
    give: async (n) => {
      if (Number.isSafeInteger(n) && n > 0 && n <= units) await giveAllowance(current, "studio", n, now);
    },
    // What a reading moved beyond what was taken for it, counted past the figure if it must: never refused after it.
    force: async (n) => {
      if (Number.isSafeInteger(n) && n > 0) await forceAllowance(current, "studio", n, now);
    },
  };
}

/** The sentence a refused request is answered with, for a route that answers in JSON. */
export function refusedJson(reason: Refusal, message = ""): Response {
  switch (reason) {
    case "used":
      return Response.json({ ok: false, error: "studio_used", message }, { status: 429 });
    case "signed_out":
      return Response.json({ ok: false, error: "signed_out" }, { status: 401 });
    case "no_store":
      return Response.json({ ok: false, error: "none" }, { status: 400 });
    case "forbidden":
      return Response.json({ ok: false, error: "role" }, { status: 403 });
    case "gone":
      return Response.json({ ok: false, error: "store_gone" }, { status: 409 });
    case "locked":
      return Response.json({ ok: false, error: "locked", message: LOCKED_MESSAGE }, { status: 403 });
    case "two_step":
      return Response.json({ ok: false, error: "two_step_required" }, { status: 403 });
  }
}

/**
 * Resolves the creator behind a request, or the response to send instead:
 * for the routes that are reached by a form or a link and answer by sending
 * the person somewhere.
 */
export async function creatorFrom(
  request: NextRequest,
  need: Need,
  options: { checkOrigin?: boolean; action?: string } = {},
): Promise<Creator | Response> {
  const origin = originFrom(request);

  if (options.checkOrigin !== false && fromAnotherSite(request)) {
    return new Response("forbidden", { status: 403 });
  }

  // `action` names what a locked session may not do under `need` (lib/two-step.ts LOCKED_ACTIONS).
  const result = await studioAccess(request, need, options.action);
  if (!result.ok) {
    if (result.reason === "signed_out") return away(origin, "/signin?status=expired");
    if (result.reason === "no_store") return away(origin, "/studio?stripe=nostore");
    if (result.reason === "gone") return away(origin, "/studio?team=gone");
    if (result.reason === "locked") return away(origin, "/studio?two-step=locked");
    if (result.reason === "two_step") return away(origin, "/studio?two-step=required#two-step");
    if (result.reason === "used") return away(origin, studioPath(result.store ?? { sid: "" }, `why=${result.why ?? "used"}`, "paused"));
    return away(origin, studioPath(result.store ?? { sid: "" }, "team=forbidden"));
  }
  const { access } = result;
  return { ...access, origin, studio: (query = "") => studioPath(access.store, query) };
}

/** The same, for a route that is read by the studio's own code and answers in JSON. */
export async function jsonAccess(request: NextRequest, need: Need): Promise<Access | Response> {
  const result = await studioAccess(request, need);
  return result.ok ? result.access : refusedJson(result.reason, result.message);
}

type CookieJar = { get(name: string): { value: string } | undefined };

/** Everything a studio page needs to know about who is looking at which store. */
export type StudioView = Access & {
  /** Every store this person can open, for the switcher: their own first. */
  stores: { store: Store; role: Role }[];
  /** How many stores this person owns. */
  owned: number;
};

/**
 * The same questions for a studio page: `?store=` first, then the switcher's
 * cookie, then the person's own first store. A page is allowed to fall back
 * where a route is not, because drawing a page changes nothing — but it says
 * so, with `fellBack`, when the store asked for could not be opened.
 */
export async function studioView(
  cookies: CookieJar,
  asked: string | undefined,
  need: Need | null,
  options: { count?: boolean } = {},
): Promise<
  | { ok: true; view: StudioView; fellBack: boolean }
  | { ok: false; reason: Refusal; email: string | null; store?: Store }
> {
  const session = cookies.get(SESSION_COOKIE)?.value;
  const email = await emailForSession(session);
  if (!email) return { ok: false, reason: "signed_out", email: null };

  const pinned = typeof asked === "string" && STORE_ID_PATTERN.test(asked) ? asked : null;
  let result = await resolveAccess(email, { pinned, remembered: cookies.get(STORE_COOKIE)?.value ?? null, session }, need);
  let fellBack = false;
  if (!result.ok && result.reason === "gone") {
    result = await resolveAccess(email, { remembered: cookies.get(STORE_COOKIE)?.value ?? null, session }, need);
    fellBack = true;
  }
  if (!result.ok) return { ok: false, reason: result.reason, email, store: result.store };

  let { access } = result;
  // A store from before there could be several gets its id the first time
  // its owner opens the studio, so everything drawn below can name it.
  if (access.role === "owner" && !access.store.sid) {
    const named = await ensureStoreId(access.ref);
    if (named) access = { ...access, store: named, ref: storeRef(named) };
  }
  // A page drawn is STUDIO_PAGE_UNITS of the store's studio requests. Past
  // them the studio shows one page that says so, with the way to a larger
  // plan (app/studio/paused), and draws nothing else.
  // A page is a page whatever it is about: only the requests that pay,
  // cancel, delete or take the data away are kept off the figure.
  if (options.count !== false) {
    const counted = await countStudio(access.store, null, STUDIO_PAGE_UNITS);
    if (!counted.ok) redirect(studioPath(access.store, `why=${counted.reason}`, "paused"));
    if (counted.store) access = { ...access, store: counted.store };
  }
  const [owned, member] = await Promise.all([accountStores(email), memberStores(email)]);
  const stores = [
    ...owned.map((store) => ({ store: store.sid === access.store.sid ? access.store : store, role: "owner" as Role })),
    ...member.map((m) => ({ store: m.store, role: m.role as Role })),
  ];
  return { ok: true, view: { ...access, stores, owned: owned.length }, fellBack };
}

/**
 * The switcher's cookie, set to one store. Only a preference, so it is kept a
 * year and read by nothing but the studio; http-only all the same, because
 * nothing in a page needs to read it.
 */
export function storeCookie(sid: string, request: { nextUrl: { protocol: string } }): string {
  const secure = request.nextUrl.protocol === "https:" || process.env.NODE_ENV === "production";
  return `${STORE_COOKIE}=${sid}; Path=/; Max-Age=${365 * 24 * 60 * 60}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
