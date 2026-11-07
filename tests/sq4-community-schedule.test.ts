/**
 * 293 [SQ4], unit 1: a post or an announcement written ahead in the studio and
 * put up in the community at the date and time the creator chose, on the
 * clock of the time zone chosen. It can be edited or canceled until the five-minute
 * job takes it; the job then posts it under the community's rules as they are
 * at that moment (the space still there, the post cap, the store's data room),
 * and asks for the announcement's email only then. A try whose outcome is not
 * known is never made again. The in-memory Redis stand-in and a synthetic
 * store only: no email is sent and no real record is touched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claimHandle, ensureListId, ensureStatsId, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import { feed, freshConfig, readConfig, saveConfig } from "@/lib/community";
import { dataKey } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "sq4owner@example.com";
const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

async function main(): Promise<void> {
  const rules = await import("@/lib/community-schedule-rules");
  const sched = await import("@/lib/community-schedule");
  const {
    MAX_SCHEDULED_POSTS,
    MIN_LEAD_SECONDS,
    MAX_AHEAD_DAYS,
    PUBLISH_TRIES,
    RETRY_SECONDS,
    SCHEDULE_UNITS,
    STUCK_SECONDS,
    POSTED_KEEP_SECONDS,
    SCHEDULE_PROBLEMS,
    readScheduleInput,
  } = rules;

  part("The rules: bounded, and paid for before anything is spent");
  is("a community keeps at most a handful of scheduled posts", MAX_SCHEDULED_POSTS > 0 && MAX_SCHEDULED_POSTS <= 25, true);
  is("posting is tried a bounded number of times", PUBLISH_TRIES >= 1 && PUBLISH_TRIES <= 3, true);
  is("scheduling takes the act and every try the job may make, at once", SCHEDULE_UNITS, 1 + PUBLISH_TRIES);
  is("a try put off waits for a later five-minute run", RETRY_SECONDS >= 300, true);
  is("at least ten minutes ahead, so the five-minute job can keep the time", MIN_LEAD_SECONDS >= 600, true);
  is("never more than a season ahead", MAX_AHEAD_DAYS > 0 && MAX_AHEAD_DAYS <= 90, true);
  is("held up only after more than two runs", STUCK_SECONDS >= 600, true);
  is("posted ones are kept a week for the creator to see", POSTED_KEEP_SECONDS, 7 * 86_400);

  part("What the studio sends, read on the clock of the zone chosen");
  const spaces = [{ id: "aaaaaaaaaaaa" }, { id: "bbbbbbbbbbbb" }];
  // 15 January 2030, 9:30 in New York (EST, UTC-5) is 14:30 UTC.
  const now = Date.UTC(2030, 0, 1, 12, 0);
  const good = { space: "bbbbbbbbbbbb", title: "Office hours", text: "Bring your questions.", kind: "announcement", email: true, date: "2030-01-15", time: "09:30", tz: "America/New_York" };
  const read1 = readScheduleInput(good, spaces, now);
  is("a good one is read", read1, {
    ok: true,
    input: { sp: "bbbbbbbbbbbb", title: "Office hours", text: "Bring your questions.", kind: "announcement", email: true, due: Date.UTC(2030, 0, 15, 14, 30) / 1000, tz: "America/New_York", date: "2030-01-15", time: "09:30" },
  });
  const summer = readScheduleInput({ ...good, date: "2030-07-15" }, spaces, Date.UTC(2030, 6, 1, 12, 0));
  is("in summer the same clock is an hour earlier in UTC (EDT)", summer.ok ? summer.input.due : null, Date.UTC(2030, 6, 15, 13, 30) / 1000);
  is("a plain post is never emailed, whatever was sent", (() => { const r = readScheduleInput({ ...good, kind: "post" }, spaces, now); return r.ok ? [r.input.kind, r.input.email] : null; })(), ["post", false]);
  is("a space that is not there is refused", readScheduleInput({ ...good, space: "cccccccccccc" }, spaces, now), { ok: false, problem: "space" });
  is("no words is refused: a scheduled post has words only", readScheduleInput({ ...good, title: "Hi", text: "   " }, spaces, now), { ok: false, problem: "empty" });
  is("too many links is refused, as for a post now", readScheduleInput({ ...good, text: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`).join(" ") }, spaces, now), { ok: false, problem: "links" });
  is("a zone that is not one is refused", readScheduleInput({ ...good, tz: "Mars/Olympus" }, spaces, now), { ok: false, problem: "when" });
  is("words for a date are refused", readScheduleInput({ ...good, date: "next Tuesday" }, spaces, now), { ok: false, problem: "when" });
  is("an hour that is not one is refused", readScheduleInput({ ...good, time: "25:00" }, spaces, now), { ok: false, problem: "when" });
  is("a time skipped when the clocks go forward is refused", readScheduleInput({ ...good, date: "2030-03-10", time: "02:30" }, spaces, now), { ok: false, problem: "no_such_time" });
  const soon = new Date(now + (MIN_LEAD_SECONDS - 60) * 1000);
  const soonParts = { date: soon.toISOString().slice(0, 10), time: soon.toISOString().slice(11, 16), tz: "UTC" };
  is("sooner than the lead is refused", readScheduleInput({ ...good, ...soonParts }, spaces, now), { ok: false, problem: "soon" });
  is("a past time is refused", readScheduleInput({ ...good, date: "2029-12-31", tz: "UTC" }, spaces, now), { ok: false, problem: "soon" });
  is("past the season is refused", readScheduleInput({ ...good, date: "2030-04-15", tz: "UTC" }, spaces, now), { ok: false, problem: "far" });
  is("every refusal has a sentence", Object.values(SCHEDULE_PROBLEMS).every((s) => typeof s === "string" && s.length > 10 && s.endsWith(".")), true);

  part("Scheduling takes room first, then writes; the cap gives the room back");
  redis.clear();
  await claimHandle(OWNER, "sq4shop", "SQ4 Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Sq4000001", subscriptionId: "sub_Sq4000001", active: true, period: paidPeriod() });
  await setCommunity(OWNER, true);
  let shop = (await storeForEmail(OWNER))!;
  const id = shop.community!.id;
  const config = freshConfig(shop.name);
  await saveConfig(id, config);
  const general = config.spaces[0].id;
  const keys = sched.scheduleKeys(id);
  const slot = (one: string) => Number(redis.run(["HGET", dataKey(shop)!, sched.scheduleSlot(one)])) || 0;
  const t0 = Date.now();
  const inputAt = (offsetSeconds: number, extra: Record<string, unknown> = {}) => {
    const r = readScheduleInput(
      { space: general, title: "Week one", text: "Welcome, @nobody, to week one.", kind: "post", email: false, ...(() => { const d = new Date(t0 + offsetSeconds * 1000); return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), tz: "UTC" }; })(), ...extra },
      [{ id: general }],
      t0,
    );
    if (!r.ok) throw new Error(`input refused: ${r.problem}`);
    return r.input;
  };
  const first = await sched.schedulePost(shop, inputAt(3600), t0);
  is("scheduled", first.ok, true);
  const one = first.ok ? first.post : null!;
  is("waiting, untried", [one.state, one.tries, one.post], ["waiting", 0, ""]);
  is("its room taken in its own slot", slot(one.id), rules.recordBytes(one));
  is("in the community's list, at its time", redis.run(["ZSCORE", keys.list, one.id]), String(one.due));
  is("in the job's due list, at its time", redis.run(["ZSCORE", sched.DUE_KEY, sched.dueMember(shop.sid, id, one.id)]), String(one.due));
  is("nothing posted yet", (await feed(id, {})).posts.length, 0);
  for (let i = 1; i < MAX_SCHEDULED_POSTS; i += 1) await sched.schedulePost(shop, inputAt(3600 + i * 60), t0);
  const over = await sched.schedulePost(shop, inputAt(9000), t0);
  is("one past the cap is refused", over, { ok: false, reason: "full" });
  is("the list holds the cap exactly", redis.run(["ZCARD", keys.list]), MAX_SCHEDULED_POSTS);
  const slots = redis.run(["HKEYS", dataKey(shop)!]) as string[];
  is("the refused one's room was given back", slots.filter((s) => s.startsWith("cm:s:") && Number(redis.run(["HGET", dataKey(shop)!, s])) > 0).length, MAX_SCHEDULED_POSTS);

  part("Before its time the job leaves it; at its time it is posted, once");
  const ran0 = await sched.runScheduledPosts(Date.now() + 10_000, (one.due - 60) * 1000);
  is("an hour early: nothing", ran0.posted, 0);
  const ran1 = await sched.runScheduledPosts(Date.now() + 10_000, (one.due + 1) * 1000);
  is("at its time: one posted", ran1.posted, 1);
  const posted = (await feed(id, {})).posts;
  is("in the feed, as the creator's, with its words", posted.map((p) => [p.a, p.title, p.text, p.kind]), [["creator", "Week one", "Welcome, @nobody, to week one.", "post"]]);
  const after = sched.parseRecord(redis.run(["GET", keys.record(one.id)]));
  is("its record says posted, with the post", [after?.state, after?.post], ["posted", posted[0].id]);
  is("off the job's due list", redis.run(["ZSCORE", sched.DUE_KEY, sched.dueMember(shop.sid, id, one.id)]), null);
  const ran2 = await sched.runScheduledPosts(Date.now() + 10_000, (one.due + 1) * 1000);
  is("a second run posts nothing again", [ran2.posted, (await feed(id, {})).posts.length], [0, 1]);

  part("Canceling: the record, both lists and the room go");
  const list0 = await sched.listScheduled(shop, (one.due + 1) * 1000);
  const second = list0.find((p) => p.state === "waiting")!;
  const canceled = await sched.cancelScheduled(shop, second.id, (one.due + 1) * 1000);
  is("canceled", canceled, { ok: true });
  is("record gone", redis.run(["GET", keys.record(second.id)]), null);
  is("out of the list", redis.run(["ZSCORE", keys.list, second.id]), null);
  is("out of the due list", redis.run(["ZSCORE", sched.DUE_KEY, sched.dueMember(shop.sid, id, second.id)]), null);
  is("its room given back", slot(second.id), 0);
  is("canceling again finds nothing", await sched.cancelScheduled(shop, second.id, (one.due + 1) * 1000), { ok: false, reason: "gone" });
  is("a posted one is cleared from the list the same way, and its room given back", [await sched.cancelScheduled(shop, one.id, (one.due + 1) * 1000), slot(one.id)], [{ ok: true }, 0]);

  part("Editing moves it and changes its words; the old time posts nothing");
  const list1 = await sched.listScheduled(shop, t0);
  const third = list1.find((p) => p.state === "waiting")!;
  const later = { ...inputAt(7200, { title: "Week two", text: "Edited words." }) };
  const edited = await sched.editScheduled(shop, third.id, later, t0);
  is("edited", edited, { ok: true });
  is("the due list has the new time", redis.run(["ZSCORE", sched.DUE_KEY, sched.dueMember(shop.sid, id, third.id)]), String(later.due));
  const atOld = await sched.runScheduledPosts(Date.now() + 10_000, (third.due + 1) * 1000);
  is("its old time posts nothing of it", (await feed(id, {})).posts.some((p) => p.title === "Week two"), false);
  is("the other ones due then do go", atOld.posted >= 0, true);
  // Clear what went up meanwhile, so what follows counts from here.
  for (const p of await sched.listScheduled(shop, (later.due - 120) * 1000)) if (p.state !== "waiting") await sched.cancelScheduled(shop, p.id, (later.due - 120) * 1000);
  const atNew = await sched.runScheduledPosts(Date.now() + 10_000, (later.due + 1) * 1000);
  is("at its new time it goes up with the new words", [atNew.posted >= 1, (await feed(id, {})).posts.some((p) => p.title === "Week two" && p.text === "Edited words.")], [true, true]);

  part("Once the job holds it, the studio cannot change or cancel it");
  for (const p of await sched.listScheduled(shop, (later.due + 1) * 1000)) await sched.cancelScheduled(shop, p.id, (later.due + 1) * 1000);
  const held = await sched.schedulePost(shop, inputAt(3600), t0);
  const heldPost = held.ok ? held.post : null!;
  // The job's own claim: the member taken off the due list.
  redis.run(["ZREM", sched.DUE_KEY, sched.dueMember(shop.sid, id, heldPost.id)]);
  is("edit refused while held", await sched.editScheduled(shop, heldPost.id, inputAt(7200), t0), { ok: false, reason: "busy" });
  is("cancel refused while held, before it counts as held up", await sched.cancelScheduled(shop, heldPost.id, (heldPost.due + 60) * 1000), { ok: false, reason: "busy" });
  is("the record is untouched", sched.parseRecord(redis.run(["GET", keys.record(heldPost.id)]))?.state, "waiting");
  is("held up long past its time, it may be cleared", await sched.cancelScheduled(shop, heldPost.id, (heldPost.due + STUCK_SECONDS + 1) * 1000), { ok: true });
  is("and its room is given back", slot(heldPost.id), 0);

  part("Under the rules as they are at its time");
  const gone = await sched.schedulePost(shop, inputAt(3600), t0);
  const goneId = gone.ok ? gone.post : null!;
  const cfgNow = (await readConfig(id))!;
  await saveConfig(id, { ...cfgNow, spaces: [...cfgNow.spaces, { id: "dddddddddddd", name: "Extra", about: "", creatorOnly: false, only: [], level: 0 }] });
  const inExtra = await sched.schedulePost(shop, { ...inputAt(3600), sp: "dddddddddddd" }, t0);
  const extraId = inExtra.ok ? inExtra.post : null!;
  await saveConfig(id, cfgNow);
  const before = (await feed(id, {})).posts.length;
  await sched.runScheduledPosts(Date.now() + 10_000, (goneId.due + 1) * 1000);
  const extraAfter = sched.parseRecord(redis.run(["GET", keys.record(extraId.id)]));
  is("a space removed since: not posted, said why", [extraAfter?.state, extraAfter?.why], ["failed", "space"]);
  is("only the other one went up", (await feed(id, {})).posts.length, before + 1);

  part("A store that is not there any more");
  for (const p of await sched.listScheduled(shop, (goneId.due + 1) * 1000)) await sched.cancelScheduled(shop, p.id, (goneId.due + 1) * 1000);
  const orphan = await sched.schedulePost(shop, inputAt(3600), t0);
  const orphanPost = orphan.ok ? orphan.post : null!;
  redis.run(["ZREM", sched.DUE_KEY, sched.dueMember(shop.sid, id, orphanPost.id)]);
  redis.run(["ZADD", sched.DUE_KEY, String(orphanPost.due), sched.dueMember("f".repeat(32), id, orphanPost.id)]);
  const ranGone = await sched.runScheduledPosts(Date.now() + 10_000, (orphanPost.due + 1) * 1000);
  is("not posted", [ranGone.posted, (await feed(id, {})).posts.length], [0, before + 1]);
  is("its record says failed: gone", sched.parseRecord(redis.run(["GET", keys.record(orphanPost.id)]))?.why, "gone");

  part("A try the job cannot confirm is never made again");
  await sched.cancelScheduled(shop, orphanPost.id, (orphanPost.due + 1) * 1000);
  const unsure = await sched.schedulePost(shop, inputAt(3600), t0);
  const unsurePost = unsure.ok ? unsure.post : null!;
  const realPipeline = redis.pipeline.bind(redis);
  // The post's own write fails: whether it landed is not known.
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "SET" && String(c[1]).startsWith(`nl:cm:${id}:p:`))) throw new Error("synthetic: the connection dropped");
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  const ranUnsure = await sched.runScheduledPosts(Date.now() + 10_000, (unsurePost.due + 1) * 1000);
  redis.pipeline = realPipeline;
  const unsureAfter = sched.parseRecord(redis.run(["GET", keys.record(unsurePost.id)]));
  is("said unknown, not posted, not failed", [ranUnsure.unknown, unsureAfter?.state], [1, "unknown"]);
  is("not on the due list again", redis.run(["ZSCORE", sched.DUE_KEY, sched.dueMember(shop.sid, id, unsurePost.id)]), null);
  const ranAgain = await sched.runScheduledPosts(Date.now() + 10_000, (unsurePost.due + 3600) * 1000);
  is("a later run makes no second try", [ranAgain.posted, ranAgain.unknown], [0, 0]);
  is("the creator is told in words", rules.stateWords(unsureAfter!, unsurePost.due + 60).includes("could not confirm"), true);

  part("A read that fails before anything is written is tried again, a bounded number of times");
  await sched.cancelScheduled(shop, unsurePost.id, (unsurePost.due + STUCK_SECONDS + 1) * 1000);
  const retry = await sched.schedulePost(shop, inputAt(3600), t0);
  const retryPost = retry.ok ? retry.post : null!;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:store:id:"))) throw new Error("synthetic: the store could not be read");
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  let at = retryPost.due + 1;
  const tries: string[] = [];
  for (let i = 0; i < PUBLISH_TRIES + 1; i += 1) {
    await sched.runScheduledPosts(Date.now() + 10_000, at * 1000);
    const r = sched.parseRecord(redis.run(["GET", keys.record(retryPost.id)]));
    tries.push(`${r?.state}:${r?.tries}`);
    at += RETRY_SECONDS + 1;
  }
  redis.pipeline = realPipeline;
  is("waiting again after each try, then failed once they are used", tries, [...Array.from({ length: PUBLISH_TRIES - 1 }, (_, i) => `waiting:${i + 1}`), `failed:${PUBLISH_TRIES}`, `failed:${PUBLISH_TRIES}`]);

  part("An announcement's email is asked for only when it goes up");
  for (const p of await sched.listScheduled(shop, at * 1000)) await sched.cancelScheduled(shop, p.id, (at + STUCK_SECONDS) * 1000);
  const ann = await sched.schedulePost(shop, inputAt(3600, { kind: "announcement", email: true, title: "News" }), t0);
  const annPost = ann.ok ? ann.post : null!;
  is("nothing queued at scheduling", redis.run(["SCARD", "nl:cm:mailq"]), 0);
  await sched.runScheduledPosts(Date.now() + 10_000, (annPost.due + 1) * 1000);
  const annAfter = sched.parseRecord(redis.run(["GET", keys.record(annPost.id)]));
  // This synthetic store has no email set up (lib/mail.ts canWrite), which the posting asks about then, not before.
  is("posted as an announcement; its email refused by the plan as it is now, and said so", [annAfter?.state, annAfter?.kind, annAfter?.mail], ["posted", "announcement", "plan"]);
  is("the creator is told it was not emailed, and why", rules.stateWords(annAfter!, annPost.due + 60), "Posted. It was not emailed: your plan does not send community emails right now.");
  is("nobody asking is said too", rules.stateWords({ ...annAfter!, mail: "empty" }, annPost.due + 60).includes("nobody has asked"), true);
  is("an email started is said as going out, never as delivered", rules.stateWords({ ...annAfter!, mail: "queued" }, annPost.due + 60).includes("is going out"), true);

  part("The list: soonest first; posted ones go after a week, with their room");
  shop = (await storeForEmail(OWNER))!;
  const listNow = await sched.listScheduled(shop, (annPost.due + 60) * 1000);
  is("the posted announcement is listed", listNow.some((p) => p.id === annPost.id), true);
  const listLater = await sched.listScheduled(shop, (annPost.due + POSTED_KEEP_SECONDS + 60) * 1000);
  is("a week on, it is gone from the list", listLater.some((p) => p.id === annPost.id), false);
  is("and its record and room with it", [redis.run(["GET", keys.record(annPost.id)]), slot(annPost.id)], [null, 0]);

  part("The route: the owner only, paid before anything is read, emailing as sending");
  const route = read("app/api/store/community/schedule/route.ts");
  const order = (a: string, b: string) => route.indexOf(a) >= 0 && route.indexOf(b) > route.indexOf(a);
  is("taking one off is named \"delete\" to the guard, which a locked session may not do", route.includes('text(body.action, 20) === "cancel" ? "delete"'), true);
  is("an email to members asks for the sending permission", route.includes('body.email === true && text(body.action, 20) !== "cancel" ? "send" : "community"'), true);
  is("only the store's owner posts as the creator", route.includes('role !== "owner"'), true);
  is("the owner check comes before the charge", order('role !== "owner"', "takeAllowance("), true);
  is("scheduling takes every unit at once", route.includes('takeAllowance(store, "studio", SCHEDULE_UNITS)'), true);
  is("an edit takes one", route.includes('takeAllowance(store, "studio", 1)'), true);
  is("the charge comes before the community is read", order("takeAllowance(", "readConfig("), true);
  is("a paid store's resource window is reserved too", route.includes("reservePaidResourceWindow(store)"), true);
  is("the five-minute job runs it", read("app/api/cron/imports/route.ts").includes("runScheduledPosts("), true);
  is("the studio shows it to the owner only", read("app/studio/community/page.tsx").includes('view.role === "owner" ? <CommunitySchedule'), true);
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
