/**
 * The owner's urgent email about a child-safety report or a request to remove
 * an intimate image is repeated every 24 hours until the owner marks the
 * report handled, and for an intimate image a reminder goes 6 hours before
 * the TAKE IT DOWN Act's 48-hour deadline, naming it in UTC
 * (lib/child-safety-alerts.ts, C1-20261109-1546-TODOS-70).
 *
 * The link that marks it handled is unguessable, kept only as a hash, and a
 * GET never closes anything (mail scanners open links): only the button's
 * POST from this site does. Everything is bounded: a report is reminded for
 * 30 days at the most, a run sends a bounded batch, and the anonymous form
 * cannot grow the list past its cap (the urgent email still goes, and says
 * so). A Redis reply off its shape is unknown: nothing is sent, nothing is
 * dropped, the next run tries again, and the sweep never throws out of the
 * cron. Nobody opens or describes reported content: neutral placeholders,
 * synthetic store, email stand-in and in-memory Redis.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { addProduct, claimHandle, ensureStatsId, setSubscription } from "@/lib/store";
import { alertOwner } from "@/lib/child-safety";
import {
  ALERTS_DUE,
  ALERT_BATCH,
  ALERT_DAYS,
  ALERT_SENDS,
  OPEN_ALERTS_MAX,
  REMIND_HOURS,
  WARN_BEFORE_HOURS,
  alertKey,
  closeAlert,
  sendDueAlerts,
} from "@/lib/child-safety-alerts";
import { POST as reportRoute } from "@/app/api/report/route";
import { POST as handledRoute } from "@/app/api/report/handled/route";
import HandledPage from "@/app/report/handled/[token]/page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Sent = { to: string[] | string; subject: string; text: string };
const sent: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WORDS = "Placeholder words of the reporter, never to be repeated.";
const CHILD = { kind: "child_safety", url: "", work: WORDS, name: "", email: "reporter@example.com", signature: "", goodFaith: true, accurate: false };
const LINK = /https:\/\/marktmorgen\.com\/report\/handled\/([0-9a-f]{96})/;

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];

/** Runs `work` with every command `match` picks answered `reply`, as a reply off its shape would be. */
async function answering<T>(match: (command: Commands[number]) => boolean, reply: unknown, work: () => Promise<T>): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => {
    const real = (await original.call(redis, commands)) as unknown[];
    return commands.map((command, i) => (match(command) ? reply : real[i]));
  }) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

const tokenOf = (mail: Sent | undefined) => mail?.text.match(LINK)?.[1] ?? "";
const idOf = (token: string) => token.slice(0, 32);
const due = () => redis.run(["ZRANGE", ALERTS_DUE, 0, -1]) as string[];
const post = (token: string, origin = "https://marktmorgen.com") =>
  handledRoute(
    new NextRequest("https://marktmorgen.com/api/report/handled", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin, host: "marktmorgen.com" },
      body: new URLSearchParams({ t: token }).toString(),
    }),
  );
const page = async (token: string, query: Record<string, string> = {}) =>
  renderToStaticMarkup(await HandledPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(query) }));

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const owner = "escalation@example.com";
  await claimHandle(owner, "escalate", "Escalate", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_ce", subscriptionId: "sub_ce", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const made = await addProduct(owner, "A Placeholder Product", "Placeholder", "19", null);
  if (!made.ok) throw new Error("no product");
  const url = `https://marktmorgen.com/@escalate/p/${made.product.id}`;

  part("The urgent email opens a reminder and carries a link that marks the report handled");
  const response = await reportRoute(new NextRequest("https://marktmorgen.com/api/report", { method: "POST", headers: { "content-type": "application/json", origin: "https://marktmorgen.com", host: "marktmorgen.com" }, body: JSON.stringify({ ...CHILD, url }) }));
  is("the report is taken", response.status, 200);
  const urgent = sent.find((m) => m.subject.startsWith("URGENT: child safety report"));
  const first = tokenOf(urgent);
  is("the urgent email has an unguessable handled link (96 hex characters)", first.length, 96);
  is("and says a reminder follows every 24 hours until it is marked handled", /every 24 hours until/.test(urgent?.text ?? ""), true);
  const record = String(redis.run(["GET", alertKey(idOf(first))]) ?? "");
  is("the open alert is kept", record.length > 0, true);
  is("with where and what was done, never the reporter's words, address or the link itself", [record.includes(url), record.includes(WORDS), record.includes("reporter@example.com"), record.includes(first)], [true, false, false, false]);
  is("kept a bounded time", (redis.run(["TTL", alertKey(idOf(first))]) as number) > 0, true);
  is("due 24 hours later", Number(redis.run(["ZSCORE", ALERTS_DUE, idOf(first)])) >= Date.now() + REMIND_HOURS * HOUR - 60_000, true);

  part("Reminders every 24 hours while open");
  const start = Date.now();
  sent.length = 0;
  is("nothing before it is due", (await sendDueAlerts(start + HOUR)).sent, 0);
  const one = await sendDueAlerts(start + REMIND_HOURS * HOUR + 60_000);
  is("one reminder when due", [one.sent, sent.length], [1, 1]);
  is("its subject says urgent, the reminder's number and the store", sent[0]?.subject.startsWith("URGENT (reminder 1): child safety report about @escalate"), true);
  is("its text says still open since when, and where", [/still open since/.test(sent[0]?.text ?? ""), (sent[0]?.text ?? "").includes(url)], [true, true]);
  is("never the reporter's words or address", [(sent[0]?.text ?? "").includes(WORDS), (sent[0]?.text ?? "").includes("reporter@example.com")], [false, false]);
  is("and the same rules: nobody opens or describes the content", /Do not open, download, forward or describe/.test(sent[0]?.text ?? ""), true);
  const second = tokenOf(sent[0]);
  is("with a handled link of its own", second.length === 96 && second !== first && idOf(second) === idOf(first), true);
  is("not again within the next 24 hours", (await sendDueAlerts(start + REMIND_HOURS * HOUR + 2 * HOUR)).sent, 1 - 1);
  is("the next day, reminder 2", [(await sendDueAlerts(start + 2 * REMIND_HOURS * HOUR + 2 * 60_000)).sent, sent[1]?.subject.startsWith("URGENT (reminder 2)")], [1, true]);

  part("Marking it handled: a GET only shows a button; the POST from this site closes it");
  const shown = await page(first);
  is("the page asks, with a button that posts", [/method="post"/.test(shown), /action="\/api\/report\/handled"/.test(shown), /Mark this report handled/.test(shown)], [true, true, true]);
  is("and shows no reported content", [shown.includes(WORDS), shown.includes("reporter@example.com")], [false, false]);
  is("opening the page closes nothing", redis.run(["ZSCORE", ALERTS_DUE, idOf(first)]) !== null, true);
  is("a post from another site is refused", (await post(first, "https://elsewhere.example")).status, 403);
  is("a link that is not one of ours is not found", (await post("f".repeat(96))).status, 404);
  is("a wrong secret for a real alert closes nothing", [(await post(idOf(first) + "0".repeat(64))).headers.get("location")?.endsWith("?done=0"), redis.run(["ZSCORE", ALERTS_DUE, idOf(first)]) !== null], [true, true]);
  const closed = await post(second);
  is("the reminder's own link closes it: back to the page, done", [closed.status, closed.headers.get("location")?.endsWith(`/report/handled/${second}?done=1`)], [303, true]);
  is("it is out of the due list and its record is gone", [redis.run(["ZSCORE", ALERTS_DUE, idOf(first)]), redis.run(["GET", alertKey(idOf(first))])], [null, null]);
  is("the page says it is handled", /marked handled/i.test(await page(second, { done: "1" })), true);
  is("no reminder after", (await sendDueAlerts(start + 10 * DAY)).sent, 0);
  is("marking it again is said as already handled or unknown, never an error", await closeAlert(second), "unknown_link");

  part("An intimate image: a reminder 6 hours before the 48-hour deadline, in UTC");
  sent.length = 0;
  const at = Date.UTC(2026, 10, 9, 15, 0);
  await alertOwner({ kind: "intimate_image", url }, "not_held", at);
  const intimate = tokenOf(sent[0]);
  is("the urgent email has its handled link", intimate.length, 96);
  is("first reminder after 24 hours", [(await sendDueAlerts(at + 24 * HOUR + 60_000)).sent, sent[1]?.subject.startsWith("URGENT (reminder 1): request to remove an intimate image")], [1, true]);
  is("the warning is due at the deadline less 6 hours", WARN_BEFORE_HOURS, 6);
  is("nothing before it", (await sendDueAlerts(at + 41 * HOUR)).sent, 0);
  is("6 hours before the deadline: the reminder names the exact deadline in UTC", [(await sendDueAlerts(at + 42 * HOUR + 60_000)).sent, (sent[2]?.text ?? "").includes("November 11, 2026, 3:00 PM UTC"), /6 hours/.test(sent[2]?.text ?? "")], [1, true, true]);
  is("not twice", (await sendDueAlerts(at + 43 * HOUR)).sent, 0);
  is("after the deadline, every 24 hours, saying it passed", [(await sendDueAlerts(at + 66 * HOUR + 60_000)).sent, /passed/.test(sent[3]?.text ?? "")], [1, true]);
  is("closed from its link", (await closeAlert(intimate)), "closed");

  part("Bounded: 30 days or 30 emails at the most, and the last one says so");
  is("the bounds", [ALERT_DAYS, ALERT_SENDS, OPEN_ALERTS_MAX, ALERT_BATCH], [30, 30, 200, 10]);
  sent.length = 0;
  const long = Date.UTC(2026, 10, 1, 9, 0);
  await alertOwner({ kind: "child_safety", url }, "held", long);
  for (let day = 1; day <= 40; day++) await sendDueAlerts(long + day * DAY + 60_000);
  is("never more emails than the cap, the urgent one included", sent.length <= ALERT_SENDS, true);
  is("the last says it is the last", /last reminder/i.test(sent[sent.length - 1]?.text ?? ""), true);
  is("and nothing is left", due().length, 0);

  part("The anonymous form cannot grow the list without bound");
  redis.clear();
  sent.length = 0;
  for (let n = 0; n < OPEN_ALERTS_MAX; n++) redis.run(["ZADD", ALERTS_DUE, Date.now() + 365 * DAY, n.toString(16).padStart(32, "0")]);
  await alertOwner({ kind: "child_safety", url }, "held");
  is("past the cap the urgent email still goes", sent.length, 1);
  is("without a handled link, saying the reminder list is full", [LINK.test(sent[0]?.text ?? ""), /reminder list is full/i.test(sent[0]?.text ?? "")], [false, true]);
  is("and nothing is added", due().length, OPEN_ALERTS_MAX);

  part("A bounded batch a run");
  redis.clear();
  sent.length = 0;
  const batchAt = Date.UTC(2026, 10, 2, 9, 0);
  for (let n = 0; n < ALERT_BATCH + 5; n++) await alertOwner({ kind: "child_safety", url }, "held", batchAt + n);
  sent.length = 0;
  is("one run sends at most the batch", (await sendDueAlerts(batchAt + DAY + HOUR)).sent, ALERT_BATCH);
  is("the next run the rest", (await sendDueAlerts(batchAt + DAY + 2 * HOUR)).sent, 5);

  part("A reply off its shape is unknown: nothing sent, nothing dropped, tried again; never throws");
  redis.clear();
  sent.length = 0;
  const odd = Date.UTC(2026, 10, 3, 9, 0);
  await alertOwner({ kind: "child_safety", url }, "held", odd);
  const oddId = idOf(tokenOf(sent[0]));
  sent.length = 0;
  const whenDue = odd + DAY + 60_000;
  for (const reply of ["QUEUED", 7, ["x"], "{not json", JSON.stringify({ kind: "other" })]) {
    const result = await answering((c) => c[0] === "GET" && String(c[1]).startsWith("nl:csa:alert:"), reply, () => sendDueAlerts(whenDue));
    is(`record read as ${JSON.stringify(reply)}: unknown, not sent, still due`, [result.sent, result.unknown, sent.length, redis.run(["ZSCORE", ALERTS_DUE, oddId]) !== null], [0, 1, 0, true]);
  }
  const listOdd = await answering((c) => c[0] === "ZRANGEBYSCORE", "QUEUED", () => sendDueAlerts(whenDue));
  is("the due list off its shape: nothing sent", [listOdd.sent, listOdd.unknown, sent.length], [0, 1, 0]);
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async () => {
    throw new Error("connection reset");
  }) as Pipeline;
  let threw = false;
  const down = await sendDueAlerts(whenDue).catch(() => {
    threw = true;
    return null;
  });
  redis.pipeline = original;
  is("Redis out of reach: the sweep returns, never throws", [threw, down?.sent], [false, 0]);
  is("and the next run sends it", (await sendDueAlerts(whenDue)).sent, 1);
  const writeOdd = await answering((c) => c[0] === "SET" && String(c[1]).startsWith("nl:csa:alert:"), "QUEUED", () => sendDueAlerts(whenDue + DAY));
  is("the reschedule unconfirmed: counted unknown, the alert kept", [writeOdd.unknown, redis.run(["ZSCORE", ALERTS_DUE, oddId]) !== null], [1, true]);
  const openOdd = await answering((c) => c[0] === "ZCARD", "QUEUED", async () => {
    sent.length = 0;
    await alertOwner({ kind: "child_safety", url }, "held", odd + 5);
    return sent[0]?.text ?? "";
  });
  is("opening an alert unconfirmed: the urgent email still goes, says reminders could not be set up", [LINK.test(openOdd), /could not be set up/i.test(openOdd)], [false, true]);

  part("Wired into a cron that runs every hour, and documented");
  const quiet = readFileSync("app/api/cron/quiet/route.ts", "utf8");
  is("the hourly quiet cron sends the due reminders, under its lock", [/import \{ sendDueAlerts \} from "@\/lib\/child-safety-alerts"/.test(quiet), /await sendDueAlerts\(/.test(quiet)], [true, true]);
  is("which runs every hour", /"path": "\/api\/cron\/quiet",\s*"schedule": "50 \* \* \* \*"/.test(readFileSync("vercel.json", "utf8")), true);
  const doc = readFileSync("docs/incident-response.md", "utf8");
  is("docs/incident-response.md says how to mark it handled", [/a cada 24 horas/.test(doc), /Mark this report handled/.test(doc)], [true, true]);

  done();
}

void main();
