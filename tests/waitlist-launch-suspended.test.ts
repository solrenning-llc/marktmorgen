/**
 * A store switched off after notices about its content (store.suspended,
 * lib/takedown.ts) sends no waitlist launch email and confirms no waitlist
 * spot, as its list takes no sign-up (lib/store-join.ts listOpen).
 *
 * - A launch started before the switch-off waits in the queue, nothing sent,
 *   and goes out once the store is back on (each address once).
 * - A switched-off store cannot start a launch: nothing is written.
 * - A spot confirmed after the switch-off is not counted and does not join
 *   the creator's list; the confirm button answers with the store's page.
 * - Its waitlist takes no address and sends no confirm email, also when
 *   called without the public route (lib/waitlist.ts joinWaitlist).
 * - A stored switch-off value that does not read as a day or as "on" (rule 24)
 *   is unknown: it is taken as switched off, never as on.
 * - A held launch keeps its send list and its record alive on each held run,
 *   so it still goes out months later; held 120 days from its start, it
 *   stops, says so, and keeps the addresses not yet emailed to send again.
 * - A switch-off during a run stops the rest of that run's batches.
 * - The studio panel says a held launch is paused, never "On sale... going
 *   out", and says a stopped launch stopped.
 *
 * Controls: a store that is on launches, sends and confirms exactly as before.
 * Synthetic data; no provider is called.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureListId, ensureStatsId, noteTakedown, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmSpot, joinWaitlist, launch, runLaunches, setSoon, waitlistViews } from "@/lib/waitlist";
import { waitlistTokenKey } from "@/lib/waitlist-tokens";
import { POST as confirmRoute } from "@/app/api/store/waitlist/confirm/route";
import { WaitlistPanel } from "@/components/waitlist-panel";
import { NOT_A_COST } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Sent = { to: string[] };
const batches: Sent[][] = [];
let single = 0;
/** Runs once, while the provider takes a batch: a switch-off in the middle of a run. */
let duringBatch: (() => Promise<unknown>) | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
    const batch = JSON.parse(String(init?.body)) as Sent[];
    batches.push(batch);
    const hook = duringBatch;
    duringBatch = null;
    if (hook) await hook();
    return Response.json({ data: batch.map((_, i) => ({ id: `synthetic_${i}` })) });
  }
  if (url.hostname === "api.resend.com") {
    single += 1;
    return Response.json({ id: "synthetic" });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const ADDRESS = "1 Main St, Portland, OR 97201";
const JOBS = "nl:wl:jobs";
const people = ["dana@example.com", "hal@example.com"];
const place = (i: number, ok: number, c = false) => JSON.stringify({ at: 1, ok, c, t: String(i).repeat(48) });
const ownerKey = (email: string) => `nl:store:owner:${createHash("sha256").update(`nimbus-store:${email.toLowerCase()}`).digest("hex").slice(0, 40)}`;

let stores = 0;
async function makeStore() {
  stores += 1;
  const owner = `owner${stores}@example.com`;
  const handle = `harbor${stores}`;
  await claimHandle(owner, handle, `Harbor ${stores}`, "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  const added = await addProduct(owner, "The Bread Book", "", "39", null);
  if (!added.ok) throw new Error("no product");
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, added.product.id))!;
  await setSoon(store, product.id, true);
  return { owner, handle, product, sid: store.statsId!, pid: product.id, current: async () => (await storeForEmail(owner))! };
}

/** Writes the store's switch-off value as it is, bypassing noteTakedown (a record no writer makes today). */
async function writeSuspended(owner: string, value: unknown) {
  const key = ownerKey(owner);
  const record = JSON.parse(String(redis.run(["GET", key]))) as Record<string, unknown>;
  record.suspended = value;
  redis.run(["SET", key, JSON.stringify(record)]);
}

// The test clock: the code's Date.now and the stand-in's expiries move together.
const realNow = Date.now.bind(Date);
let shift = 0;
Date.now = () => realNow() + shift;
const later = (days: number) => {
  shift += days * 86_400_000;
};
const DAY = 86_400;
const near = (value: unknown, want: number) => typeof value === "number" && Math.abs(value - want) <= 2;
const panelText = (view: unknown) =>
  renderToStaticMarkup(createElement(WaitlistPanel, { productId: "p1", initial: view as never, suggestedAddress: "", price: "$39.00" }))
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

const inJobs = (sid: string, pid: string) => redis.run(["SISMEMBER", JOBS, `${sid}|${pid}`]);
const run = () => runLaunches(storeForHandle, readListing, Date.now() + 10_000);

async function confirmPost(token: string) {
  return confirmRoute(
    new NextRequest("https://marktmorgen.com/api/store/waitlist/confirm", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", host: "marktmorgen.com", origin: "https://marktmorgen.com" },
      body: new URLSearchParams({ token }).toString(),
    }),
  );
}

/** A spot joined but not confirmed yet, with its confirm link, as joinWaitlist leaves it. */
function joined(s: { sid: string; pid: string; handle: string }, email: string, n: number) {
  const token = String(n % 10).repeat(48);
  redis.run(["HSET", `nl:wl:${s.sid}:${s.pid}`, email, place(n, 0, true)]);
  redis.run(["SET", waitlistTokenKey(token), JSON.stringify({ s: s.sid, h: s.handle, p: s.pid, e: email, k: "confirm" })]);
  return token;
}
const leadsOf = async (s: { current: () => Promise<{ listId: string | null }> }) => {
  const listId = (await s.current()).listId!;
  return redis.keys().includes(`nl:store:leads:${listId}`) ? redis.run(["HKEYS", `nl:store:leads:${listId}`]) : [];
};

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";

  part("Control: a store that is on launches and sends as before");
  {
    const s = await makeStore();
    for (const [i, email] of people.entries()) redis.run(["HSET", `nl:wl:${s.sid}:${s.pid}`, email, place(i, 1)]);
    const started = await launch(await s.current(), s.product, { note: "", address: ADDRESS });
    is("launched for both", started.ok && started.total, 2);
    batches.length = 0;
    is("the run sends to both", [await run(), batches.flat().map((m) => m.to[0]).sort()], [2, people]);
    is("and it is off the queue", inJobs(s.sid, s.pid), 0);
  }

  part("A launch started before the switch-off waits, then goes out once the store is back on");
  {
    const s = await makeStore();
    for (const [i, email] of people.entries()) redis.run(["HSET", `nl:wl:${s.sid}:${s.pid}`, email, place(i, 1)]);
    const started = await launch(await s.current(), s.product, { note: "", address: ADDRESS });
    is("launched for both", started.ok && started.total, 2);
    await noteTakedown(s.owner, null, true);
    is("the store is switched off", Boolean((await s.current()).suspended), true);
    batches.length = 0;
    const first = await run();
    is("nobody is emailed while it is off", [first, batches.flat().length], [0, 0]);
    const view = (await waitlistViews(await s.current(), [s.pid]))[s.pid];
    is("the launch stays queued, at the start, with its list", [inJobs(s.sid, s.pid), view?.launch?.cursor, Boolean(view?.launch?.finished), view?.confirmed], [1, 0, false, 2]);
    await noteTakedown(s.owner, null, false);
    batches.length = 0;
    is("back on: the next run sends to both, once", [await run(), batches.flat().map((m) => m.to[0]).sort()], [2, people]);
    is("and then it is off the queue", inJobs(s.sid, s.pid), 0);
  }

  part("A switched-off store cannot start a launch");
  {
    const s = await makeStore();
    for (const [i, email] of people.entries()) redis.run(["HSET", `nl:wl:${s.sid}:${s.pid}`, email, place(i, 1)]);
    await noteTakedown(s.owner, null, true);
    single = 0;
    const join = await joinWaitlist({ store: await s.current(), product: s.product, email: "new@example.com", consent: true, ip: "7.7.7.7", origin: "https://marktmorgen.com" });
    is("its waitlist takes no address", [join, redis.run(["HEXISTS", `nl:wl:${s.sid}:${s.pid}`, "new@example.com"])], ["closed", 0]);
    is("and sends no confirm email", single, 0);
    const refused = await launch(await s.current(), s.product, { note: "", address: ADDRESS });
    is("refused, as switched off", refused, { ok: false, reason: "switched_off" });
    is("still coming soon", redis.run(["SISMEMBER", `nl:wl:${s.sid}:soon`, s.pid]), 1);
    is("no launch job", redis.keys().includes(`nl:wl:${s.sid}:${s.pid}:job`), false);
    is("nothing queued", inJobs(s.sid, s.pid), 0);
    is("the list is kept", redis.run(["HLEN", `nl:wl:${s.sid}:${s.pid}`]), 2);
    batches.length = 0;
    is("the run sends nothing", [await run(), batches.flat().length], [0, 0]);
    const panel = readFileSync("components/waitlist-panel.tsx", "utf8");
    is("the studio says why, in words", /\bswitched_off: "/.test(panel), true);
  }

  part("A stored switch-off value that is not a day is unknown, never on (rule 24)");
  for (const [label, value] of [
    ["true", true],
    ["a word", "yes"],
    ["a number", 1],
    ["null", null],
  ] as [string, unknown][]) {
    const s = await makeStore();
    for (const [i, email] of people.entries()) redis.run(["HSET", `nl:wl:${s.sid}:${s.pid}`, email, place(i, 1)]);
    const started = await launch(await s.current(), s.product, { note: "", address: ADDRESS });
    is(`(${label}) launched for both while on`, started.ok && started.total, 2);
    await writeSuspended(s.owner, value);
    is(`(${label}) read as switched off`, Boolean((await s.current()).suspended), true);
    batches.length = 0;
    is(`(${label}) nobody is emailed`, [await run(), batches.flat().length], [0, 0]);
    is(`(${label}) the launch stays queued`, inJobs(s.sid, s.pid), 1);
    const other = await makeStore();
    await writeSuspended(other.owner, value);
    is(`(${label}) a new launch is refused`, await launch(await other.current(), other.product, { note: "", address: ADDRESS }), { ok: false, reason: "switched_off" });
    const token = joined(other, "late@example.com", stores);
    is(`(${label}) a spot is not confirmed`, await confirmSpot(token, await other.current()), { ok: false });
    is(`(${label}) and not added to the list`, await leadsOf(other), []);
  }
  {
    const s = await makeStore();
    await writeSuspended(s.owner, "");
    is("control: an empty value is on", (await s.current()).suspended, "");
    await writeSuspended(s.owner, undefined);
    is("control: no value at all (a store from before takedowns) is on", (await s.current()).suspended, "");
    await writeSuspended(s.owner, "2026-11-01T10:00:00.000Z");
    is("control: a day is that day", (await s.current()).suspended, "2026-11-01T10:00:00.000Z");
  }

  part("Control: a spot confirmed while the store is on counts and joins the list");
  {
    const s = await makeStore();
    const token = joined(s, "reader@example.com", 1);
    const answer = await confirmPost(token);
    is("303 to the waitlist page, confirmed", [answer.status, answer.headers.get("location")], [303, `https://marktmorgen.com/@${s.handle}/waitlist?product=${encodeURIComponent(s.pid)}&status=confirmed`]);
    const entry = JSON.parse(String(redis.run(["HGET", `nl:wl:${s.sid}:${s.pid}`, "reader@example.com"]))) as { ok: number };
    is("the spot counts", entry.ok > 0, true);
    is("and the address joined the creator's list", await leadsOf(s), ["reader@example.com"]);
  }

  part("A spot confirmed after the switch-off is not counted and joins no list");
  {
    const s = await makeStore();
    const token = joined(s, "reader@example.com", 2);
    await noteTakedown(s.owner, null, true);
    is("confirmSpot refuses", await confirmSpot(token, await s.current()), { ok: false });
    const answer = await confirmPost(token);
    is("the button answers with the store's page", [answer.status, answer.headers.get("location")], [303, `https://marktmorgen.com/@${s.handle}`]);
    const entry = JSON.parse(String(redis.run(["HGET", `nl:wl:${s.sid}:${s.pid}`, "reader@example.com"]))) as { ok: number };
    is("the spot does not count", entry.ok, 0);
    is("and the address is not on the creator's list", await leadsOf(s), []);
  }
  part("A held launch keeps its list alive while the store stays off, and goes out months later");
  {
    const s = await makeStore();
    for (const [i, email] of people.entries()) redis.run(["HSET", `nl:wl:${s.sid}:${s.pid}`, email, place(i, 1)]);
    is("launched for both", (await launch(await s.current(), s.product, { note: "", address: ADDRESS })).ok, true);
    await noteTakedown(s.owner, null, true);
    batches.length = 0;
    // The job runs every five minutes; a run every 25 days is enough to show the renewal.
    for (let day = 0; day <= 100; day += 25) {
      if (day) later(25);
      await run();
    }
    is("nobody is emailed while it is off", batches.flat().length, 0);
    const sendKey = `nl:wl:${s.sid}:${s.pid}:send`;
    const jobKey = `nl:wl:${s.sid}:${s.pid}:job`;
    is("after 100 days its send list is still whole", redis.run(["LLEN", sendKey]), 2);
    is("the held run renewed the send list for 30 days", near(redis.run(["TTL", sendKey]), 30 * DAY), true);
    is("and the launch's record for 120 days", near(redis.run(["TTL", jobKey]), 120 * DAY), true);
    is("still queued", inJobs(s.sid, s.pid), 1);
    const view = (await waitlistViews(await s.current(), [s.pid]))[s.pid];
    is("the studio view says the store is switched off", view?.switchedOff, true);
    await noteTakedown(s.owner, null, false);
    batches.length = 0;
    is("back on after 100 days: both are emailed, once", [await run(), batches.flat().map((m) => m.to[0]).sort()], [2, people]);
    is("and then it is off the queue", inJobs(s.sid, s.pid), 0);
    is("and the studio view says the store is on", (await waitlistViews(await s.current(), [s.pid]))[s.pid]?.switchedOff, false);
  }

  part("Held 120 days from its start, the launch stops, says so, and keeps who was not emailed");
  {
    const s = await makeStore();
    for (const [i, email] of people.entries()) redis.run(["HSET", `nl:wl:${s.sid}:${s.pid}`, email, place(i, 1)]);
    is("launched for both", (await launch(await s.current(), s.product, { note: "", address: ADDRESS })).total, 2);
    // The first address was emailed before the switch-off (the list is sorted: dana, then hal).
    const jobKey = `nl:wl:${s.sid}:${s.pid}:job`;
    const job = JSON.parse(String(redis.run(["GET", jobKey]))) as Record<string, number>;
    redis.run(["SET", jobKey, JSON.stringify({ ...job, cursor: 1, sent: 1 }), "EX", 120 * DAY]);
    await noteTakedown(s.owner, null, true);
    batches.length = 0;
    for (let day = 0; day <= 100; day += 25) {
      if (day) later(25);
      await run();
    }
    is("still held at 100 days", inJobs(s.sid, s.pid), 1);
    later(21);
    await run();
    is("at 121 days it is off the queue", inJobs(s.sid, s.pid), 0);
    const view = (await waitlistViews(await s.current(), [s.pid]))[s.pid];
    is("its record says it stopped unfinished: 1 of 2", [Boolean(view?.launch?.finished), Boolean(view?.launch?.stopped), view?.launch?.sent, view?.launch?.total], [true, true, 1, 2]);
    is("its send list is gone", redis.keys().includes(`nl:wl:${s.sid}:${s.pid}:send`), false);
    is("whoever had it is off the waitlist; the other is kept, confirmed", [redis.run(["HKEYS", `nl:wl:${s.sid}:${s.pid}`]), view?.confirmed], [["hal@example.com"], 1]);
    is("nobody was emailed", batches.flat().length, 0);
    await noteTakedown(s.owner, null, false);
    is("back on: the stopped launch sends nothing by itself", [await run(), batches.flat().length], [0, 0]);
    await setSoon(await s.current(), s.pid, true);
    const again = await launch(await s.current(), s.product, { note: "", address: ADDRESS });
    is("it can be started again, for the one not emailed", again, { ok: true, total: 1 });
    is("and that one is emailed, once", [await run(), batches.flat().map((m) => m.to[0])], [1, ["hal@example.com"]]);
  }

  part("A switch-off in the middle of a run stops the rest of its batches");
  {
    const many = Array.from({ length: 101 }, (_, i) => `reader${String(i).padStart(3, "0")}@example.com`);
    // A paid plan, so the store's own email figure takes 101 in a day.
    const paid = (owner: string, n: number) =>
      setSubscription(owner, { customerId: `cus_Launch0000${n}`, subscriptionId: `sub_Launch0000${n}`, active: true, tier: "pro", period: paidPeriod() });
    const control = await makeStore();
    await paid(control.owner, 1);
    for (const [i, email] of many.entries()) redis.run(["HSET", `nl:wl:${control.sid}:${control.pid}`, email, place(i % 10, 1)]);
    is("control launched for 101", (await launch(await control.current(), control.product, { note: "", address: ADDRESS })).total, 101);
    batches.length = 0;
    await run();
    is("control: a store that stays on gets both batches in one run", batches.map((b) => b.length), [100, 1]);
    later(1);
    const s = await makeStore();
    await paid(s.owner, 2);
    for (const [i, email] of many.entries()) redis.run(["HSET", `nl:wl:${s.sid}:${s.pid}`, email, place(i % 10, 1)]);
    is("launched for 101", (await launch(await s.current(), s.product, { note: "", address: ADDRESS })).total, 101);
    batches.length = 0;
    duringBatch = () => noteTakedown(s.owner, null, true);
    await run();
    is("switched off during the first batch: the second does not go", batches.map((b) => b.length), [100]);
    const view = (await waitlistViews(await s.current(), [s.pid]))[s.pid];
    is("the launch waits after the first batch", [inJobs(s.sid, s.pid), view?.launch?.cursor, Boolean(view?.launch?.finished)], [1, 100, false]);
    await noteTakedown(s.owner, null, false);
    batches.length = 0;
    await run();
    is("back on: the one left is emailed", batches.flat().map((m) => m.to[0]), [many[100]]);
  }

  part("The studio panel says a held launch is paused and a stopped one stopped");
  {
    const started = Date.UTC(2026, 10, 1, 12) / 1000;
    const job = { handle: "harbor", note: "", address: ADDRESS, total: 2, cursor: 0, sent: 0, started, finished: 0 };
    const held = panelText({ soon: false, confirmed: 2, waiting: 0, launch: job, switchedOff: true });
    is("held: it says paused while the store is switched off", /paused while your store is switched off/i.test(held), true);
    is("held: never on sale, never going out", /On sale|is going out/.test(held), false);
    is("held: it says what was sent", /0 of 2/.test(held), true);
    is("held: it says the day it stops if the store is still off", held.includes("March 1, 2027"), true);
    const stopped = panelText({ soon: false, confirmed: 1, waiting: 0, launch: { ...job, cursor: 1, sent: 1, finished: started + 121 * DAY, stopped: started + 121 * DAY }, switchedOff: false });
    is("stopped: it says it stopped, with what went out", /stopped/i.test(stopped) && /1 of 2/.test(stopped), true);
    is("stopped: never \"Launched\"", /Launched\./.test(stopped), false);
    is("stopped: it says how to send it again", /coming soon again/i.test(stopped), true);
    const sending = panelText({ soon: false, confirmed: 2, waiting: 0, launch: job, switchedOff: false });
    is("control: a store that is on still says it is going out", /On sale\. The waitlist email is going out: 0 of 2 so far/.test(sending), true);
    const finished = panelText({ soon: false, confirmed: 0, waiting: 0, launch: { ...job, cursor: 2, sent: 2, finished: started + 60 }, switchedOff: false });
    is("control: a finished launch still says launched", /Launched\. 2 of 2 waitlist emails went out\./.test(finished), true);
  }

  part("The held runs' commands are in the cost registry");
  is("LAUNCH_HOLD_SECONDS is explained in NOT_A_COST", typeof NOT_A_COST.LAUNCH_HOLD_SECONDS, "string");
}

main()
  .then(done)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
