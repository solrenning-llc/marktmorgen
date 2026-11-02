/**
 * "Something's not working": the studio's checkup, read on the server
 * (491 [PP2], unit 2; added 1 November 2026). Each part is read by a reader
 * already in the code, strictly, and worked out by lib/checkup-rules.ts:
 *
 *   payments   readAccount (lib/stripe-connect.ts), a GET at Stripe
 *   domain     domainCheckup (lib/domains.ts), two GETs at Vercel
 *   email      pauseForSending (lib/mail-health.ts), one Redis read
 *   checkout   readTroubleStrict (lib/checkout-trouble.ts), one Redis read
 *   limits     allowancesUsedStrict (lib/store-allowance.ts), one Redis read for every figure (unit 3)
 *   disputes   readDisputes, at most DISPUTE_PAGES GETs at Stripe on the creator's account (unit 4)
 *
 * Each has a ceiling of CHECK_WAIT_MS: a reader that has not answered by
 * then, or that failed, is "not checked", never fine. The readers run side
 * by side, so the page waits at most that long. Nothing is written, sent or
 * charged and no model is asked: each request is a read at no cost per call
 * (Stripe's account, Vercel's domain, the store's own Redis keys), made
 * only when the creator opens the page, inside the studio's page allowance.
 *
 * What the plan already decides is said without asking anyone: a domain
 * rests and email to the list stops off Pro, and email stops while a
 * renewal is unpaid or a plan payment disputed (lib/plan.ts, canUse). A fix
 * on a studio card the person's role cannot open is said as a step for the
 * owner instead of a link that would lead nowhere.
 */
import type { Store } from "@/lib/store";
import { canUse, hasPro } from "@/lib/plan";
import { planDisputed } from "@/lib/plan-dispute-rules";
import type { Permission } from "@/lib/team-roles";
import { readAccount } from "@/lib/stripe-connect";
import { domainCheckup } from "@/lib/domains";
import { healthId, pauseForSending } from "@/lib/mail-health";
import { readTroubleStrict } from "@/lib/checkout-trouble";
import { type Check, type OpenDispute, checkoutCheck, disputesCheck, domainCheck, emailCheck, emailStopped, limitsCheck, orderChecks, stripeCheck } from "@/lib/checkup-rules";
import { onAccount } from "@/lib/stripe-account";
import { type AllowanceStore, allowancesUsedStrict } from "@/lib/store-allowance";
import { ALLOWANCE_KINDS } from "@/lib/store-allowance-rules";
import { resetWords } from "@/lib/allowance-window";
import { standingOf } from "@/lib/plan-standing";

/** The moment a checkup is read, said on the page with it. */
export function checkupClock(): number {
  return Date.now();
}

/** How far back disputes are read, and in at most how many pages of a hundred. */
export const DISPUTE_DAYS = 180;
export const DISPUTE_PAGES = 3;

/**
 * The disputes opened on the creator's Stripe account in the last
 * DISPUTE_DAYS (GET /v1/disputes, read only, newest first), at most
 * DISPUTE_PAGES pages, within `ms` in all: each page gets what is left, and
 * a page that runs out of time or fails after the first ends the read with
 * what was read, `complete` false. Throws when the first page fails or any
 * answer is not in Stripe's shape, so the caller says "not checked".
 *
 * Known limit: an appeal reopened on a dispute older than DISPUTE_DAYS is
 * not read here; the Dashboard lists it.
 */
export async function readDisputes(account: string, now = Date.now(), ms = CHECK_WAIT_MS): Promise<{ disputes: OpenDispute[]; complete: boolean }> {
  const since = Math.floor(now / 1000) - DISPUTE_DAYS * 86_400;
  const deadline = Date.now() + Math.max(50, ms - 200);
  const disputes: OpenDispute[] = [];
  const seen = new Set<string>();
  let after = "";
  for (let page = 0; page < DISPUTE_PAGES; page += 1) {
    const left = deadline - Date.now();
    if (left < 50) return { disputes, complete: false };
    let list: { data?: unknown; has_more?: unknown };
    try {
      list = (await onAccount("GET", account, `/disputes?limit=100&created[gte]=${since}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`, undefined, undefined, undefined, Math.min(left, CHECK_WAIT_MS))) as typeof list;
    } catch (error) {
      if (page === 0) throw error;
      return { disputes, complete: false };
    }
    if (!Array.isArray(list.data) || typeof list.has_more !== "boolean") throw new Error("Stripe answered disputes in an unknown shape");
    for (const raw of list.data as unknown[]) {
      if (!raw || typeof raw !== "object") throw new Error("Stripe answered a dispute in an unknown shape");
      const row = raw as Record<string, unknown>;
      if (typeof row.id !== "string" || !row.id || seen.has(row.id) || typeof row.status !== "string") throw new Error("Stripe answered a dispute in an unknown shape");
      seen.add(row.id);
      const evidence = (row.evidence_details ?? {}) as { due_by?: unknown; past_due?: unknown };
      disputes.push({ status: row.status, dueBy: typeof evidence.due_by === "number" ? evidence.due_by : null, pastDue: evidence.past_due === true });
      after = row.id;
    }
    if (!list.has_more) return { disputes, complete: true };
    if (!list.data.length) throw new Error("Stripe said there was more with nothing on the page");
  }
  return { disputes, complete: false };
}

/** The longest any one reader is waited for. */
export const CHECK_WAIT_MS = 8_000;

/** A reader's answer, or `fallback` when it failed or took longer than `ms`. */
export async function within<T, F>(read: () => Promise<T>, fallback: F, ms = CHECK_WAIT_MS): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([read().catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

type CheckedStore = Pick<Store, "sid" | "listId" | "statsId" | "stripeAccountId" | "domain" | "subscriptionActive" | "tier" | "renewalUnpaidSince" | "planDisputes"> & AllowanceStore;

/** The studio card each fix leads to, and the permission that draws it (app/studio/page.tsx). */
const CARD_NEEDS: [string, Permission][] = [
  ["/studio#stripe", "payments"],
  ["/studio#billing", "billing"],
  ["/studio#domain", "settings"],
  ["/studio/email", "draft"],
];

/** A fix the person's role cannot open becomes a step for the owner. */
export function forRole(check: Check, can: (permission: Permission) => boolean): Check {
  const fix = check.fix;
  if (fix?.kind !== "studio") return check;
  const need = CARD_NEEDS.find(([href]) => fix.href === href)?.[1];
  if (!need || can(need)) return check;
  return { ...check, fix: { kind: "outside", where: `This is fixed in a part of the studio your role cannot open ("${fix.label}"). Ask the store's owner.` } };
}

/** Where billing is not set up here, the plan card (and its #billing anchor) is not drawn: the way to a plan is said, not linked. */
export function forBilling(check: Check, billingReady: boolean): Check {
  if (billingReady || check.fix?.kind !== "studio" || check.fix.href !== "/studio#billing") return check;
  return { ...check, fix: { kind: "outside", where: "Plans cannot be started or changed on this site just now." } };
}

export async function runCheckup(store: CheckedStore, can: (permission: Permission) => boolean, now = Date.now(), ms = CHECK_WAIT_MS, billingReady = true): Promise<Check[]> {
  const account = store.stripeAccountId;
  const domain = store.domain?.name ?? null;
  const resting = domain !== null && !canUse(store, "domain");
  const stopped = emailStopped({ pro: store.subscriptionActive && hasPro(store.tier), renewalUnpaid: (store.renewalUnpaidSince ?? 0) > 0, disputed: store.subscriptionActive && planDisputed(store, now / 1000) });
  const [stripe, site, pause, trouble, limits, disputes] = await Promise.all([
    account ? within(() => readAccount(account), null, ms) : Promise.resolve(null),
    domain && !resting ? within(() => domainCheckup(domain, store), null, ms) : Promise.resolve(null),
    stopped === null ? within(() => pauseForSending(healthId(store), now), undefined, ms) : Promise.resolve(undefined),
    // With no Stripe account no checkout can open at all; the payments line says so.
    account ? within(() => readTroubleStrict(store.statsId, now), null, ms) : Promise.resolve(null),
    within(() => allowancesUsedStrict(store, ALLOWANCE_KINDS, now), null, ms),
    account ? within(() => readDisputes(account, now, ms), null, ms) : Promise.resolve(null),
  ]);
  const checks = orderChecks([
    stripeCheck(Boolean(account), stripe),
    domainCheck(domain, resting ? "resting" : site),
    stopped === "left-out" ? null : stopped ?? emailCheck(pause, now),
    account ? checkoutCheck(trouble) : null,
    limitsCheck(limits, resetWords(store, now), standingOf(store, now / 1000) === "paid"),
    // With no Stripe account there is nothing a dispute could be opened on; the payments line says so.
    account ? disputesCheck(disputes, now) : null,
  ]);
  return checks.map((check) => forRole(forBilling(check, billingReady), can));
}
