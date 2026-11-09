/**
 * Auditor's proof (C5, 09/11/2026), synthetic only. One address on the list
 * that Amazon SES refuses for good (a 400, the address itself) must not stop
 * the whole broadcast as "could not be confirmed", nor be retried as "the
 * email service asked us to slow down" while the month's emails are spent
 * on sends that never happened. Each `is` states the correct behaviour, so a
 * FAIL is the defect.
 *
 * Parts E-G (the fix's own guards): an email Amazon refuses as it is (not an
 * address) takes nobody off the list and says so; an answer that was lost
 * stays uncertain; and accepted people whose `did` mark was not written keep
 * the batch uncertain, since nothing durable says who took it.
 */
import { advanceBroadcast } from "@/lib/broadcasts";
import { claimHandle, ensureListId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { leadsKey, parseContact, upsertContact } from "@/lib/contacts";
import { enroll, saveFlow, sendDueSteps } from "@/lib/flows";
import { usedThisMonthExact } from "@/lib/mail";
import { windowId } from "@/lib/allowance-window";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const BAD = "bad@exämple.com";

/** What Amazon does with each email: refuse the bad address, refuse the email as it is, or lose one answer. */
let amazon: "address" | "content" | "lost" = "address";
const contactOf = (listId: string, email: string) => parseContact(redis.run(["HGET", leadsKey(listId), email]));

async function main(): Promise<void> {
  redis.clear();
  const owner = "letters@example.com";
  await claimHandle(owner, "letters", "Letters Shop", "");
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_Letters0001", subscriptionId: "sub_Letters0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Letters Shop", address: "4 Paper Lane, Boston, MA 02108" });
  const store = (await storeForEmail(owner))!;
  const listId = store.listId!;
  const good = ["ana@example.com", "bo@example.com", "cy@example.com"];
  for (const email of [...good, BAD]) await upsertContact(listId, email, { agreed: true, explicit: true, source: "import" }, ROOM);

  process.env.RESEND_API_KEY = "re_test_send_time_suppression_only";
  const mail = installSesMailFixture({
    // Amazon refuses these addresses (BAD and, in G, one more at the same domain) for good, as it does an address it will not take; every other goes.
    onSes: (message) => amazon === "content"
      ? new Response(JSON.stringify({ message: "Email content rejected" }), { status: 400, headers: { "content-type": "application/json", "x-amzn-errortype": "MessageRejected" } })
      : amazon === "lost" && message.to.includes("bo@example.com")
        ? new Response("", { status: 500 })
        : message.to.some((to) => to.endsWith("@exämple.com"))
          ? new Response(JSON.stringify({ message: "Illegal address" }), { status: 400, headers: { "content-type": "application/json", "x-amzn-errortype": "BadRequestException" } })
          : undefined,
  });
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });

  part("A: four on the list, one of them refused for good by Amazon");
  const id = "333333333333333333333333";
  const key = `nl:mail:bc:${id}`;
  const everyone = ["ana@example.com", BAD, "bo@example.com", "cy@example.com"];
  const broadcast = { id, listId, handle: store.handle, subject: "New paper is in", body: "Fresh stock this week.", productId: null, notProductId: null, who: "all", narrow: null, status: "sending", createdAt: 100, sendAt: 100, finishedAt: 0, total: everyone.length, sent: 0, note: "", failures: 0, listed: true, tagged: true, test: null };
  await redis.pipeline([["SET", key, JSON.stringify(broadcast)], ["RPUSH", `${key}:to`, ...everyone], ["SADD", "nl:mail:queue", id]]);
  const usedBeforeA = await usedThisMonthExact(listId, windowId(store)!);
  const a = await advanceBroadcast(id, storeForHandle, Date.now() + 10_000);
  is("the three good addresses got it", mail.ses.flatMap((m) => m.to).sort(), [...good].sort());
  is("the broadcast completes (the refused address is a known refusal, not an unknown)", a?.status, "sent");
  is("it does not tell the creator that sending could not be confirmed", /could not be confirmed/.test(a?.note ?? ""), false);
  is("it tells the creator how many were not accepted, and why", a?.note, "1 address on your list was not accepted by the email service, so it did not get this email. The email service refused the address itself, so it was taken off your list.");
  is("only the three accepted are taken from the month; the refused one is given back", (await usedThisMonthExact(listId, windowId(store)!)) - usedBeforeA, 3);
  is("the refused address is taken off the list, saying why", [contactOf(listId, BAD)?.unsub, contactOf(listId, BAD)?.gone], [true, "refused"]);
  is("the good addresses stay on the list", good.map((email) => contactOf(listId, email)?.unsub ?? false), [false, false, false]);

  part("B: a broadcast whose only address Amazon refuses for good");
  mail.clearCaptured();
  const id2 = "444444444444444444444444";
  const key2 = `nl:mail:bc:${id2}`;
  const window = windowId(store)!;
  const before = await usedThisMonthExact(listId, window);
  await redis.pipeline([["SET", key2, JSON.stringify({ ...broadcast, id: id2, total: 1 })], ["RPUSH", `${key2}:to`, BAD], ["SADD", "nl:mail:queue", id2]]);
  let b = null;
  for (let run = 0; run < 3; run += 1) b = await advanceBroadcast(id2, storeForHandle, Date.now() + 10_000);
  is("nothing was sent", mail.ses.length, 0);
  is("the studio is not told the email service asked to slow down", /slow down/.test(b?.note ?? ""), false);
  is("the month's emails are not spent on three refusals that sent nothing", (await usedThisMonthExact(listId, window)) - before, 0);

  part("C: 150 on the list, the refused one in the first batch of 100");
  mail.clearCaptured();
  const many = Array.from({ length: 149 }, (_, i) => `p${i}@example.com`);
  for (const email of many) await upsertContact(listId, email, { agreed: true, explicit: true, source: "import" }, ROOM);
  const id3 = "555555555555555555555555";
  const key3 = `nl:mail:bc:${id3}`;
  const list3 = [many[0], BAD, ...many.slice(1)];
  await redis.pipeline([["SET", key3, JSON.stringify({ ...broadcast, id: id3, total: list3.length })], ["RPUSH", `${key3}:to`, ...list3], ["SADD", "nl:mail:queue", id3]]);
  let c = null;
  for (let run = 0; run < 3; run += 1) c = await advanceBroadcast(id3, storeForHandle, Date.now() + 10_000);
  is("all 149 good addresses get it, including the 50 after the first batch", mail.ses.length, 149);
  is("it is still waiting or sent, not stopped for good", c?.status === "sent" || c?.status === "sending" || c?.status === "waiting", true);

  part("D: a sequence of two emails; one of the four people in the step is refused for good");
  mail.clearCaptured();
  const owner2 = "seq@example.com";
  await claimHandle(owner2, "seqshop", "Seq Shop", "");
  await ensureListId(owner2);
  await setSubscription(owner2, { customerId: "cus_Seq00000001", subscriptionId: "sub_Seq00000001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner2, { fromName: "Seq Shop", address: "4 Paper Lane, Boston, MA 02108" });
  const seq = (await storeForEmail(owner2))!;
  const people = ["s1@example.com", "s2@example.com", "s3@example.com", BAD];
  for (const email of people) await upsertContact(seq.listId!, email, { agreed: true, explicit: true, source: "import" }, ROOM);
  const saved = await saveFlow(seq, { name: "Welcome", trigger: "joined", active: true, steps: [{ delayHours: 0, subject: "Hello", body: "First email." }, { delayHours: 0, subject: "Second", body: "Second email." }] }, { activate: true });
  is("the sequence is saved", saved.ok, true);
  const fresh = (await storeForEmail(owner2))!;
  for (const email of people) await enroll(fresh, email, { joined: true });
  for (let r = 0; r < 4; r += 1) await sendDueSteps((h) => storeForHandle(h), Date.now() + 20_000);
  const subjects = (who: string) => mail.ses.filter((m) => m.to.includes(who)).map((m) => m.subject);
  is("each good person gets both emails", ["s1@example.com", "s2@example.com", "s3@example.com"].map(subjects), [["Hello", "Second"], ["Hello", "Second"], ["Hello", "Second"]]);
  is("the refused person is taken off the sequence's list", contactOf(seq.listId!, BAD)?.gone, "refused");

  part("E: Amazon refuses the email as it is, for everyone in the batch (not an address)");
  mail.clearCaptured();
  amazon = "content";
  const id5 = "666666666666666666666666";
  const key5 = `nl:mail:bc:${id5}`;
  await redis.pipeline([["SET", key5, JSON.stringify({ ...broadcast, id: id5, total: 2 })], ["RPUSH", `${key5}:to`, "ana@example.com", "bo@example.com"], ["SADD", "nl:mail:queue", id5]]);
  const e = await advanceBroadcast(id5, storeForHandle, Date.now() + 10_000);
  is("nobody is taken off the list for a refusal of the email itself", ["ana@example.com", "bo@example.com"].map((email) => contactOf(listId, email)?.unsub ?? false), [false, false]);
  is("it stops at once, not tried again five times", e?.status, "failed");
  is("it says the email service refused the email, not that it asked to slow down", e?.note, "The email service refused this email as it is, so nothing more was sent. The saved recipient list is retained.");

  part("F: Amazon's answer for one address is lost (it may have gone)");
  mail.clearCaptured();
  amazon = "lost";
  const id6 = "777777777777777777777777";
  const key6 = `nl:mail:bc:${id6}`;
  await redis.pipeline([["SET", key6, JSON.stringify({ ...broadcast, id: id6, total: 2 })], ["RPUSH", `${key6}:to`, "ana@example.com", "bo@example.com"], ["SADD", "nl:mail:queue", id6]]);
  const f = await advanceBroadcast(id6, storeForHandle, Date.now() + 10_000);
  is("a lost answer is still uncertain: stopped so nothing is sent twice", [f?.status, /could not be confirmed/.test(f?.note ?? "")], ["failed", true]);
  is("and nobody is taken off the list for it", contactOf(listId, "bo@example.com")?.unsub ?? false, false);

  part("G: one refused, the others taken, but the marks of who was taken were not written");
  mail.clearCaptured();
  amazon = "address";
  const id7 = "888888888888888888888888";
  const key7 = `nl:mail:bc:${id7}`;
  await upsertContact(listId, "dee@example.com", { agreed: true, explicit: true, source: "import" }, ROOM);
  const odd = "odd@exämple.com";
  await upsertContact(listId, odd, { agreed: true, explicit: true, source: "import" }, ROOM);
  await redis.pipeline([["SET", key7, JSON.stringify({ ...broadcast, id: id7, total: 2 })], ["RPUSH", `${key7}:to`, "dee@example.com", odd], ["SADD", "nl:mail:queue", id7]]);
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (commands) => commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:ses:did:")) ? Promise.reject(new Error("lost")) : pipeline(commands);
  const g = await advanceBroadcast(id7, storeForHandle, Date.now() + 10_000);
  redis.pipeline = pipeline;
  is("without the marks, who took it is not proved: the batch stays uncertain", [g?.status, /could not be confirmed/.test(g?.note ?? "")], ["failed", true]);
  is("and the refused address is not taken off on that unproved answer", contactOf(listId, odd)?.unsub ?? false, false);

  mail.restore();
  done();
}

void main();
