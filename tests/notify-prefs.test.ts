/**
 * Which studio alert emails a creator gets, event by event (queue item 601
 * [KB22], unit U6; lib/notify-prefs-rules.ts, alertEmailsOff in lib/store.ts).
 * Checked:
 *
 *   - the catalog: every kind lib/store-alerts.ts can say, and the quiet-sales
 *     email, is a choice; the always-on notices each carry their reason, cannot
 *     be saved as off, and their code never reads the choice; defaults are
 *     today's behavior (all on), also for a store saved before the choice;
 *   - the choice is kept in the store record the alert jobs already hold, so a
 *     job never decides on a second reading that could come back unknown;
 *   - an optional alert switched off is not emailed, while its chat post goes
 *     as before; switched on again, it is emailed, with where to choose;
 *   - the quiet-sales email switched off costs no Stripe reading and uses
 *     nothing up;
 *   - the route saves only for the signed-in owner (the emails are the
 *     owner's, and some are how an owner would notice a teammate), refuses an
 *     always-on or unknown event with its own error and changes nothing then,
 *     and can undo the weekly email's stop link, which stops all of these;
 *   - the studio page names what is always on and why, says when the stop
 *     link or a store not taking payments makes the choices do nothing yet,
 *     and never disables the focused button.
 *
 * Rule 23: this replaces the red test of 2b5cd9642, written for a separate
 * Redis key (nl:notify:off:) read at send time. Review found that design
 * could only fail an unknown reading by delaying every channel to the next
 * day or losing the email; the choice moved into the store record, and the
 * assertions on that key's exact reads (unknown shapes, release of the day's
 * look, unconfirmed write) went with it.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { ALWAYS_ON_ROWS, OPTIONAL_EVENTS, OPTIONAL_ROWS, keptOff, notifyPrefsPath, parseOff, wantsAlertEmail } from "@/lib/notify-prefs-rules";
import { checkAlerts } from "@/lib/store-alerts";
import { checkQuiet } from "@/lib/quiet-sales";
import { setChatAddress } from "@/lib/chat-summary";
import { setSalesGoal } from "@/lib/sales-goal";
import { claimHandle, ensureStatsId, ensureStoreId, setAlertEmailsOff, setChatSales, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { setWeeklyOff, weeklyOff } from "@/lib/stats-report";
import { POST as prefsRoute } from "@/app/api/store/notify-prefs/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_notify_prefs_stand_in";
process.env.RESEND_API_KEY = "re_test_store_alerts_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "notify-owner@example.com";
const SLACK = "https://hooks.slack.com/services/T000/B000/abcdefghijklmnop";
const DAY = 86_400_000;
const posted: string[] = [];
const emails: { to: string; subject: string; text: string }[] = [];
let sessions: Record<string, unknown>[] = [];
let stripeCalls = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.hostname === "hooks.slack.com") {
    posted.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return new Response("ok", { status: 200 });
  }
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    emails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return json({ id: `email_${emails.length}` });
  }
  if (url.hostname === "api.stripe.com") stripeCalls += 1;
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return json({ object: "list", data: sessions, has_more: false });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const paid = (id: string, daysAgo: number, cents: number, now: number) => ({
  id,
  status: "complete",
  payment_status: "paid",
  amount_total: cents,
  currency: "usd",
  created: Math.floor((now - daysAgo * DAY) / 1000),
  customer_details: { email: "buyer@example.com", name: "Pat Buyer" },
  metadata: { store: "notifyharbor", product: "nope", title: "Weeknight Club" },
});

async function main(): Promise<void> {
  redis.clear();

  part("The catalog: every alert the code can say is a choice, the rest always on with a reason");
  is("the six optional events, in the studio's order", [...OPTIONAL_EVENTS], ["traffic", "conversion", "refunds", "goal-pace", "goal-reached", "quiet-sales"]);
  is("each optional row is one event, with words", OPTIONAL_ROWS.map((r) => r.id), [...OPTIONAL_EVENTS]);
  is("each optional row says what it is", OPTIONAL_ROWS.every((r) => r.title.length > 3 && r.text.length > 20), true);
  const alertsSource = readFileSync("lib/store-alerts.ts", "utf8");
  const kinds = /export type AlertKind = ([^;]+);/.exec(alertsSource)?.[1].match(/"([a-z-]+)"/g)?.map((k) => k.slice(1, -1)) ?? [];
  is("every kind lib/store-alerts.ts says is a choice", kinds.length > 0 && kinds.every((k) => (OPTIONAL_EVENTS as readonly string[]).includes(k)), true);
  is("always-on rows: account, payments, plan and store, legal notices", ALWAYS_ON_ROWS.map((r) => r.id), ["account", "payments", "plan", "legal"]);
  is("each always-on row carries its reason", ALWAYS_ON_ROWS.every((r) => r.reason.length > 30), true);
  is("each names the code that sends it, and that code exists", ALWAYS_ON_ROWS.every((r) => r.sources.length > 0 && r.sources.every((s) => readFileSync(s, "utf8").length > 0)), true);
  is("no event is both", ALWAYS_ON_ROWS.some((r) => (OPTIONAL_EVENTS as readonly string[]).includes(r.id)), false);
  for (const row of ALWAYS_ON_ROWS) {
    for (const source of row.sources) is(`${source} never reads the choice`, /notify-prefs|alertEmailsOff|wantsAlertEmail/.test(readFileSync(source, "utf8")), false);
  }
  is("the studio page", notifyPrefsPath("s_abc"), "/studio/notifications?store=s_abc");
  is("without a store id", notifyPrefsPath(null), "/studio/notifications");

  part("The list switched off: strict when saved, kept as saved when read back");
  is("a list of known events, in the catalog's order", parseOff(["quiet-sales", "traffic"]), ["traffic", "quiet-sales"]);
  is("empty is a choice: all on", parseOff([]), []);
  is("an always-on event is not saved", parseOff(["account"]), null);
  is("an unknown event is not saved", parseOff(["traffic", "news"]), null);
  is("a repeat is not saved", parseOff(["traffic", "traffic"]), null);
  is("not a list is not saved", parseOff({ traffic: true }), null);
  is("a number in it is not saved", parseOff(["traffic", 1]), null);
  is("too many is not saved", parseOff([...OPTIONAL_EVENTS, ...OPTIONAL_EVENTS]), null);
  is("read back: an event retired since is dropped, the rest of the choice kept", keptOff(["refunds", "retired-kind", "traffic"]), ["traffic", "refunds"]);
  is("read back: a store saved before the choice existed has every alert on", keptOff(undefined), []);
  is("wanted unless switched off", [wantsAlertEmail(["refunds"], "refunds"), wantsAlertEmail(["refunds"], "traffic"), wantsAlertEmail(undefined, "traffic")], [false, true, true]);

  part("Kept in the store record, all on until changed");
  await claimHandle(OWNER, "notifyharbor", "Notify Harbor", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestNotify0001", true);
  await setSubscription(OWNER, { customerId: "cus_Notify00001", subscriptionId: "sub_Notify00001", active: true, period: paidPeriod() });
  is("a new store has every alert on", (await storeForEmail(OWNER))!.alertEmailsOff, []);
  const saved = await setAlertEmailsOff(OWNER, ["quiet-sales", "traffic"]);
  is("saved, in the catalog's order", saved.ok ? saved.store.alertEmailsOff : saved.reason, ["traffic", "quiet-sales"]);
  is("and read with the store", (await storeForEmail(OWNER))!.alertEmailsOff, ["traffic", "quiet-sales"]);
  is("an always-on event cannot be switched off, and says so", await setAlertEmailsOff(OWNER, ["account"]), { ok: false, reason: "always_on" });
  is("an unknown event is refused", await setAlertEmailsOff(OWNER, ["traffic", "news"]), { ok: false, reason: "invalid" });
  is("not a list is refused", await setAlertEmailsOff(OWNER, "traffic"), { ok: false, reason: "invalid" });
  is("refusals left the choice as it was", (await storeForEmail(OWNER))!.alertEmailsOff, ["traffic", "quiet-sales"]);
  const cleared = await setAlertEmailsOff(OWNER, []);
  is("all on again", cleared.ok ? cleared.store.alertEmailsOff : cleared.reason, []);

  part("An alert switched off is not emailed; its chat post goes as before");
  let store = (await storeForEmail(OWNER))!;
  await setChatAddress(store.statsId!, "Notify Harbor", SLACK);
  await setChatSales(OWNER, true);
  const now = Date.now();
  sessions = [paid("cs_test_notify00000001", 0, 60_000, now)];
  await setSalesGoal(store.statsId!, 50_000, "usd");
  const month = new Date(now).toISOString().slice(0, 7);
  const day = (at: number) => new Date(at).toISOString().slice(0, 10);
  await setAlertEmailsOff(OWNER, ["goal-reached"]);
  store = (await storeForEmail(OWNER))!;
  posted.length = 0;
  emails.length = 0;
  const off = await checkAlerts(store, now);
  is("the goal reached is still said", off.said, 1);
  is("in the chat", posted.some((p) => p.startsWith("Notify Harbor reached its $500 goal")), true);
  is("but not by email", emails.length, 0);

  await redis.pipeline([["DEL", `nl:alert:${store.statsId}:goal-reached:${month}`, `nl:alert:seen:${day(now)}:${store.statsId}`]]);
  await setAlertEmailsOff(OWNER, []);
  store = (await storeForEmail(OWNER))!;
  const on = await checkAlerts(store, now + 1_000);
  is("switched on again: said and emailed once", [on.said, emails.length], [1, 1]);
  is("the email says where to choose", emails[0]?.text.includes(`/studio/notifications?store=${store.sid}`), true);
  is("and still how to stop them all", emails[0]?.text.includes("/api/store/weekly?h=notifyharbor"), true);

  part("The quiet-sales email follows its own choice, before anything is read");
  const quietNow = Date.UTC(2026, 9, 20, 12);
  sessions = Array.from({ length: 30 }, (_, i) => ({ id: `cs_nq${i}`, created: (quietNow - (20 + i) * DAY) / 1000, status: "complete", payment_status: "paid", metadata: { store: "notifyharbor" } }));
  const stretch = `nl:quiet:sent:notifyharbor:${quietNow - 20 * DAY}`;
  await setAlertEmailsOff(OWNER, ["quiet-sales"]);
  store = (await storeForEmail(OWNER))!;
  emails.length = 0;
  stripeCalls = 0;
  is("switched off: no email, no Stripe reading", [await checkQuiet(store, quietNow), emails.length, stripeCalls], ["skipped", 0, 0]);
  is("nothing used up: neither the day's look nor the stretch", [redis.run(["EXISTS", `nl:quiet:seen:${day(quietNow)}:notifyharbor`]), redis.run(["EXISTS", stretch])], [0, 0]);
  await setAlertEmailsOff(OWNER, []);
  store = (await storeForEmail(OWNER))!;
  is("switched on: sent once", [await checkQuiet(store, quietNow), emails.length, redis.run(["EXISTS", stretch])], ["sent", 1, 1]);
  is("with where to choose", emails[0]?.text.includes(`/studio/notifications?store=${store.sid}`), true);

  part("The route: the signed-in owner, optional events only");
  const session = await openSession(OWNER);
  const post = async (body: unknown, cookie = `${SESSION_COOKIE}=${session}`) => {
    const response = await prefsRoute(new NextRequest("https://marktmorgen.com/api/store/notify-prefs", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    return { status: response.status, cache: response.headers.get("cache-control"), body: (await response.json()) as { ok?: boolean; error?: string; off?: string[] } };
  };
  is("signed out", (await post({ off: ["traffic"] }, "")).status, 401);
  const routed = await post({ off: ["refunds", "traffic"] });
  is("saved", [routed.body, routed.cache], [{ ok: true, off: ["traffic", "refunds"] }, "no-store"]);
  const always = await post({ off: ["payments"] });
  is("an always-on one refused", [always.status, always.body, always.cache], [400, { ok: false, error: "always_on" }, "no-store"]);
  is("an unknown one refused", (await post({ off: ["nope"] })).body, { ok: false, error: "invalid" });
  is("nothing changed by the refusals", (await storeForEmail(OWNER))!.alertEmailsOff, ["traffic", "refunds"]);
  is("owner only, past the settings permission", readFileSync("app/api/store/notify-prefs/route.ts", "utf8").includes('if (guarded.role !== "owner") return Response.json({ ok: false, error: "owner_only" }'), true);
  await setWeeklyOff("notifyharbor", true);
  const restarted = await post({ restart: true });
  is("the weekly stop link undone from the page", [restarted.body, await weeklyOff("notifyharbor")], [{ ok: true, restarted: true }, false]);

  part("The studio page");
  const page = readFileSync("app/studio/notifications/page.tsx", "utf8");
  const panel = readFileSync("components/notify-prefs-panel.tsx", "utf8");
  is("the page is the owner's, and shows the store's own choice", page.includes('if (access.role !== "owner") redirect(') && page.includes("store.alertEmailsOff"), true);
  is("it says when the stop link holds, with a way to undo it", page.includes("weeklyOff(store.handle)") && panel.includes("Start these emails again"), true);
  is("it says when the store does not take payments yet", page.includes("These alerts start once your store takes payments"), true);
  is("a breadcrumb says where the owner is", page.includes('aria-label="Breadcrumb"') && page.includes('aria-current="page"'), true);
  is("nothing is disabled while saving, so focus stays", !panel.includes("disabled=") && panel.includes("aria-busy={busy}"), true);
  is("the always-on rows with their reasons, as text, not a disabled box", panel.includes("Always on") && panel.includes("row.reason") && !panel.includes("disabled={true}"), true);
  is("one labeled box per optional alert and one save", panel.includes("htmlFor={`notify-${row.id}`}") && panel.includes("Save choices"), true);
  is("the result is said in a status region", panel.includes('role="status"'), true);
  is("a lapsed sign-in is told to sign in again; a role refusal says who can", panel.includes("Sign in again, then save.") && panel.includes('case "role":'), true);
  is("the weekly stop link's reach is said with the alerts it stops, not under the always-on list", panel.indexOf("stop link") < panel.indexOf("Always sent"), true);
  is("the studio links to it for the owner", /role === "owner"\s*\?\s*\[\{ href: studioPath\(store, "", "notifications"\)/.test(readFileSync("app/studio/page.tsx", "utf8")), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
