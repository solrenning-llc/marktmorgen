/**
 * Which studio alert emails a creator gets, event by event (queue item 601
 * [KB22], unit U6; lib/notify-prefs-rules.ts, lib/notify-prefs.ts). Checked:
 *
 *   - the catalog: every kind lib/store-alerts.ts can say, and the quiet-sales
 *     email, is a choice; the always-on notices each carry their reason and
 *     cannot be saved as off; defaults are today's behavior (all on);
 *   - the saved choice is read only in its exact shape: an absent key is "no
 *     choice saved" (all on), anything else that is not a list of distinct
 *     known events is unknown, never an empty list;
 *   - an optional alert switched off is not emailed, while its phone and chat
 *     posts go as before; an unknown reading sends no email against a choice
 *     that cannot be read, lets the day's look go so the next run tries again,
 *     and loses nothing;
 *   - the always-on notices never read the choice;
 *   - the route saves only for the owner or an Admin, refuses an always-on or
 *     unknown event, and says when it could not confirm the write;
 *   - the studio page names what is always on and why.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { ALWAYS_ON_ROWS, OPTIONAL_EVENTS, OPTIONAL_ROWS, notifyPrefsPath, parseOff } from "@/lib/notify-prefs-rules";
import { readNotifyOff, saveNotifyOff } from "@/lib/notify-prefs";
import { checkAlerts } from "@/lib/store-alerts";
import { checkQuiet } from "@/lib/quiet-sales";
import { setChatAddress } from "@/lib/chat-summary";
import { setSalesGoal } from "@/lib/sales-goal";
import { claimHandle, ensureStatsId, ensureStoreId, setChatSales, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as prefsRoute } from "@/app/api/store/notify-prefs/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_notify_prefs_stand_in";
process.env.RESEND_API_KEY = "re_test_notify_prefs_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "notify-owner@example.com";
const SLACK = "https://hooks.slack.com/services/T000/B000/abcdefghijklmnop";
const DAY = 86_400_000;
const posted: string[] = [];
const emails: { to: string; subject: string; text: string }[] = [];
let sessions: Record<string, unknown>[] = [];

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
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return json({ object: "list", data: sessions, has_more: false });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

type Commands = (string | number)[][];

/** Every pipeline that reads the saved choice answers `reply` instead, until `heal()` is called; counts how many asked. */
function garbleChoice(reply: unknown): { asked: () => number; heal: () => void } {
  const real = redis.pipeline.bind(redis);
  let asked = 0;
  redis.pipeline = (async (commands: Commands) => {
    if (commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:notify:off:"))) {
      asked += 1;
      return reply;
    }
    return real(commands);
  }) as typeof redis.pipeline;
  return { asked: () => asked, heal: () => void (redis.pipeline = real) };
}

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
    for (const source of row.sources) is(`${source} never reads the choice`, readFileSync(source, "utf8").includes("notify-prefs"), false);
  }
  is("the studio page", notifyPrefsPath("s_abc"), "/studio/notifications?store=s_abc");
  is("without a store id", notifyPrefsPath(null), "/studio/notifications");

  part("The saved list is read only in its exact shape");
  is("a list of known events", parseOff(["traffic", "quiet-sales"]), ["traffic", "quiet-sales"]);
  is("empty is a choice: all on", parseOff([]), []);
  is("an always-on event saved is not a list we wrote", parseOff(["account"]), null);
  is("an unknown event", parseOff(["traffic", "news"]), null);
  is("a repeat", parseOff(["traffic", "traffic"]), null);
  is("not a list", parseOff({ traffic: true }), null);
  is("a number in it", parseOff(["traffic", 1]), null);
  is("too many", parseOff([...OPTIONAL_EVENTS, ...OPTIONAL_EVENTS]), null);

  const STATS = "st_notify_test";
  is("nothing saved: no event off, today's behavior", [...((await readNotifyOff(STATS)) ?? new Set(["unknown"]))], []);
  is("no stats id: nothing can have been saved", [...((await readNotifyOff(null)) ?? new Set(["unknown"]))], []);
  const saved = await saveNotifyOff(STATS, ["quiet-sales", "traffic"]);
  is("saved, read back, in the catalog's order", saved === "invalid" || saved === "unknown" ? saved : [...saved], ["traffic", "quiet-sales"]);
  is("read", [...((await readNotifyOff(STATS)) ?? [])], ["traffic", "quiet-sales"]);
  is("one key, a short list", redis.run(["GET", `nl:notify:off:${STATS}`]), JSON.stringify(["traffic", "quiet-sales"]));
  is("an always-on event cannot be switched off", await saveNotifyOff(STATS, ["account"]), "invalid");
  is("an unknown event is refused", await saveNotifyOff(STATS, ["traffic", "news"]), "invalid");
  is("a repeat is refused", await saveNotifyOff(STATS, ["traffic", "traffic"]), "invalid");
  is("not a list is refused", await saveNotifyOff(STATS, "traffic"), "invalid");
  is("refusals left the choice as it was", [...((await readNotifyOff(STATS)) ?? [])], ["traffic", "quiet-sales"]);
  const cleared = await saveNotifyOff(STATS, []);
  is("all on again", cleared === "invalid" || cleared === "unknown" ? cleared : [...cleared], []);
  is("and the key is gone", redis.run(["EXISTS", `nl:notify:off:${STATS}`]), 0);

  for (const [label, value] of [["not JSON", "{traffic"], ["an object", JSON.stringify({ off: ["traffic"] })], ["an always-on event", JSON.stringify(["account"])], ["a number", "7"]] as const) {
    await redis.pipeline([["SET", `nl:notify:off:${STATS}`, value]]);
    is(`a saved value that is ${label} is unknown, never "all on"`, await readNotifyOff(STATS), null);
  }
  await redis.pipeline([["DEL", `nl:notify:off:${STATS}`]]);
  for (const [label, reply] of [["no reply", []], ["undefined", [undefined]], ["a count", [1]], ["two replies", [null, null]], ["not a list", "OK"]] as const) {
    const garbled = garbleChoice(reply);
    try {
      is(`the read answered ${label}: unknown`, await readNotifyOff(STATS), null);
    } finally {
      garbled.heal();
    }
  }
  {
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async () => {
      throw new Error("down");
    }) as typeof redis.pipeline;
    try {
      is("Redis down: unknown", await readNotifyOff(STATS), null);
      is("Redis down on save: unknown, never saved", await saveNotifyOff(STATS, ["traffic"]), "unknown");
    } finally {
      redis.pipeline = real;
    }
  }
  {
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: Commands) => {
      const answer = await real(commands);
      return commands.length === 2 ? ["QUEUED", answer[1]] : answer;
    }) as typeof redis.pipeline;
    try {
      is("a write answered in another shape: not confirmed", await saveNotifyOff(STATS, ["refunds"]), "unknown");
    } finally {
      redis.pipeline = real;
    }
    await redis.pipeline([["DEL", `nl:notify:off:${STATS}`]]);
  }

  part("An alert switched off is not emailed; its phone and chat posts go as before");
  await claimHandle(OWNER, "notifyharbor", "Notify Harbor", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestNotify0001", true);
  await setSubscription(OWNER, { customerId: "cus_Notify00001", subscriptionId: "sub_Notify00001", active: true, period: paidPeriod() });
  let store = (await storeForEmail(OWNER))!;
  await setChatAddress(store.statsId!, "Notify Harbor", SLACK);
  await setChatSales(OWNER, true);
  store = (await storeForEmail(OWNER))!;
  const now = Date.now();
  sessions = [paid("cs_test_notify00000001", 0, 60_000, now)];
  await setSalesGoal(store.statsId!, 50_000, "usd");
  const month = new Date(now).toISOString().slice(0, 7);
  const day = (at: number) => new Date(at).toISOString().slice(0, 10);

  await saveNotifyOff(store.statsId!, ["goal-reached"]);
  posted.length = 0;
  emails.length = 0;
  const off = await checkAlerts(store, now);
  is("the goal reached is still said", off.said, 1);
  is("in the chat", posted.some((p) => p.startsWith("Notify Harbor reached its $500 goal")), true);
  is("but not by email", emails.length, 0);

  part("An unknown reading of the choice sends no email against it, and loses nothing");
  await redis.pipeline([["DEL", `nl:alert:${store.statsId}:goal-reached:${month}`, `nl:alert:seen:${day(now)}:${store.statsId}`]]);
  await saveNotifyOff(store.statsId!, []);
  posted.length = 0;
  emails.length = 0;
  const garbled = garbleChoice([undefined]);
  let unknown;
  try {
    unknown = await checkAlerts(store, now);
  } finally {
    garbled.heal();
  }
  is("nothing said, no email, no chat post", [unknown.said, emails.length, posted.length], [0, 0, 0]);
  is("the choice was asked once", garbled.asked(), 1);
  is("the alert's week is not used up", redis.run(["EXISTS", `nl:alert:${store.statsId}:goal-reached:${month}`]), 0);
  is("the day's look is let go, so the next run tries again", redis.run(["EXISTS", `nl:alert:seen:${day(now)}:${store.statsId}`]), 0);
  const retried = await checkAlerts(store, now + 1_000);
  is("the next run reads the choice (all on) and says it once", [retried.said, emails.length], [1, 1]);
  is("the email says where to choose", emails[0]?.text.includes(`/studio/notifications?store=${store.sid}`), true);

  part("The quiet-sales email follows its own choice");
  const quietNow = Date.UTC(2026, 9, 20, 12);
  const quietStore = { ...store, handle: "notifyharbor" };
  const quiet = Array.from({ length: 30 }, (_, i) => ({ id: `cs_nq${i}`, created: (quietNow - (20 + i) * DAY) / 1000, status: "complete", payment_status: "paid", metadata: { store: "notifyharbor" } }));
  sessions = quiet;
  await saveNotifyOff(store.statsId!, ["quiet-sales"]);
  emails.length = 0;
  is("switched off: no email", [await checkQuiet(quietStore, quietNow), emails.length], ["skipped", 0]);
  is("its stretch is not used up", redis.run(["KEYS", "nl:quiet:sent:notifyharbor:*"]), []);
  await saveNotifyOff(store.statsId!, []);
  await redis.pipeline([["DEL", `nl:quiet:seen:${day(quietNow)}:notifyharbor`]]);
  const garbledQuiet = garbleChoice([7]);
  let quietUnknown;
  try {
    quietUnknown = await checkQuiet(quietStore, quietNow);
  } finally {
    garbledQuiet.heal();
  }
  is("an unknown choice: no email, nothing used up", [quietUnknown, emails.length, redis.run(["KEYS", "nl:quiet:sent:notifyharbor:*"])], ["skipped", 0, []]);
  is("and the day's look let go", redis.run(["EXISTS", `nl:quiet:seen:${day(quietNow)}:notifyharbor`]), 0);
  is("the next run sends it once", [await checkQuiet(quietStore, quietNow + 3_600_000), emails.length], ["sent", 1]);
  is("with where to choose", emails[0]?.text.includes(`/studio/notifications?store=${store.sid}`), true);

  part("The route: owner or Admin, optional events only, confirmed or said so");
  const session = await openSession(OWNER);
  const post = async (body: unknown, cookie = `${SESSION_COOKIE}=${session}`) => {
    const response = await prefsRoute(new NextRequest("https://marktmorgen.com/api/store/notify-prefs", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; off?: string[] } };
  };
  is("signed out", (await post({ off: ["traffic"] }, "")).status, 401);
  is("saved", (await post({ off: ["refunds", "traffic"] })).body, { ok: true, off: ["traffic", "refunds"] });
  is("an always-on one refused", (await post({ off: ["payments"] })).body, { ok: false, error: "always_on" });
  is("an unknown one refused", (await post({ off: ["nope"] })).body, { ok: false, error: "invalid" });
  is("nothing changed by the refusals", [...((await readNotifyOff(store.statsId)) ?? [])], ["traffic", "refunds"]);
  {
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: Commands) => {
      const answer = await real(commands);
      return commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:notify:off:")) && commands.length === 2 ? [answer[0], undefined] : answer;
    }) as typeof redis.pipeline;
    try {
      const unconfirmed = await post({ off: [] });
      is("a write not confirmed is said as not confirmed", [unconfirmed.status, unconfirmed.body.error], [503, "unknown"]);
    } finally {
      redis.pipeline = real;
    }
  }

  part("The studio page");
  const page = readFileSync("app/studio/notifications/page.tsx", "utf8");
  const panel = readFileSync("components/notify-prefs-panel.tsx", "utf8");
  is("the page reads the choice and says when it cannot", page.includes("readNotifyOff") && page.includes('role="alert"'), true);
  is("the always-on rows with their reasons, as text, not a disabled box", panel.includes("Always on") && panel.includes("row.reason") && !panel.includes("disabled={true}"), true);
  is("one labeled box per optional alert and one save", panel.includes("htmlFor={`notify-${row.id}`}") && panel.includes("Save choices"), true);
  is("the result is said in a status region", panel.includes('role="status"'), true);
  is("the studio links to it", readFileSync("app/studio/page.tsx", "utf8").includes('studioPath(store, "", "notifications")'), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
