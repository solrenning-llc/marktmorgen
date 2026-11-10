/**
 * A store with a person in every part of it (added 17 October 2026), for
 * tests/person-erasure.test.ts against the in-memory Redis and for
 * scripts/test_contact_erasure_redis.py against a real one: the same code,
 * whichever "@/lib/redis" it is built with.
 *
 * Each module is written to the way it writes itself, through its own
 * functions where they need nothing from Stripe or an email provider, and
 * otherwise by the keys and values it keeps (named beside each), so an
 * eraser that misses a key leaves something here that the test finds.
 */
import { createHash, randomBytes } from "node:crypto";
import { redisPipeline } from "@/lib/redis";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setMailSettings, setProductCourse, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { tokensFor, upsertContact } from "@/lib/contacts";
import { noteClick, rememberLinkKeys } from "@/lib/mail-clicks";
import { enroll, saveFlow } from "@/lib/flows";
import { setValue, writeDeal, writeFields } from "@/lib/crm";
import type { CrmField } from "@/lib/crm-rules";
import { addPersonNote } from "@/lib/buyer-profile";
import { personKey } from "@/lib/person-key";
import { addResponse, writeForm } from "@/lib/form-store";
import { parseForm } from "@/lib/forms";
import { emailKey, markLesson, mintPass, recordEnrollment, touchStudent } from "@/lib/learn";
import { markPassed } from "@/lib/quiz";
import { handIn, takeRoom } from "@/lib/assignment";
import { issueCertificate } from "@/lib/certificate";
import { addComment } from "@/lib/lesson-comments";
import { saveNote } from "@/lib/lesson-notes";
import { CREATOR_AUTHOR } from "@/lib/lesson-comments-rules";
import { freshConfig, saveConfig, touchMember } from "@/lib/community";
import { indexMember } from "@/lib/community-index";
import { award } from "@/lib/community-points";
import { tell } from "@/lib/community-notify";
import { pairOf } from "@/lib/community-dm";
import { grantImported, importedKey } from "@/lib/imported-purchases";
import { feedToken } from "@/lib/podcast-access";
import { saveReview } from "@/lib/reviews";
import { rememberBuyers } from "@/lib/buyer-library";
import { noteForErasure } from "@/lib/erasure-index";
import { normaliseEmail } from "@/lib/auth";
import { storeKey } from "@/lib/learn";
import { changeRequest, createRequest } from "@/lib/payment-request-store";
import { ROOM } from "./data-room";

export const OWNER = "keeper@example.com";

export type World = {
  store: Store;
  courseProduct: string;
  plain: string;
  courseId: string;
  lessons: string[];
  modules: string[];
  communityId: string;
  formId: string;
  field: CrmField;
};

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = (n: number) => randomBytes(n).toString("hex");
const second = () => Math.floor(Date.now() / 1000);

/** A store on a paying plan, with a course, a plain product, a community, a form, a field and a sequence. */
export async function makeWorld(handle = "erase-shop", owner = OWNER): Promise<World> {
  await claimHandle(owner, handle, handle === "erase-shop" ? "Erase Shop" : handle, "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  // Another owner's store has Stripe ids of its own, as two creators' stores do.
  const tag = owner === OWNER ? "Erase00001" : `T${sha(owner).slice(0, 9)}`;
  await setStripeAccount(owner, `acct_1Test${tag}`, true);
  const now = second();
  await setSubscription(owner, { customerId: `cus_${tag}`, subscriptionId: `sub_${tag}`, active: true, tier: "pro", period: { start: now - 10 * 86_400, end: now + 20 * 86_400, renews: true } });
  await setMailSettings(owner, { fromName: handle === "erase-shop" ? "Erase Shop" : handle, address: "1 Main St, Portland, OR 97201" });
  const made = await addProduct(owner, "The Course", "Lessons.", "49", null);
  const plain = await addProduct(owner, "The Guide", "A file.", "9", null);
  if (!made.ok || !plain.ok) throw new Error("no products");
  let course = emptyCourse();
  for (const title of ["One", "Two"]) {
    const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title });
    if (!added.ok) throw new Error("no lesson");
    course = added.course;
  }
  await saveCourse(course, ROOM);
  const set = await setProductCourse(owner, made.product.id, { id: course.id, lessons: 2 });
  if (!set.ok) throw new Error("not a course");
  let store = (await storeForEmail(owner))!;

  // The community (lib/community.ts).
  store = (await setCommunity(owner, true))!;
  const communityId = store.community!.id;
  await saveConfig(communityId, { ...freshConfig(store.name), access: [made.product.id] });

  // A form with an email field (lib/forms.ts).
  const formId = hex(5).slice(0, 10);
  const form = parseForm({ id: formId, name: "Intake", fields: [{ id: "fmail1", label: "Email", type: "email", required: true }, { id: "fgoal1", label: "Goal", type: "short" }], outcomes: [], updatedAt: Date.now() });
  if (!form) throw new Error("no form");
  await writeForm(store.statsId as string, form);

  // A field and a sequence (lib/crm.ts, lib/flows.ts).
  const field: CrmField = { id: "fld001", name: "Tier", type: "text", options: [] };
  await writeFields(store.statsId as string, [field]);
  const flow = await saveFlow(store, { name: "Welcome", trigger: "joined", active: true, steps: [{ delayHours: 48, subject: "Hello", body: "Hi there." }] }, { activate: true });
  if (!flow.ok) throw new Error(`no flow: ${JSON.stringify(flow)}`);
  store = (await storeForEmail(owner))!;

  return {
    store,
    courseProduct: made.product.id,
    plain: plain.product.id,
    courseId: course.id,
    lessons: course.modules[0].lessons.map((l) => l.id),
    modules: course.modules.map((m) => m.id),
    communityId,
    formId,
    field,
  };
}

/**
 * Puts one person in every part of the store. `other` is somebody already
 * there, so a private conversation between the two can be checked to go for
 * both, and nothing of the other's to stay or go wrongly.
 */
export async function seedPerson(w: World, rawEmail: string, other: string | null): Promise<void> {
  const email = normaliseEmail(rawEmail);
  const { store } = w;
  const statsId = store.statsId as string;
  const listId = store.listId as string;
  const sid = store.sid;
  const learner = emailKey(email);
  const person = personKey(statsId, email);
  const now = second();

  // The list, its token and the link use they allowed (lib/contacts.ts, lib/mail-clicks.ts).
  await upsertContact(listId, email, { agreed: true, explicit: true, source: "free", sid, clicks: true, productId: w.plain, title: "The Guide" }, ROOM);
  const token = (await tokensFor(listId, [email], store.handle)).get(email);
  if (!token) throw new Error("no unsubscribe token");
  const keys = await rememberLinkKeys([token]);
  await noteClick(keys.get(token) as string, `s-${hex(8)}-${hex(8)}`);
  // This week's delivery check (lib/mail-health.ts).
  await redisPipeline([["SET", `nl:mail:health:${sid}:seen:${sha(email).slice(0, 32)}`, "1", "EX", 86_400]]);
  // A sequence started (lib/flows.ts).
  await enroll(store, email, { joined: true });

  // Fields, deals and notes (lib/crm.ts, lib/buyer-profile.ts).
  await setValue(statsId, person, w.field, "Gold", ROOM);
  await writeDeal(statsId, { id: hex(5), title: `Coaching for ${email}`, email, cents: 50_000, stage: "lead00", note: "Wants a call", createdAt: Date.now(), updatedAt: Date.now() }, ROOM);
  await addPersonNote(statsId, person, OWNER, `Called ${email} about the course`, ROOM);
  // A payment request sent them, with its reminder waiting (lib/payment-request-store.ts).
  const billed = await createRequest(store, { email, name: "Tess", lines: [{ text: "Coaching, October", quantity: 1, cents: 48_000 }], note: `For ${email}`, dueDate: "", autoReminders: 1, total: 48_000 }, Date.now());
  if (!billed.ok) throw new Error(`a payment request was not kept: ${billed.message}`);
  await changeRequest(store, billed.request.id, (current) => ({ next: { ...current, sent: [Date.now()] }, answer: null }));
  // A form answer (lib/form-store.ts).
  await addResponse(statsId, w.formId, { id: hex(16), at: now, page: "/@erase-shop/form/intake", answers: { fmail1: email, fgoal1: "Learn fast" }, outcome: "", joined: false }, ROOM);

  // The course (lib/learn.ts, lib/course-finish.ts, lib/quiz.ts, lib/assignment.ts, lib/certificate.ts, lib/lesson-comments.ts).
  await recordEnrollment(store, email, w.courseProduct, now - 3_600, "stripe");
  await touchStudent(w.courseId, email, now - 3_600, ROOM);
  await markLesson(w.courseId, email, w.lessons[0], true, ROOM);
  await mintPass(store, email, "all");
  await redisPipeline([
    ["SET", `nl:learn:paid:${storeKey(store)}:${learner}`, JSON.stringify({ at: now }), "EX", 600],
    ["SET", `nl:course:${w.courseId}:dripmail:${learner}:${w.modules[0]}`, "1"],
    ["SET", `nl:course:${w.courseId}:open:${learner}`, "1", "EX", 400 * 86_400],
    ["SET", `nl:course:${w.courseId}:fin:${learner}`, "1", "EX", 400 * 86_400],
    ["SET", `nl:course:${w.courseId}:quiz:${w.lessons[0]}:tries:${learner}`, "1"],
    ["SET", `nl:course:${w.courseId}:quiz:${w.lessons[0]}:result:${learner}`, JSON.stringify({
      used: 1,
      last: {
        answers: { q1: [0] },
        grade: { right: 1, total: 1, percent: 100, passed: true, marks: { q1: true } },
        at: now,
      },
      best: 100,
      passed: true,
    })],
  ]);
  await markPassed(w.courseId, learner, w.lessons[0], ROOM);
  await takeRoom(storeKey(store), 1_000);
  await handIn({ data: ROOM, courseId: w.courseId, lessonId: w.lessons[1], who: learner, email, task: { prompt: "Write it", review: true, file: true } as never, text: "My work", file: { path: `tasks/${hex(4)}.pdf`, name: "work.pdf", bytes: 1_000, type: "application/pdf" } });
  const course = { id: w.courseId, modules: [{ id: w.modules[0], title: "Module 1", dripDays: 0, lessons: w.lessons.map((id) => ({ id, title: id })) }], certificate: true, startsAt: null } as never;
  const issued = await issueCertificate({ room: ROOM, store: store.handle, productId: w.courseProduct, course, title: "The Course", creator: store.name, email, who: learner, name: "Tess Taylor" });
  if (!issued.ok) throw new Error("no certificate");
  const asked = await addComment({ room: ROOM, courseId: w.courseId, lessonId: w.lessons[0], by: learner, text: "How long does this take?", name: "Tess" });
  if (!asked.ok) throw new Error("no comment");
  await addComment({ room: ROOM, courseId: w.courseId, lessonId: w.lessons[0], by: CREATOR_AUTHOR, text: "About an hour.", parent: asked.comment.id });
  // Their private note on a lesson (lib/lesson-notes.ts, 290 [SQ1]).
  const noted = await saveNote({ statsId, learner, courseId: w.courseId, lessonId: w.lessons[0], text: `My own note, ${email}`, was: "", room: store });
  if (!noted.ok) throw new Error(`a lesson note was not kept: ${noted.reason}`);

  // The community (lib/community*.ts, lib/chat-grant.ts).
  const id = w.communityId;
  const member = await touchMember(id, email, null, store);
  if (!member) throw new Error("no member");
  // Their profile as setProfile leaves it (its compare-and-set script is Redis's own, lib/community.ts):
  // a name, a handle others mention them by, the directory, the member search, and the token of their announcements' unsubscribe link.
  const handle = `tess${hex(2)}`;
  const unsub = hex(20);
  const named = { ...member, n: `Tess ${handle}`, h: handle, dir: true, mail: true, t: unsub };
  await redisPipeline([
    ["HSET", `nl:cm:${id}:m`, learner, JSON.stringify(named)],
    ["HSET", `nl:cm:${id}:h`, handle, learner],
    ["ZADD", `nl:cm:${id}:dir`, named.at, learner],
    ["SET", `nl:cm:unsub:${unsub}`, `${id}|${learner}|${store.handle}`],
  ]);
  await indexMember(id, named);
  await award(id, learner, 1, store);
  await tell(id, [learner], { kind: "reply", post: "p00001", comment: "", by: "creator", words: "Welcome in" } as never, ROOM);
  await redisPipeline([
    ["SET", `nl:cm:${id}:ps:${learner}`, JSON.stringify([{ endpoint: "https://push.example.com/1", keys: { p256dh: "x", auth: "y" }, kid: "k1", live: false }])],
    ["ZADD", `nl:cm:${id}:ch`, 1, JSON.stringify({ i: Date.now(), a: learner, text: "hello room", at: now, n: "Tess" })],
    ["SET", `nl:cm:${id}:chs:${learner}`, "1", "EX", 60],
    ["SET", `nl:cm:${id}:rg:${learner}`, JSON.stringify({ u: Date.now() + 60_000, w: 1 }), "EX", 600],
    ["SET", `nl:cm:${id}:ok:${learner}`, "1", "EX", 300],
    ["HSETNX", `nl:cm:${id}:wel`, learner, now],
    ["SET", `nl:cm:rl:${id}:${learner}:post`, "1", "EX", 3_600],
    ["SET", `nl:cm:${id}:sg:${w.courseProduct}:${learner}`, "1", "EX", 300],
    ["ZADD", `nl:cm:${id}:evs`, Date.now() + 86_400_000, "ev0001"],
    ["HSET", `nl:cm:${id}:ev:ev0001:r`, learner, now],
    ["SET", `nl:cm:${id}:ev:ev0001:ok:${learner}`, "1", "EX", 300],
  ]);
  if (other) {
    const them = emailKey(normaliseEmail(other));
    const pair = pairOf(learner, them);
    await redisPipeline([
      // A line in the shape lib/community-dm.ts writes ({ a, text, at }, type Message): the data copy reads every line
      // and refuses one it cannot read rather than leave it out (rule 24).
      ["RPUSH", `nl:cm:${id}:dm:${pair}`, JSON.stringify({ a: learner, text: "hi", at: now })],
      ["ZADD", `nl:cm:${id}:dm:i:${learner}`, now, pair],
      ["ZADD", `nl:cm:${id}:dm:q:${them}`, now, pair],
      ["HSET", `nl:cm:${id}:dm:r:${pair}`, learner, now],
    ]);
  }

  // A waitlist, its links and a launch going out (lib/waitlist.ts).
  const confirm = sha(hex(24));
  await redisPipeline([
    ["HSET", `nl:wl:${statsId}:${w.plain}`, email, JSON.stringify({ at: now, ok: now, c: true, t: hex(24) })],
    ["SET", `nl:wl:t:${confirm}`, JSON.stringify({ s: statsId, h: store.handle, p: w.plain, e: email, k: "confirm" }), "EX", 86_400],
    ...noteForErasure(statsId, email, `nl:wl:t:${confirm}`),
    ["RPUSH", `nl:wl:${statsId}:${w.plain}:send`, email],
  ]);
  // Its affiliate (lib/affiliate-bond.ts), what an import gave it (lib/imported-purchases.ts), its podcast feed (lib/podcast-access.ts).
  await redisPipeline([["HSET", `nl:aff:${statsId}:bond`, sha(`nimbus-aff-bond:${statsId}:${email}`).slice(0, 32), "aff001"]]);
  await grantImported(statsId, hex(12), [{ email, productId: w.plain, items: null }], now, sid);
  await redisPipeline([["HSET", importedKey(statsId, email), w.courseProduct, JSON.stringify({ at: now, job: hex(12), items: null })]]);
  await feedToken(store, w.plain, email);
  // Offers and reminders (lib/welcome-offer-send.ts, lib/winback-send.ts, lib/checkout-recovery.ts).
  const welcome = sha(`welcome:${email}`).slice(0, 32);
  await redisPipeline([
    ["SET", `nl:wo:start:${statsId}:${welcome}`, String(now), "EX", 86_400],
    ["SET", `nl:wo:r:${statsId}:${welcome}`, "1", "EX", 86_400],
    ["SET", `nl:wb:once:${statsId}:${sha(`nimbus-wb-once:${email}|${w.plain}`).slice(0, 32)}`, "1", "EX", 86_400],
    ["SET", `nl:recover:once:${statsId}:${sha(`nimbus-recover-once:${email}|${w.plain}`).slice(0, 32)}`, "1", "EX", 86_400],
  ]);
  // Links emailed to them that only their token leads to (lib/erasure-index.ts): a stop link, a review link, a free product's.
  const stop = hex(20);
  const review = `nl:rev:link:${sha(hex(24)).slice(0, 40)}`;
  const claim = `nl:free:claim:${sha(hex(16)).slice(0, 40)}`;
  await redisPipeline([
    ["SET", `nl:upd:stop:${stop}`, JSON.stringify({ s: statsId, e: email, h: store.handle, n: store.name }), "EX", 86_400],
    ["SET", review, JSON.stringify({ s: statsId, r: "cs_test_aaaaaaaaaaaa", e: email }), "EX", 86_400],
    ["SET", claim, JSON.stringify({ h: store.handle, p: w.plain, e: email, c: true, at: new Date().toISOString() }), "EX", 86_400],
    ...noteForErasure(statsId, email, `nl:upd:stop:${stop}`),
    ...noteForErasure(statsId, email, review),
    ...noteForErasure(statsId, email, claim),
  ]);
  // An invitation an import gave to keep a membership (lib/move-members.ts).
  const moveToken = hex(20);
  const field = `${sha(`nimbus-imported:${email}`).slice(0, 32)}:${w.plain}`;
  await redisPipeline([
    ["HSET", `nl:mv:${statsId}`, field, JSON.stringify({ e: email, p: w.plain, o: "", r: now + 86_400, job: hex(12), at: now, t: moveToken, kept: 0 })],
    ["SET", `nl:mv:link:${moveToken}`, JSON.stringify({ s: statsId, f: field }), "EX", 86_400],
    ["ZADD", "nl:mv:due", now + 3_600, `${sid}|${field}`],
  ]);
  // A conversation in the inbox (lib/inbox.ts).
  const conv = Array.from({ length: 12 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
  const chat = hex(16);
  await redisPipeline([
    ["ZADD", `nl:inbox:${statsId}:all`, Date.now(), conv],
    ["SET", `nl:inbox:${statsId}:c:${conv}`, JSON.stringify({ id: conv, email, name: "Tess", source: "chat", status: "open", assigned: "", startedAt: Date.now(), lastAt: Date.now(), lastFrom: "visitor", unread: 1, token: chat }), "EX", 86_400],
    ["RPUSH", `nl:inbox:${statsId}:m:${conv}`, JSON.stringify({ at: Date.now(), from: "visitor", text: `Hi, this is ${email}` })],
    ["SET", `nl:inbox:tok:${chat}`, `${statsId}|${conv}|${store.handle}`, "EX", 86_400],
  ]);
  // Discord, with no server connected, so nothing is called (lib/discord-store.ts).
  const discordId = `1${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}00000000`;
  await redisPipeline([
    ["SET", `nl:dc:addr:${storeKey(store)}:${learner}`, discordId],
    ["HSET", `nl:dc:mem:${storeKey(store)}`, discordId, JSON.stringify({ e: email, n: "tess", p: [w.courseProduct], r: [], at: now, checked: now })],
    ["ZADD", "nl:dc:due", now + 3_600, `${sid}|${discordId}`],
    ["SET", `nl:dc:ok:${storeKey(store)}:${learner}:${w.courseProduct}`, "1", "EX", 300],
  ]);
  // A send to the creator's email platform (lib/email-sync.ts).
  const job = hex(12);
  await redisPipeline([
    ["SET", `nl:esync:j:${job}`, JSON.stringify({ id: job, statsId, email, firstName: "Tess", products: [w.plain], title: "The Guide", source: "free", attempts: 1, state: "retrying", next: Date.now() + 60_000, lastError: "", note: "", lastAt: Date.now(), createdAt: Date.now() }), "EX", 86_400],
    ["LPUSH", `nl:esync:log:${statsId}`, job],
    ["ZADD", "nl:esync:q", Date.now() + 60_000, `${statsId}|${job}`],
  ]);
  // Ten-minute copies that list buyers (lib/segments.ts, lib/member-health.ts).
  await redisPipeline([
    ["SET", `nl:stats:${statsId}:ledger`, JSON.stringify({ c: "usd", p: false, r: [[email, 4_900, Date.now(), ""]] }), "EX", 600],
    ["SET", `nl:health:${statsId}`, JSON.stringify({ rows: [{ email }] }), "EX", 600],
  ]);
  // A review (lib/reviews.ts) and the library across stores (lib/buyer-library.ts).
  const saved = await saveReview(statsId, { productId: w.plain, email, reference: `cs_test_${hex(10)}`, pi: `pi_${hex(10)}`, rating: 5, text: "Loved it", name: "Tess" }, ROOM);
  if (saved.state !== "created") throw new Error(`no review: ${saved.state}`);
  await rememberBuyers(sid, [email]);
}

/** Every key and what it holds, as one comparable text each; empty containers left by reads are not keys in Redis. */
export async function snapshot(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [reply] = await redisPipeline([["SCAN", cursor, "MATCH", "*", "COUNT", 1000]]);
    const [next, found] = reply as [string, string[]];
    keys.push(...found);
    cursor = String(next);
  } while (cursor !== "0");
  for (const key of [...new Set(keys)].sort()) {
    const [type] = await redisPipeline([["TYPE", key]]);
    let value: unknown;
    if (type === "string") [value] = await redisPipeline([["GET", key]]);
    else if (type === "hash") {
      const [flat] = await redisPipeline([["HGETALL", key]]);
      const pairs: string[] = [];
      const list = Array.isArray(flat) ? (flat as string[]) : Object.entries(flat as Record<string, string>).flat();
      for (let i = 0; i + 1 < list.length; i += 2) pairs.push(`${list[i]}=${list[i + 1]}`);
      value = pairs.sort();
    } else if (type === "set") value = ((await redisPipeline([["SMEMBERS", key]]))[0] as string[]).slice().sort();
    else if (type === "zset") value = (await redisPipeline([["ZRANGEBYSCORE", key, "-inf", "+inf"]]))[0];
    else if (type === "list") value = (await redisPipeline([["LRANGE", key, 0, -1]]))[0];
    else value = `<${String(type)}>`;
    if (Array.isArray(value) && value.length === 0) continue;
    if (type === "none") continue;
    out.set(key, JSON.stringify(value));
  }
  return out;
}
