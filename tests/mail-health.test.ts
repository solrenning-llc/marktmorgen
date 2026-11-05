/**
 * A store with a bad list is stopped by itself, before it costs every other
 * store its email (lib/mail-health.ts).
 *
 * Every store sends through one account at the sender, which judges the
 * account as a whole: past 4% bounced or 0.08% marked as spam it "may be shut
 * down without warning" (resend.com/legal/acceptable-use, read October 6,
 * 2026), and that account also sends every login link. These check that an
 * address the sender gives up on is never written to again, that a store is
 * paused inside those lines and not for a handful of typos, that nothing
 * waiting is lost, and that it all goes on again without anybody pressing
 * anything.
 */
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/mail/inbound/route";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { importContacts, isMailable, listCounts, stopWriting, upsertContact } from "@/lib/contacts";
import { advanceBroadcast, createBroadcast } from "@/lib/broadcasts";
import { sendBatch, sendEmail } from "@/lib/email";
import { sendTo, usedThisMonth } from "@/lib/mail";
import { LIST_TAG, PORTION_NOTE, STORE_TAG, healthId, heardFromSender, listHealth, noteSent, overTheLine, pauseEnds, pauseWords, pausedFor, pauseForSending, rampBack, rampRoom, startRamp } from "@/lib/mail-health";
import { BOUNCE_FLOOR, COMPLAINT_FLOOR, PAUSE_DAYS, RAMP_FIRST, RAMP_GAP_MINUTES, RAMP_TRIGGER, healthRuleWords, rampPortions, rampRuleWords } from "@/lib/mail-health-rules";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const OWNER = "owner@example.com";
const SECRET_BYTES = Buffer.from("a-stand-in-secret-for-tests-only");
let refuseTags = false;
const mail = installSesMailFixture({
  onResend: (messages) => refuseTags && messages.some((message) => message.tags)
    ? new Response(JSON.stringify({ name: "validation_error" }), { status: 422 })
    : undefined,
});
const listMessages = () => mail.sent.filter((message) =>
  message.provider === "ses"
    ? message.tags?.some((tag) => tag.name === STORE_TAG || tag.name === LIST_TAG)
    : message.batch
).map((message) => [message]);
const serviceMessages = () => mail.sent.filter((message) =>
  message.provider === "ses"
    ? !message.tags?.some((tag) => tag.name === STORE_TAG || tag.name === LIST_TAG)
    : !message.batch
);

let announced = 0;
/** What the sender posts when an email bounced or was marked as spam, signed as it signs them. */
function announce(type: string, data: Record<string, unknown>, opts: { id?: string; secret?: Buffer } = {}): NextRequest {
  announced += 1;
  const id = opts.id ?? `msg_${announced}`;
  const at = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type, created_at: "2026-10-06T00:00:00.000Z", data });
  const signature = createHmac("sha256", opts.secret ?? SECRET_BYTES).update(`${id}.${at}.${body}`).digest("base64");
  return new NextRequest("https://marktmorgen.com/api/mail/inbound", {
    method: "POST",
    headers: { host: "marktmorgen.com", "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "svix-id": id, "svix-timestamp": at, "svix-signature": `v1,${signature}` },
    body,
  });
}

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.RESEND_API_KEY = "re_test_health_only_a_stand_in";
  delete process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.RESEND_INBOUND_API_KEY;
  delete process.env.SUPPORT_FORWARD_TO;

  part("Where the lines are");
  is("no email sent, no line crossed", overTheLine({ sent: 0, bounced: 40, complained: 9 }), null);
  is("one mistyped address in thirty is nobody's bad list", overTheLine({ sent: 30, bounced: 1, complained: 0 }), null);
  is("twenty-four bounces are still under the floor, whatever the share", overTheLine({ sent: 100, bounced: BOUNCE_FLOOR - 1, complained: 0 }), null);
  is("twenty-five of a thousand is 2.5%: over", overTheLine({ sent: 1_000, bounced: 25, complained: 0 }), { reason: "bounces", count: 25 });
  is("twenty-five of two thousand is 1.25%: a large list with a few dead addresses is left alone", overTheLine({ sent: 2_000, bounced: 25, complained: 0 }), null);
  is("four spam reports are under the floor", overTheLine({ sent: 500, bounced: 0, complained: COMPLAINT_FLOOR - 1 }), null);
  is("five in five thousand is 0.1%: over", overTheLine({ sent: 5_000, bounced: 0, complained: 5 }), { reason: "complaints", count: 5 });
  is("five in ten thousand is 0.05%: under the sender's own line", overTheLine({ sent: 10_000, bounced: 0, complained: 5 }), null);
  is("the published sentence carries the same numbers", healthRuleWords(), "If, over 7 days, 25 or more of a store's emails and 2% or more of them go to addresses that do not exist, or 5 or more and 0.08% or more are reported as spam, email to that store's list pauses for 7 days and then goes on by itself.");

  part("A list email says whose it is");
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const id = healthId(store);
  for (let i = 0; i < 40; i += 1) await upsertContact(list, `reader${i}@example.com`, { agreed: true, explicit: true, source: "import" }, ROOM);
  is("a store is counted under its own id", [id === store.sid, /^[0-9a-f]{32}$/.test(id)], [true, true]);

  const first = await sendTo(store, ["reader0@example.com", "reader1@example.com"], "Hello", "It is ready.", "t:1");
  is("it went", [first.stopped, first.done.length], [null, 2]);
  is("carrying the store and the list, as tags the reader never sees", listMessages()[0][0].tags, [{ name: STORE_TAG, value: id }, { name: LIST_TAG, value: list }]);
  is("and what was sent is counted for the store", (await listHealth(id)).sent, 2);


  part("A sender that will not take the tags still sends the email");
  refuseTags = true;
  mail.clearCaptured();
  const plain = await sendBatch([{
    from: "Harbor Kitchen <hello@marktmorgen.com>",
    to: "reader38@example.com",
    subject: "Hello",
    text: "It is ready.",
    html: "<p>It is ready.</p>",
    tags: { [STORE_TAG]: id, [LIST_TAG]: list },
  }], "t:plain", { by: "company" }, "resend");
  refuseTags = false;
  is("the Resend-specific retry goes all the same", plain, "sent");
  is("the tagged request is refused and one untagged retry is accepted", [
    mail.resendAttempts.length,
    mail.resendAttempts[0]?.tags,
    mail.resendAttempts[1]?.tags,
    mail.sent.length,
    listMessages().length,
  ], [2, [{ name: STORE_TAG, value: id }, { name: LIST_TAG, value: list }], undefined, 1, 1]);

  part("Only the sender is believed");
  const bounced = (to: string, extra: Record<string, unknown> = {}) => ({ email_id: "e1", to: [to], subject: "Hello", bounce: { type: "Permanent", subType: "General", message: "no such user" }, tags: { [STORE_TAG]: id, [LIST_TAG]: list }, ...extra });
  is("with no signing secret set, there is nothing here", (await POST(announce("email.bounced", bounced("reader0@example.com")))).status, 404);
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
  is("signed with another secret: refused", (await POST(announce("email.bounced", bounced("reader0@example.com"), { secret: Buffer.from("another-secret-another-secret") }))).status, 401);
  is("and nobody was taken off for it", await isMailable(list, "reader0@example.com"), true);

  part("An address that bounced for good is not written to again");
  const heard = await POST(announce("email.bounced", bounced("Reader0@Example.com"), { id: "msg_same" }));
  is("heard, without the settings that receiving mail needs", [heard.status, await heard.json()], [200, { ok: true, result: "counted" }]);
  is("off the list", await isMailable(list, "reader0@example.com"), false);
  is("counted with those who left", (await listCounts(list)).left, 1);
  is("and counted once for the store", (await listHealth(id)).bounced, 1);
  await POST(announce("email.bounced", bounced("reader0@example.com"), { id: "msg_same" }));
  is("the same announcement again changes nothing", (await listHealth(id)).bounced, 1);
  const again = await POST(announce("email.bounced", bounced("reader0@example.com")));
  is("nor does the same address bouncing a second time", [(await again.json()).result, (await listHealth(id)).bounced], ["ignored", 1]);
  await importContacts(list, ["reader0@example.com"], ROOM);
  is("an import does not bring it back", await isMailable(list, "reader0@example.com"), false);
  const later = await sendTo(store, ["reader0@example.com", "reader2@example.com"], "Hello again", "Still ready.", "t:2");
  is("the next email leaves it out", later.done, ["reader2@example.com"]);
  await upsertContact(list, "reader0@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  is("only that person's own yes, given since, puts them back", await isMailable(list, "reader0@example.com"), true);

  part("What is not a bad address");
  const soft = await POST(announce("email.bounced", bounced("reader3@example.com", { bounce: { type: "Transient", subType: "MailboxFull", message: "full" } })));
  is("a full mailbox may yet deliver: left alone", [(await soft.json()).result, await isMailable(list, "reader3@example.com")], ["ignored", true]);
  const untagged = await POST(announce("email.bounced", { to: ["reader3@example.com"], bounce: { type: "Permanent" }, tags: {} }));
  is("a login link to a mistyped address is nobody's bad list", [(await untagged.json()).result, (await listHealth(id)).bounced], ["ignored", 1]);
  const forged = await POST(announce("email.bounced", bounced("reader3@example.com", { tags: { [STORE_TAG]: "../../etc", [LIST_TAG]: "nl:store:leads" } })));
  is("a tag that is not an id is not followed anywhere", [(await forged.json()).result, await isMailable(list, "reader3@example.com")], ["ignored", true]);
  is("an announcement of something else is acknowledged and left", (await (await POST(announce("email.delivered", bounced("reader3@example.com")))).json()), { ok: true });

  part("Marked as spam is leaving");
  const spam = await POST(announce("email.complained", { to: ["reader4@example.com"], tags: [{ name: STORE_TAG, value: id }, { name: LIST_TAG, value: list }] }));
  is("heard, in the other shape tags are written in", (await spam.json()).result, "counted");
  is("off the list, and counted apart from bounces", [await isMailable(list, "reader4@example.com"), (await listHealth(id)).complained, (await listHealth(id)).bounced], [false, 1, 1]);
  is("their own unsubscribe, already made, is not counted as anything", await stopWriting(list, "reader4@example.com", "bounced"), false);

  part("A handful of bad addresses pauses nobody");
  is("not paused", await pausedFor(id), null);
  await noteSent(id, 1_000);
  // Twenty-three more, each a different address the list holds: 24 in all.
  for (let i = 5; i < 28; i += 1) await heardFromSender({ kind: "bounced", permanent: true, to: `reader${i}@example.com`, store: id, list });
  is("twenty-four bounces of a thousand: still sending", [(await listHealth(id)).bounced, await pausedFor(id)], [BOUNCE_FLOOR - 1, null]);

  part("One more, and the store waits by itself");
  const tipped = await heardFromSender({ kind: "bounced", permanent: true, to: "reader28@example.com", store: id, list });
  const pause = await pausedFor(id);
  is("paused, for bounces", [tipped, pause?.reason, pause?.count], ["paused", "bounces", BOUNCE_FLOOR]);
  is("for seven days", Math.round(((pause?.until ?? 0) * 1000 - Date.now()) / 86_400_000), PAUSE_DAYS);
  is("said in words a creator can read", pauseWords(pause!).startsWith(`Email to your list is paused until ${pauseEnds(pause!)}: 25 of the 1,00`), true);
  const usedBefore = await usedThisMonth(list);
  mail.clearCaptured();
  const held = await sendTo(store, ["reader30@example.com", "reader31@example.com"], "Hello", "It is ready.", "t:3");
  is("a list email is held, whole", [held.stopped, held.done, held.rest.length, listMessages().length], ["paused", [], 2, 0]);
  is("and nothing is taken from the store's month for it", await usedThisMonth(list), usedBefore);
  const another = await heardFromSender({ kind: "bounced", permanent: true, to: "reader29@example.com", store: id, list });
  is("a bounce that arrives meanwhile is counted, and the pause keeps its own end", [another, (await pausedFor(id))?.until === pause?.until], ["counted", true]);

  part("What a store cannot run without still goes");
  mail.clearCaptured();
  is("a login link is sent all the same", [await sendEmail({ meter: { by: "company" }, from: "Marktmorgen <hello@marktmorgen.com>", to: "buyer@example.com", subject: "Your login link", text: "Here." }), serviceMessages().length], [true, 1]);

  part("A broadcast waits, and goes on by itself");
  const created = await createBroadcast(store, { subject: "The plan is here", body: "It is ready.", productId: "", notProductId: "", sendAt: undefined });
  if (!created.ok) throw new Error(`no broadcast: ${created.reason}`);
  const total = created.broadcast.total;
  mail.clearCaptured();
  let b = (await advanceBroadcast(created.broadcast.id, storeForHandle, Date.now() + 30_000))!;
  is("it waits, and says until when", [b.status, b.note.startsWith(`Paused until ${pauseEnds(pause!)}`)], ["waiting", true]);
  is("nobody was written to, and nobody was dropped", [b.sent, b.total, listMessages().length], [0, total, 0]);
  is("the bad addresses are not among those it will go to", total, (await listCounts(list)).mailable);
  // The week passes.
  advance((PAUSE_DAYS * 86_400 + 60) * 1000);
  is("after seven days the pause is over", await pausedFor(id), null);
  b = (await advanceBroadcast(created.broadcast.id, storeForHandle, Date.now() + 30_000))!;
  is("and it finishes without anyone pressing anything", [b.status, b.sent, b.note], ["sent", total, ""]);
  const got = new Set(listMessages().flat().map((m) => m.to[0]));
  is("to everyone still on the list, once", [got.size, got.has("reader28@example.com"), got.has("reader30@example.com")], [total, false, true]);

  part("Too many spam reports do the same");
  redis.clear();
  const other = "b".repeat(32);
  await noteSent(other, 5_000);
  let told = "";
  for (let i = 0; i < COMPLAINT_FLOOR; i += 1) told = await heardFromSender({ kind: "complained", permanent: false, to: `r${i}@example.com`, store: other, list: "" });
  is("five in five thousand", [told, (await pausedFor(other))?.reason], ["paused", "complaints"]);
  is("one store's pause is not another's", await pausedFor("c".repeat(32)), null);
  is("and when its week is over it starts again with a hundred people, not everyone", await rampRoom(other, 5_000), RAMP_FIRST);

  part("Addresses brought in from elsewhere go out in portions that double");
  redis.clear();
  const realNow = Date.now;
  let ahead = 0;
  Date.now = () => realNow() + ahead;
  const quarter = RAMP_GAP_MINUTES * 60_000 + 1_000;
  const fresh = "d".repeat(32);
  is("a store that brought nothing in sends everything at once", await rampRoom(fresh, 5_000), 5_000);
  await startRamp(fresh, RAMP_TRIGGER - 1);
  is("a few people added by hand start nothing", await rampRoom(fresh, 5_000), 5_000);
  await startRamp(fresh, 50_000);
  is("after a file is brought in: a hundred first", await rampRoom(fresh, 5_000), 100);
  is("and then nobody, until the next portion opens", await rampRoom(fresh, 5_000), 0);
  ahead += quarter;
  is("a quarter of an hour later: two hundred, taken as they are asked for", [await rampRoom(fresh, 150), await rampRoom(fresh, 150), await rampRoom(fresh, 150)], [150, 50, 0]);
  await rampBack(fresh, 50);
  is("a batch that did not go out is given back to its portion", await rampRoom(fresh, 150), 50);
  const sizes: number[] = [];
  for (;;) {
    ahead += quarter;
    const got = await rampRoom(fresh, 1_000_000);
    sizes.push(got);
    if (got === 1_000_000) break;
  }
  is("doubling each time, and after the last portion everything at once again", sizes, [400, 800, 1_600, 3_200, 6_400, 1_000_000]);
  is("which is seven portions in all, as the published sentence says", [rampPortions(), rampRuleWords().includes("about 1 hour 45 minutes at most")], [7, true]);

  part("A broadcast to a list just brought in");
  const second = await claimHandle("second@example.com", "orchard", "Orchard Bakes", "");
  if (!second.ok) throw new Error("no second store");
  await ensureStatsId("second@example.com");
  await ensureListId("second@example.com");
  await setSubscription("second@example.com", { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings("second@example.com", { fromName: "Orchard Bakes", address: "2 Main St, Portland, OR 97201" });
  const orchard = (await storeForEmail("second@example.com"))!;
  const brought = Array.from({ length: 450 }, (_, i) => `old${i}@example.com`);
  const result = await importContacts(orchard.listId as string, brought, ROOM);
  await startRamp(healthId(orchard), result.added);
  const news = await createBroadcast(orchard, { subject: "We moved", body: "Hello from the new place.", productId: "", notProductId: "", sendAt: undefined });
  if (!news.ok) throw new Error(`no broadcast: ${news.reason}`);
  mail.clearCaptured();
  let n = (await advanceBroadcast(news.broadcast.id, storeForHandle, Date.now() + 30_000))!;
  is("the first hundred go, and the rest wait with the reason", [n.status, n.sent, n.total, n.note === PORTION_NOTE], ["waiting", 100, 450, true]);
  n = (await advanceBroadcast(news.broadcast.id, storeForHandle, Date.now() + 30_000))!;
  is("pressing on before the quarter hour sends nobody else", [n.sent, listMessages().flat().length], [100, 100]);
  // Thirty of that first hundred turn out to be dead: 30%, over both the floor and the share.
  const firstHundred = listMessages().flat().map((m) => m.to[0]);
  const said: string[] = [];
  for (const to of firstHundred.slice(0, 30)) said.push(await heardFromSender({ kind: "bounced", permanent: true, to, store: healthId(orchard), list: orchard.listId as string }));
  is("the store is paused at the twenty-fifth, with a hundred written to and not four hundred and fifty", [said.indexOf("paused"), (await pausedFor(healthId(orchard)))?.count, listMessages().flat().length], [24, 25, 100]);
  is("what comes in late from the same emails is not held against it when its week is over", (await listHealth(healthId(orchard), Date.now() + 86_400_000)).bounced, 0);
  ahead += quarter;
  n = (await advanceBroadcast(news.broadcast.id, storeForHandle, Date.now() + 30_000))!;
  is("the next portion does not open over a pause", [n.status, n.sent, n.note.startsWith("Paused until")], ["waiting", 100, true]);

  part("A good list is through it by itself");
  redis.clear();
  // The clock is left where it is: sending paces itself by it (lib/mail.ts).
  const third = await claimHandle("third@example.com", "meadow", "Meadow Yoga", "");
  if (!third.ok) throw new Error("no third store");
  await ensureStatsId("third@example.com");
  await ensureListId("third@example.com");
  await setSubscription("third@example.com", { customerId: "cus_Owner00003", subscriptionId: "sub_Owner00003", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings("third@example.com", { fromName: "Meadow Yoga", address: "3 Main St, Portland, OR 97201" });
  const meadow = (await storeForEmail("third@example.com"))!;
  const good = await importContacts(meadow.listId as string, Array.from({ length: 450 }, (_, i) => `member${i}@example.com`), ROOM);
  await startRamp(healthId(meadow), good.added);
  const hello = await createBroadcast(meadow, { subject: "Hello", body: "The new timetable.", productId: "", notProductId: "", sendAt: undefined });
  if (!hello.ok) throw new Error(`no broadcast: ${hello.reason}`);
  mail.clearCaptured();
  const steps: number[] = [];
  let h = (await advanceBroadcast(hello.broadcast.id, storeForHandle, Date.now() + 30_000))!;
  steps.push(h.sent);
  while (h.status !== "sent" && steps.length < 6) {
    ahead += quarter;
    h = (await advanceBroadcast(hello.broadcast.id, storeForHandle, Date.now() + 30_000))!;
    steps.push(h.sent);
  }
  is("100, then 200 more, then the rest: nobody pressed anything", [steps, h.status, h.note], [[100, 300, 450], "sent", ""]);
  is("to everyone, once", new Set(listMessages().flat().map((m) => m.to[0])).size, 450);

  part("Unconfirmed health-pause evidence cannot admit list email");
  const originalPipeline = redis.pipeline;
  const pauseKey = `nl:mail:paused:${healthId(meadow)}`;
  const inheritedPause = new Array(1);
  Object.setPrototypeOf(inheritedPause, { 0: null });
  let pauseGetterCalls = 0;
  const computedPause = new Array(1);
  Object.defineProperty(computedPause, "0", { get: () => { pauseGetterCalls += 1; return null; } });
  const validPause = { reason: "bounces" as const, until: Math.floor(Date.now() / 1000) + 600, sent: 1_000, count: 25 };
  const badPauseReads: [string, unknown][] = [
    ["lost reply", new Error("synthetic pause read lost")], ["not an array", {}],
    ["null envelope", null], ["empty", []], ["extra entry", [null, null]],
    ["sparse", new Array(1)], ["inherited absence", inheritedPause], ["computed absence", computedPause],
    ["undefined entry", [undefined]], ["numeric entry", [0]], ["invalid JSON", ["{"]],
    ["JSON null", ["null"]], ["JSON array", ["[]"]], ["missing fields", ["{}"]],
    ["wrong reason", [JSON.stringify({ ...validPause, reason: "other" })]],
    ["string expiration", [JSON.stringify({ ...validPause, until: String(validPause.until) })]],
    ["negative expiration", [JSON.stringify({ ...validPause, until: -1 })]],
    ["fractional count", [JSON.stringify({ ...validPause, count: 0.5 })]],
    ["unsafe count", [JSON.stringify({ ...validPause, count: Number.MAX_SAFE_INTEGER + 1 })]],
    ["missing sent", [JSON.stringify({ reason: "bounces", until: validPause.until, count: 25 })]],
    ["negative sent", [JSON.stringify({ ...validPause, sent: -1 })]],
    ["oversized record", [" ".repeat(513)]],
  ];
  mail.clearCaptured();
  const waitingRecipients = ["member0@example.com"];
  try {
    for (const [name, reply] of badPauseReads) {
      const commandsSeen: (string | number)[][] = [];
      redis.pipeline = async commands => {
        commandsSeen.push(...commands);
        if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === pauseKey) {
          if (reply instanceof Error) throw reply;
          return reply as unknown[];
        }
        return originalPipeline.call(redis, commands);
      };
      is(`${name}: no invented permission or health pause`, await pauseForSending(healthId(meadow)), undefined);
      const held = await sendTo(meadow, waitingRecipients, "Hello", "Still waiting.", `health-read:${name}`);
      is(`${name}: actual list sender waits with every recipient intact`,
        [held.done, held.rest, held.stopped, held.uncertain, held.pause], [[], waitingRecipients, "retry", undefined, undefined]);
      is(`${name}: no extra read, reservation, ramp change or provider work`,
        commandsSeen, [["GET", pauseKey], ["GET", pauseKey]]);
    }
    is("unknown health evidence sent no list batch", listMessages().length, 0);
    is("health evidence getters were never invoked", pauseGetterCalls, 0);
    for (const [name, raw, expected] of [
      ["confirmed absence", null, null],
      ["known current pause", JSON.stringify(validPause), validPause],
      ["known complaint pause", JSON.stringify({ ...validPause, reason: "complaints" }), { ...validPause, reason: "complaints" }],
      ["known expired pause", JSON.stringify({ ...validPause, until: Math.floor(Date.now() / 1000) - 1 }), null],
    ] as const) {
      redis.pipeline = async commands => commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === pauseKey ? [raw] : originalPipeline.call(redis, commands);
      is(`${name}: exact existing state`, await pauseForSending(healthId(meadow)), expected);
    }
    redis.pipeline = async commands => commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === pauseKey ? [] : originalPipeline.call(redis, commands);
    is("the existing display wrapper keeps its nullable contract", await pausedFor(healthId(meadow)), null);
    mail.clearCaptured();
    is("an essential login link is still available while list health is unconfirmed",
      [await sendEmail({ meter: { by: "company" }, from: "Marktmorgen <hello@marktmorgen.com>", to: "buyer@example.com", subject: "Your login link", text: "Hello." }), serviceMessages().length], [true, 1]);
  } finally {
    redis.pipeline = originalPipeline;
  }


  part("Unconfirmed portion reads never release the requested audience");
  const rampPipeline = redis.pipeline;
  const checkedRampKey = `nl:mail:ramp:${healthId(meadow)}`;
  const checkedPauseKey = `nl:mail:paused:${healthId(meadow)}`;
  const validRamp = { size: RAMP_FIRST, left: RAMP_FIRST, opens: 0 };
  const inheritedRamp = new Array(1);
  Object.setPrototypeOf(inheritedRamp, { 0: null });
  let rampGetterCalls = 0;
  const computedRamp = new Array(1);
  Object.defineProperty(computedRamp, "0", { get: () => { rampGetterCalls += 1; return null; } });
  const badRampReads: [string, unknown][] = [
    ["lost reply", new Error("synthetic ramp read lost")], ["not an array", {}], ["null envelope", null],
    ["empty", []], ["extra entry", [null, null]], ["sparse", new Array(1)],
    ["inherited absence", inheritedRamp], ["computed absence", computedRamp],
    ["undefined", [undefined]], ["numeric coercion", [0]], ["invalid JSON", ["{"]],
    ["JSON null", ["null"]], ["JSON array", ["[]"]], ["missing fields", ["{}"]],
    ["string size", [JSON.stringify({ ...validRamp, size: String(RAMP_FIRST) })]],
    ["unknown size", [JSON.stringify({ ...validRamp, size: RAMP_FIRST + 1 })]],
    ["fractional left", [JSON.stringify({ ...validRamp, left: 0.5 })]],
    ["negative left", [JSON.stringify({ ...validRamp, left: -1 })]],
    ["left above size", [JSON.stringify({ ...validRamp, left: RAMP_FIRST + 1 })]],
    ["negative opening", [JSON.stringify({ ...validRamp, opens: -1 })]],
    ["unsafe opening", [JSON.stringify({ ...validRamp, opens: Number.MAX_SAFE_INTEGER + 1 })]],
    ["oversized record", [" ".repeat(513)]],
  ];
  mail.clearCaptured();
  try {
    for (const [name, reply] of badRampReads) {
      const commandsSeen: (string | number)[][] = [];
      redis.pipeline = async commands => {
        commandsSeen.push(...commands);
        if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === checkedRampKey) {
          if (reply instanceof Error) throw reply;
          return reply as unknown[];
        }
        return rampPipeline.call(redis, commands);
      };
      is(`${name}: no confirmed portion capacity`, await rampRoom(healthId(meadow), 1), 0);
      const held = await sendTo(meadow, ["member0@example.com"], "Hello", "Still waiting.", `ramp-read:${name}`);
      is(`${name}: sender keeps its recipient waiting without unknown acceptance`,
        [held.done, held.rest, held.stopped, held.uncertain], [[], ["member0@example.com"], "portion", undefined]);
      is(`${name}: only existing reader calls, with no reservation or write`,
        commandsSeen, [["GET", checkedRampKey], ["GET", checkedPauseKey], ["GET", checkedRampKey]]);
    }

    part("Unconfirmed portion writes grant no dispatch and are never refunded");
    const computedAck = new Array(1);
    Object.defineProperty(computedAck, "0", { get: () => { rampGetterCalls += 1; return "OK"; } });
    const badAcks: [string, unknown][] = [
      ["empty", []], ["null", [null]], ["boolean", [true]], ["lowercase", ["ok"]],
      ["extra entry", ["OK", "OK"]], ["computed", computedAck],
      ["lost acknowledgement", new Error("synthetic applied ramp write lost")],
    ];
    for (const [name, reply] of badAcks) {
      redis.run(["SET", checkedRampKey, JSON.stringify(validRamp)]);
      const commandsSeen: (string | number)[][] = [];
      redis.pipeline = async commands => {
        commandsSeen.push(...commands);
        if (commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === checkedRampKey) {
          await rampPipeline.call(redis, commands);
          if (reply instanceof Error) throw reply;
          return reply as unknown[];
        }
        return rampPipeline.call(redis, commands);
      };
      const held = await sendTo(meadow, ["member0@example.com"], "Hello", "Still waiting.", `ramp-write:${name}`);
      is(`${name}: sender waits with the whole recipient list`,
        [held.done, held.rest, held.stopped], [[], ["member0@example.com"], "portion"]);
      is(`${name}: no allowance increment or rollback command`,
        commandsSeen.map(c => c[0]), ["GET", "GET", "SET"]);
      const applied = JSON.parse(String((await rampPipeline.call(redis, [["GET", checkedRampKey]]))[0]));
      is(`${name}: applied uncertain portion remains taken`, applied.left, RAMP_FIRST - 1);
    }
    is("unconfirmed portion checkpoints sent no provider batch", listMessages().length, 0);
    is("no computed read or write acknowledgement was invoked", rampGetterCalls, 0);

    redis.pipeline = async commands => commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === checkedRampKey ? [null] : rampPipeline.call(redis, commands);
    is("confirmed absence still permits the requested audience", await rampRoom(healthId(meadow), 17), 17);
    redis.pipeline = rampPipeline;
    redis.run(["SET", checkedRampKey, JSON.stringify(validRamp)]);
    is("a known portion with confirmed write grants its exact amount", await rampRoom(healthId(meadow), 1), 1);
    const kept = Number((await rampPipeline.call(redis, [["TTL", checkedRampKey]]))[0]);
    is("existing 180-day portion retention is unchanged", kept <= 180 * 86_400 && kept >= 180 * 86_400 - 60, true);
    mail.clearCaptured();
    is("essential email still uses its existing path",
      [await sendEmail({ meter: { by: "company" }, from: "Marktmorgen <hello@marktmorgen.com>", to: "buyer@example.com", subject: "Your login link", text: "Hello." }), serviceMessages().length], [true, 1]);
  } finally {
    redis.pipeline = rampPipeline;
  }

  Date.now = realNow;

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
