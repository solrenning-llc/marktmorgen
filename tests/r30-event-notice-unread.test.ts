/**
 * Rule 30 (review of #2921), synthetic only: the email telling everyone coming that an event moved or was called
 * off is never lost because who is coming did not read at that moment.
 *
 * rsvpList (lib/community-events.ts) is everyone or throws UnknownReplyError. The studio's route
 * (app/api/store/community/events/route.ts) writes the move or the cancellation first and then starts its notice
 * (queueEventNotice). With the list unread, startJob gave its claim back and threw, so the route answered 500 after
 * the event was already moved or canceled; nothing tried the notice again, and a canceled event cannot be canceled
 * twice. Nobody coming was ever told.
 *
 * Now the notice is written down, waiting for its list, in the same send queue the five-minute job moves on
 * (runEventQueue, advanceEventJob). The route answers that the change was made and that anyone coming is being
 * emailed. When the list reads, the notice goes once to everyone coming, under the store's own email figure, and
 * never twice. It waits only while it is of use: like the hour-before reminder, not past the event's start. A move's
 * notice still waiting when the event is then canceled gives way to the cancellation's; each move is still its own
 * email.
 */
import { NextRequest } from "next/server";
import { afterTasks } from "./next-server-after-world";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { freshConfig, saveConfig, touchMember } from "@/lib/community";
import { createEvent } from "@/lib/community-events";
import { runEventQueue } from "@/lib/community-event-mail";
import { claimHandle, ensureStatsId, setCommunity, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { POST as events } from "@/app/api/store/community/events/route";
import { store as redis } from "./redis-stub";
import { allowanceUsed } from "@/lib/store-allowance";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

type Commands = (string | number)[][];
const ORIGIN = "https://marktmorgen.com";
const OWNER = "notice-owner@example.com";
const GOING = ["ann@example.com", "bo@example.com"];
const mail = installSesMailFixture();
const original = redis.pipeline.bind(redis);
const realNow = Date.now.bind(Date);

/** Every HSCAN of an RSVP list answers "QUEUED" (not a page) while `on`. */
function unread(on: boolean): void {
  redis.pipeline = (on
    ? (async (commands: Commands) => {
        if (commands.length === 1 && commands[0][0] === "HSCAN" && /^nl:cm:[0-9a-f]{32}:ev:[0-9a-f]{12}:r$/.test(String(commands[0][1]))) return ["QUEUED"];
        return original(commands);
      })
    : original) as typeof redis.pipeline;
}

/** What the route answered, as status, ok and the notice it says. */
async function answer(response: Response): Promise<[number, boolean, string]> {
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; notice?: string; error?: string };
  return [response.status, body.ok === true, body.notice ?? body.error ?? ""];
}

/** Who got an email whose subject is `subject`, sorted, one entry per email. */
const to = (subject: string) => mail.sent.filter((m) => m.subject === subject).flatMap((m) => m.to).sort();

/** The work the route left for after its answer, run now (there is no request scope in a test). */
async function runAfter(): Promise<void> {
  const tasks = afterTasks.splice(0);
  for (const task of tasks) await (task as () => Promise<unknown>)();
}

/** One run of the five-minute job's event part. */
async function job(): Promise<void> {
  await runEventQueue(storeForHandle, Date.now() + 20_000, { mail: true });
}

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  await claimHandle(OWNER, "noticeproof", "Notice proof", "A community.");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  await saveConfig(id, freshConfig(store.name));
  const session = await openSession(OWNER);
  const members = await Promise.all(GOING.map((email) => touchMember(id, email, null, store)));
  const post = (body: Record<string, unknown>) =>
    events(new NextRequest(`${ORIGIN}/api/store/community/events`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));

  const DAY = 86_400_000;
  /** An event with both members coming, `title` its own so its emails are told apart. */
  async function event(title: string, start: number): Promise<{ id: string; when: (start: number) => Record<string, unknown> }> {
    const made = await createEvent(store, { title, about: "A synthetic call.", minutes: 60, tz: "UTC", where: "room", link: "", meet: null, only: [], start, cap: 0 });
    if (!made.ok) throw new Error("no synthetic event");
    await original([["HSET", `nl:cm:${id}:ev:${made.event.id}:r`, members[0]!.k, "100", members[1]!.k, "200"]]);
    const when = (at: number) => {
      const iso = new Date(at).toISOString();
      return { action: "edit", event: made.event.id, title, about: "A synthetic call.", date: iso.slice(0, 10), time: iso.slice(11, 16), tz: "UTC", minutes: 60, where: "room", cap: "" };
    };
    return { id: made.event.id, when };
  }
  const hour = (at: number) => Math.floor(at / 3_600_000) * 3_600_000;

  part("Control: with the list read, a move is emailed once to everyone coming");
  const control = await event("Control night", hour(realNow() + 3 * DAY));
  is("the move is made", await answer(await post(control.when(hour(realNow() + 4 * DAY)))), [200, true, ""]);
  await runAfter();
  await job();
  is("each of them got the move once", to("New time: Control night"), GOING);

  part("A move whose list does not read: made, answered, and emailed once when the list reads");
  const moved = await event("Moved night", hour(realNow() + 3 * DAY));
  unread(true);
  is("the route says it moved, and that the notice waits for who is coming", await answer(await post(moved.when(hour(realNow() + 5 * DAY)))), [200, true, "waiting"]);
  await runAfter();
  await job();
  is("nothing is sent while the list still does not read", to("New time: Moved night"), []);
  unread(false);
  await job();
  is("the next run, with the list read, emails each of them once", to("New time: Moved night"), GOING);
  await job();
  await job();
  is("and never again", to("New time: Moved night"), GOING);

  part("A cancellation whose list does not read: made, answered, and emailed once when the list reads");
  const canceled = await event("Canceled night", hour(realNow() + 3 * DAY));
  unread(true);
  is("the route says it is canceled, and that the notice waits", await answer(await post({ action: "cancel", event: canceled.id })), [200, true, "waiting"]);
  await runAfter();
  is("it cannot be canceled twice", await answer(await post({ action: "cancel", event: canceled.id })), [409, false, "cancelled"]);
  is("it cannot be deleted while everyone coming is still to be told", await answer(await post({ action: "delete", event: canceled.id })), [409, false, "telling"]);
  await job();
  is("nothing is sent while the list still does not read", to("Canceled: Canceled night"), []);
  unread(false);
  await job();
  is("the next run emails each of them once", to("Canceled: Canceled night"), GOING);
  await job();
  is("and never again", to("Canceled: Canceled night"), GOING);
  is("and then it can be deleted", await answer(await post({ action: "delete", event: canceled.id })), [200, true, ""]);

  part("Superseded while waiting: each move is its own email; a cancellation takes the place of a waiting move");
  const twice = await event("Twice night", hour(realNow() + 3 * DAY));
  unread(true);
  is("moved once", await answer(await post(twice.when(hour(realNow() + 4 * DAY)))), [200, true, "waiting"]);
  is("moved again", await answer(await post(twice.when(hour(realNow() + 5 * DAY)))), [200, true, "waiting"]);
  await runAfter();
  unread(false);
  await job();
  is("each move reaches each of them once", to("New time: Twice night"), [GOING[0], GOING[0], GOING[1], GOING[1]]);
  const off = await event("Off night", hour(realNow() + 3 * DAY));
  unread(true);
  is("moved", await answer(await post(off.when(hour(realNow() + 4 * DAY)))), [200, true, "waiting"]);
  is("then canceled", await answer(await post({ action: "cancel", event: off.id })), [200, true, "waiting"]);
  await runAfter();
  unread(false);
  await job();
  is("the waiting move is not sent for an event called off", to("New time: Off night"), []);
  is("the cancellation is, once to each", to("Canceled: Off night"), GOING);

  part("A notice that cannot even be written down: the change is still answered as made, never 500, and says so");
  const unwritten = await event("Unwritten night", hour(realNow() + 3 * DAY));
  redis.pipeline = (async (commands: Commands) => {
    if (commands.length === 1 && commands[0][0] === "HSCAN" && String(commands[0][1]).endsWith(":r")) return ["QUEUED"];
    if (commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:cm:evmail:") && commands[1]?.[0] === "SADD") throw new Error("synthetic pipeline failure");
    return original(commands);
  }) as typeof redis.pipeline;
  is("the route says it is canceled, and that its email could not be started", await answer(await post({ action: "cancel", event: unwritten.id })), [200, true, "failed"]);
  unread(false);
  is("and it is canceled", ((await original([["GET", `nl:cm:${id}:ev:${unwritten.id}`]]))[0] as string).includes('"cancelled":true'), true);

  part("Inside the store's own email figure: every email sent was counted against it, and none went without it");
  is("twelve emails, each counted", [mail.sent.length, await allowanceUsed((await storeForEmail(OWNER))!, "email")], [12, 12]);

  part("A waiting notice whose list then reads but is not written down whole stays waiting, and is still sent (Claude 2's focal on #3134)");
  const loose = await event("Loose night", hour(realNow() + 3 * DAY));
  unread(true);
  is("canceled, and its notice waits", await answer(await post({ action: "cancel", event: loose.id })), [200, true, "waiting"]);
  await runAfter();
  unread(false);
  // On the run where the list reads, the push of the people to the send's own list answers nothing and does not land.
  let dropped = 0;
  redis.pipeline = (async (commands: Commands) => {
    const at = commands.findIndex((c) => c[0] === "RPUSH" && /^nl:cm:evmail:[0-9a-f]{24}:to$/.test(String(c[1])));
    if (at < 0) return original(commands);
    dropped += 1;
    const rest = await original(commands.filter((_, i) => i !== at));
    return [...rest.slice(0, at), null, ...rest.slice(at)];
  }) as typeof redis.pipeline;
  await job();
  redis.pipeline = original;
  is("the push was tried and did not land", dropped > 0, true);
  is("nothing is sent on that run", to("Canceled: Loose night"), []);
  await job();
  is("the next run writes the list again and emails each of them once", to("Canceled: Loose night"), GOING);
  await job();
  is("and never again", to("Canceled: Loose night"), GOING);

  part("Only while it is of use: a notice whose list never read before the start is not sent late");
  const late = await event("Late night", hour(realNow() + 3 * DAY));
  unread(true);
  is("moved", await answer(await post(late.when(hour(realNow() + 2 * DAY)))), [200, true, "waiting"]);
  await runAfter();
  await job();
  unread(false);
  Date.now = () => realNow() + 3 * DAY;
  await job();
  Date.now = realNow;
  is("once its start has passed, it is not sent", to("New time: Late night"), []);
  const [left] = await original([["SMEMBERS", "nl:cm:evmailq"]]);
  is("and no send is left under way", left, []);

  done();
}

void main();
