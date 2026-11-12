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
 *
 * Parts H-J (C3's first review of #3489, HIGH 1): SES's text does not say
 * which of the email's addresses it refused. When it refuses every email of
 * a batch for the creator's own Reply-To or From line, nobody may be taken
 * off the list: an address is read as the recipient's own only when another
 * email of the same batch was taken (the sender side is then fine) or when
 * the text names the recipient's address or domain.
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
/** What Amazon's refusal of an address says: nothing more ("Illegal address"), the address, or its domain as sent (punycode). */
let says: "plain" | "address" | "domain" = "plain";
/** When set, Amazon refuses every email with this text, as it does for a sender's own header it will not take. */
let refuseAll: string | null = null;
/** When set, this address leaves the list (its row deleted) just as Amazon is asked, so taking it off finds nothing to take. */
let goneFirst: { listId: string; email: string } | null = null;
const refusal = (message: string) => new Response(JSON.stringify({ message }), { status: 400, headers: { "content-type": "application/json", "x-amzn-errortype": "BadRequestException" } });
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
    onSes: (message) => (goneFirst && message.to.includes(goneFirst.email) && redis.run(["HDEL", leadsKey(goneFirst.listId), goneFirst.email]), refuseAll !== null) ? refusal(refuseAll) : amazon === "content"
      ? new Response(JSON.stringify({ message: "Email content rejected" }), { status: 400, headers: { "content-type": "application/json", "x-amzn-errortype": "MessageRejected" } })
      : amazon === "lost" && message.to.includes("bo@example.com")
        ? new Response("", { status: 500 })
        : message.to.some((to) => to.endsWith("@exämple.com"))
          ? refusal(says === "address" ? `Illegal address: ${message.to.join(", ")}` : says === "domain" ? "Domain xn--exmple-cua.com is not allowed" : "Illegal address")
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
  // The refused one's email stays taken: it paid for asking Amazon, the read-back and taking it off (lib/mail.ts sendTo).
  is("the four attempts are taken from the month, and nothing more", (await usedThisMonthExact(listId, windowId(store)!)) - usedBeforeA, 4);
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

  // Rule 23, C3 HIGH 1: B2's three assertions changed. Amazon refuses its only email with a bare "Illegal address",
  // which does not say whether the recipient or the creator's own Reply-To/From was refused, and nobody in the batch
  // was taken. Before: answered once, sent, and the address taken off for good. Now: the broadcast stops at once,
  // saying the email was refused as it is, and the address stays on the list; B3/B4 take it off when Amazon names it.
  part("B2: a broadcast whose only address is one Amazon has not refused before, refused without saying which address");
  mail.clearCaptured();
  const lone = "lone@exämple.com";
  await upsertContact(listId, lone, { agreed: true, explicit: true, source: "import" }, ROOM);
  const id4 = "999999999999999999999999";
  const key4 = `nl:mail:bc:${id4}`;
  const beforeB2 = await usedThisMonthExact(listId, window);
  await redis.pipeline([["SET", key4, JSON.stringify({ ...broadcast, id: id4, total: 1 })], ["RPUSH", `${key4}:to`, lone], ["SADD", "nl:mail:queue", id4]]);
  let b2 = null;
  for (let run = 0; run < 3; run += 1) b2 = await advanceBroadcast(id4, storeForHandle, Date.now() + 10_000);
  is("it is answered once and stops, saying the email was refused as it is", [b2?.status, b2?.note, mail.sesAttempts.length], ["failed", "The email service refused this email as it is, so nothing more was sent. The saved recipient list is retained.", 1]);
  // The one attempt pays, before it is made, for asking Amazon (lib/mail.ts sendTo; tests/plan-cost-registry.ts,
  // list-email); the broadcast stopped, so it is never paid for again.
  is("the month pays for the one attempt only", (await usedThisMonthExact(listId, window)) - beforeB2, 1);
  is("and the address stays on the list, since nothing says it was the one refused", [contactOf(listId, lone)?.unsub ?? false, contactOf(listId, lone)?.gone], [false, undefined]);

  part("B3: the same, but Amazon's text names the address it refused");
  mail.clearCaptured();
  says = "address";
  const named = "named@exämple.com";
  await upsertContact(listId, named, { agreed: true, explicit: true, source: "import" }, ROOM);
  const id8 = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const key8 = `nl:mail:bc:${id8}`;
  await redis.pipeline([["SET", key8, JSON.stringify({ ...broadcast, id: id8, total: 1 })], ["RPUSH", `${key8}:to`, named], ["SADD", "nl:mail:queue", id8]]);
  const b3 = await advanceBroadcast(id8, storeForHandle, Date.now() + 10_000);
  is("named by Amazon, the address is the refused one: done, and taken off the list", [b3?.status, contactOf(listId, named)?.gone], ["sent", "refused"]);

  part("B4: the same, but Amazon's text names the address's domain, as sent (punycode)");
  mail.clearCaptured();
  says = "domain";
  const domained = "domained@exämple.com";
  await upsertContact(listId, domained, { agreed: true, explicit: true, source: "import" }, ROOM);
  const id9 = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const key9 = `nl:mail:bc:${id9}`;
  await redis.pipeline([["SET", key9, JSON.stringify({ ...broadcast, id: id9, total: 1 })], ["RPUSH", `${key9}:to`, domained], ["SADD", "nl:mail:queue", id9]]);
  const b4 = await advanceBroadcast(id9, storeForHandle, Date.now() + 10_000);
  is("its domain named by Amazon, the address is the refused one: done, and taken off the list", [b4?.status, contactOf(listId, domained)?.gone], ["sent", "refused"]);
  says = "plain";

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

  part("H: the creator's own address (the Reply-To) is one Amazon will not take, so it refuses every email");
  mail.clearCaptured();
  const cafe = "owner@café-example.com";
  await claimHandle(cafe, "cafeshop", "Cafe Shop", "");
  await ensureListId(cafe);
  await setSubscription(cafe, { customerId: "cus_Cafe00000001", subscriptionId: "sub_Cafe00000001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(cafe, { fromName: "Cafe Shop", address: "4 Paper Lane, Boston, MA 02108" });
  const cafeStore = (await storeForEmail(cafe))!;
  const cafeList = cafeStore.listId!;
  const readers = ["r1@example.com", "r2@example.com", "r3@example.com", "r4@example.com"];
  for (const email of readers) await upsertContact(cafeList, email, { agreed: true, explicit: true, source: "import" }, ROOM);
  const onList = (list: string, emails: string[]) => emails.map((email) => [contactOf(list, email)?.unsub ?? false, contactOf(list, email)?.gone ?? null]);
  const kept = (emails: string[]) => emails.map(() => [false, null]);
  refuseAll = "Illegal address";
  const idH = "cccccccccccccccccccccccc";
  const keyH = `nl:mail:bc:${idH}`;
  await redis.pipeline([["SET", keyH, JSON.stringify({ ...broadcast, id: idH, listId: cafeList, handle: cafeStore.handle, total: readers.length })], ["RPUSH", `${keyH}:to`, ...readers], ["SADD", "nl:mail:queue", idH]]);
  const h = await advanceBroadcast(idH, storeForHandle, Date.now() + 10_000);
  is("nobody is taken off the list for a refusal that may be the creator's own address", onList(cafeList, readers), kept(readers));
  is("it stops at once, saying the email was refused as it is (not that the people were at fault)", [h?.status, h?.note], ["failed", "The email service refused this email as it is, so nothing more was sent. The saved recipient list is retained."]);

  part("H2: the same, Amazon naming the creator's own address, whose domain ends like the recipients'");
  mail.clearCaptured();
  refuseAll = `Illegal address: ${cafe}`;
  const idH2 = "dddddddddddddddddddddddd";
  const keyH2 = `nl:mail:bc:${idH2}`;
  await redis.pipeline([["SET", keyH2, JSON.stringify({ ...broadcast, id: idH2, listId: cafeList, handle: cafeStore.handle, total: readers.length })], ["RPUSH", `${keyH2}:to`, ...readers], ["SADD", "nl:mail:queue", idH2]]);
  const h2 = await advanceBroadcast(idH2, storeForHandle, Date.now() + 10_000);
  is("\"café-example.com\" does not name \"example.com\": nobody is taken off", onList(cafeList, readers), kept(readers));
  is("and it stops at once", h2?.status, "failed");

  part("I: Amazon will not take the From line, so it refuses every email");
  mail.clearCaptured();
  refuseAll = "Illegal address in From header";
  const two = ["ana@example.com", "bo@example.com"];
  const idI = "eeeeeeeeeeeeeeeeeeeeeeee";
  const keyI = `nl:mail:bc:${idI}`;
  await redis.pipeline([["SET", keyI, JSON.stringify({ ...broadcast, id: idI, total: two.length })], ["RPUSH", `${keyI}:to`, ...two], ["SADD", "nl:mail:queue", idI]]);
  const iOut = await advanceBroadcast(idI, storeForHandle, Date.now() + 10_000);
  is("nobody is taken off the list for the creator's own From line", onList(listId, two), kept(two));
  is("it stops at once", iOut?.status, "failed");

  part("J: a sequence step whose every email Amazon refuses for the creator's own address");
  mail.clearCaptured();
  refuseAll = "Illegal address";
  const followers = ["f1@example.com", "f2@example.com"];
  for (const email of followers) await upsertContact(cafeList, email, { agreed: true, explicit: true, source: "import" }, ROOM);
  const savedJ = await saveFlow(cafeStore, { name: "Welcome", trigger: "joined", active: true, steps: [{ delayHours: 0, subject: "Hello", body: "First email." }] }, { activate: true });
  is("the sequence is saved", savedJ.ok, true);
  const cafeFresh = (await storeForEmail(cafe))!;
  for (const email of followers) await enroll(cafeFresh, email, { joined: true });
  for (let r = 0; r < 2; r += 1) await sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
  is("nobody in the sequence is taken off the list", onList(cafeList, followers), kept(followers));
  refuseAll = null;

  part("K: the refused address left the list just as it was sent, so nothing is taken off and nothing says it was");
  mail.clearCaptured();
  const LEFT = "left@exämple.com";
  await upsertContact(listId, LEFT, { agreed: true, explicit: true, source: "import" }, ROOM);
  goneFirst = { listId, email: LEFT };
  const idK = "abababababababababababab";
  const keyK = `nl:mail:bc:${idK}`;
  const ks = ["ana@example.com", LEFT];
  await redis.pipeline([["SET", keyK, JSON.stringify({ ...broadcast, id: idK, total: ks.length })], ["RPUSH", `${keyK}:to`, ...ks], ["SADD", "nl:mail:queue", idK]]);
  const k = await advanceBroadcast(idK, storeForHandle, Date.now() + 10_000);
  goneFirst = null;
  is("the good address got it", mail.ses.flatMap((m) => m.to), ["ana@example.com"]);
  is("the address that had already left is not on the list", contactOf(listId, LEFT), null);
  is("the broadcast does not count it as taken off", k?.removed ?? 0, 0);
  is("the note does not say it was taken off the list", /taken off your list/.test(k?.note ?? ""), false);

  mail.restore();
  done();
}

void main();
