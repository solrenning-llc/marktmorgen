/**
 * A member pausing instead of cancelling (lib/membership-pause.ts, added 11
 * October 2026). What is checked:
 *
 *   - which memberships can be paused: monthly, running normally, once a
 *     year, and only as long as the creator allows;
 *   - the pause starts when the period paid for ends and lasts the calendar
 *     months chosen; the doors close inside it and only inside it;
 *   - Stripe is told to skip the payments and resume on the day it ends, and
 *     the member is emailed the dates in the store's language;
 *   - resuming before it starts only takes it off; resuming during it takes a
 *     payment that day, and a declined card leaves it paused;
 *   - the link has to be the member's own.
 */
import { addMonths, cannotPause, pausedNow, pauseOf, parsePauseMonths, type PauseSub } from "@/lib/membership-pause-rules";
import { isLiveSub, memberState } from "@/lib/membership-access";
import { pauseMembership, resumeMembership } from "@/lib/membership-pause";
import { membershipsFor, requestManageLink } from "@/lib/membership-manage";
import { claimHandle, ensureStatsId, setLanguage, setPauseMonths, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400;
const NOW = Math.floor(Date.UTC(2026, 9, 11, 12) / 1000);
const PERIOD_END = Math.floor(Date.UTC(2026, 9, 31, 9) / 1000);

const monthly = (over: Record<string, unknown> = {}): PauseSub =>
  ({
  id: "sub_Member0000001",
  status: "active",
  customer: "cus_Member000001",
  metadata: { store: "club", product: "prod000001" },
  items: { data: [{ current_period_end: PERIOD_END, price: { unit_amount: 900, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
  ...over,
  }) as unknown as PauseSub;

part("Which memberships can be paused");
is("monthly and running normally, while the creator allows it", cannotPause(monthly(), 2, NOW), null);
is("not when the creator has not switched it on", cannotPause(monthly(), 0, NOW), "off");
is("not yearly, weekly or every other month", [
  cannotPause(monthly({ items: { data: [{ current_period_end: PERIOD_END, price: { recurring: { interval: "year", interval_count: 1 } } }] } }), 2, NOW),
  cannotPause(monthly({ items: { data: [{ current_period_end: PERIOD_END, price: { recurring: { interval: "month", interval_count: 2 } } }] } }), 2, NOW),
], ["interval", "interval"]);
is("not in a free trial, behind on a payment, set to end, sold to end, or paused already", [
  cannotPause(monthly({ status: "trialing" }), 2, NOW),
  cannotPause(monthly({ status: "past_due" }), 2, NOW),
  cannotPause(monthly({ cancel_at_period_end: true }), 2, NOW),
  cannotPause(monthly({ metadata: { store: "club", ends_after: "6" } }), 2, NOW),
  cannotPause(monthly({ pause_collection: { behavior: "void", resumes_at: PERIOD_END + 30 * DAY } }), 2, NOW),
], ["state", "state", "ending", "fixed", "paused"]);
is("once a year", [cannotPause(monthly({ metadata: { store: "club", paused_at: String(NOW - 100 * DAY) } }), 2, NOW), cannotPause(monthly({ metadata: { store: "club", paused_at: String(NOW - 366 * DAY) } }), 2, NOW)], ["recent", null]);
is("the setting reads only 0 to 3", [parsePauseMonths(2), parsePauseMonths(6), parsePauseMonths("2")], [2, 0, 0]);

part("When it starts and ends, and the doors inside it");
is("calendar months, a day past the month's end going to its last day", [
  new Date(addMonths(Math.floor(Date.UTC(2026, 0, 31, 9) / 1000), 1) * 1000).toISOString(),
  new Date(addMonths(Math.floor(Date.UTC(2026, 9, 31, 9) / 1000), 2) * 1000).toISOString(),
], ["2026-02-28T09:00:00.000Z", "2026-12-31T09:00:00.000Z"]);
const paused = monthly({ pause_collection: { behavior: "void", resumes_at: addMonths(PERIOD_END, 1) }, metadata: { store: "club", pause_from: String(PERIOD_END) } });
// The doors read the clock, so these are set around today rather than a fixed date.
const real = Math.floor(Date.now() / 1000);
const ahead = monthly({ pause_collection: { behavior: "void", resumes_at: real + 40 * DAY }, metadata: { store: "club", pause_from: String(real + 10 * DAY) } });
const inside = monthly({ pause_collection: { behavior: "void", resumes_at: real + 20 * DAY }, metadata: { store: "club", pause_from: String(real - DAY) } });
is("before it starts, still what they paid for; inside it, paused; after it, theirs again", [
  memberState(ahead),
  memberState(inside),
  pausedNow(paused, PERIOD_END - 1),
  pausedNow(paused, PERIOD_END + DAY),
  pausedNow(paused, addMonths(PERIOD_END, 1)),
], ["active", "paused", false, true, false]);
is("every door goes by it", [isLiveSub(inside), isLiveSub(ahead), isLiveSub(monthly())], [false, true, true]);
is("a pause with no start written down is not one", pauseOf(monthly({ pause_collection: { behavior: "void", resumes_at: PERIOD_END } })), null);

// ---- On Stripe ---------------------------------------------------------------
let sub: Record<string, unknown> = monthly();
const posts: URLSearchParams[] = [];
const emails: { to: string; subject: string; text: string }[] = [];
let decline = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    emails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return json({ id: `email_${emails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  // A list as Stripe gives it, with has_more (rule 23: fixture only; findMember reads lists exactly since sweep APP2).
  if (path === "/customers" && method === "GET") return json({ data: [{ id: "cus_Member000001" }], has_more: false });
  if (path === "/customers/cus_Member000001") return json({ id: "cus_Member000001", email: "member@example.com" });
  if (path === "/subscriptions" && method === "GET") return json({ data: [sub], has_more: false });
  if (path === "/subscriptions/sub_Member0000001" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    posts.push(body);
    if (decline && body.get("billing_cycle_anchor") === "now") return json({ error: { code: "card_declined", message: "Your card was declined." } }, 402);
    const metadata = { ...(sub.metadata as Record<string, string>) };
    for (const [key, value] of body) {
      const m = key.match(/^metadata\[(.+)\]$/);
      if (m) metadata[m[1]] = value;
    }
    sub = {
      ...sub,
      metadata,
      pause_collection: body.has("pause_collection") ? null : body.get("pause_collection[resumes_at]") ? { behavior: "void", resumes_at: Number(body.get("pause_collection[resumes_at]")) } : sub.pause_collection,
    };
    return json(sub);
  }
  return json({ data: [] });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_pause_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_pause_only_a_stand_in";
  const OWNER = "club@example.com";
  await claimHandle(OWNER, "club", "Supper Club", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestClub000001", true);
  await setLanguage(OWNER, "es");
  is("the creator chooses up to 3 months, and nothing else", [(await setPauseMonths(OWNER, 2)).ok, (await setPauseMonths(OWNER, 5)).ok], [true, false]);
  let store = (await storeForEmail(OWNER))!;

  part("Through the member's own link");
  await requestManageLink({ store, email: "member@example.com", ip: "203.0.113.9", origin: "https://marktmorgen.com" });
  const token = emails.at(-1)?.text.match(/token=([0-9a-f]{64})/)?.[1] ?? "";
  const listed = await membershipsFor(store, token);
  is("the page offers the pause, from the end of what was paid for", [listed?.[0]?.canPause, listed?.[0]?.periodEnd], [true, PERIOD_END]);
  is("not for longer than the creator allows", (await pauseMembership(store, token, "sub_Member0000001", 3, NOW)).ok, false);
  is("not with somebody else's link", (await pauseMembership(store, "f".repeat(64), "sub_Member0000001", 1, NOW)).ok ? "paused" : "refused", "refused");

  part("Paused");
  const result = await pauseMembership(store, token, "sub_Member0000001", 2, NOW);
  const sent = posts.at(-1)!;
  is("Stripe skips the payments and resumes on the day it ends; the start and the day it was asked are written on it", [
    result.ok,
    sent.get("pause_collection[behavior]"),
    sent.get("pause_collection[resumes_at]"),
    sent.get("metadata[pause_from]"),
    sent.get("metadata[paused_at]"),
  ], [true, "void", String(addMonths(PERIOD_END, 2)), String(PERIOD_END), String(NOW)]);
  const note = emails.at(-1)!;
  is("the member is told the dates, in the store's language", [note.to, note.subject.includes("está en pausa"), note.text.includes("31 de octubre de 2026"), note.text.includes("31 de diciembre de 2026"), note.text.includes("/@club/manage")], ["member@example.com", true, true, true, true]);
  is("and the page shows it, with no second pause on offer", [(await membershipsFor(store, token))?.[0]?.pause?.from, (await membershipsFor(store, token))?.[0]?.canPause], [PERIOD_END, false]);

  part("Resumed");
  is("before it starts, resuming only takes it off: no payment", [(await resumeMembership(store, token, "sub_Member0000001", NOW)).ok, posts.at(-1)!.get("pause_collection"), posts.at(-1)!.has("billing_cycle_anchor")], [true, "", false]);
  await pauseMembership(store, token, "sub_Member0000001", 1, NOW).catch(() => null);
  is("and the once-a-year rule then holds", (await pauseMembership(store, token, "sub_Member0000001", 1, NOW)).ok, false);
  sub = { ...sub, pause_collection: { behavior: "void", resumes_at: addMonths(PERIOD_END, 1) }, metadata: { store: "club", product: "prod000001", pause_from: String(PERIOD_END), paused_at: String(NOW) } };
  decline = true;
  is("during it, resuming takes a payment that day; a declined card leaves it paused", [(await resumeMembership(store, token, "sub_Member0000001", PERIOD_END + DAY)).ok ? "resumed" : "declined", posts.at(-1)!.get("payment_behavior")], ["declined", "error_if_incomplete"]);
  decline = false;
  const back = await resumeMembership(store, token, "sub_Member0000001", PERIOD_END + DAY);
  is("and with a good card it starts a new period from that day", [back.ok, posts.at(-1)!.get("billing_cycle_anchor"), posts.at(-1)!.get("proration_behavior")], [true, "now", "none"]);
  store = (await storeForEmail(OWNER))!;
  is("switched off, nothing can be paused", [(await setPauseMonths(OWNER, 0)).ok, (await pauseMembership((await storeForEmail(OWNER))!, token, "sub_Member0000001", 1, NOW)).ok], [true, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
