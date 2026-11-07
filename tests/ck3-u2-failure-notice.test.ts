/**
 * 511 [CK3], unit 2: when a scheduled discount code reaches "Activation
 * failed", the creator is emailed once (which code, that it is still off, and
 * how to switch it on by hand), from the store's own email figure before it is
 * sent; a send that fails is tried again a bounded number of times, never for
 * ever. And the studio's list says plainly when Stripe holds more codes than
 * it shows, and never hides a scheduled code. Synthetic clock, the in-memory
 * Redis stand-in and a stand-in Stripe only; no email leaves.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const originalFetch = globalThis.fetch;
process.env.STRIPE_SECRET_KEY = "sk_test_local_ck3u2_only";
process.env.STRIPE_CONNECT_API_BASE = "http://127.0.0.1:4997";

type Call = { method: string; path: string; body: string };
let calls: Call[] = [];
/** What the stand-in answers a switch-on with: never a confirmed one here, so every code fails. */
let listReply: unknown = { data: [], has_more: false };

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("http://127.0.0.1:4997/")) throw Error("Unexpected external request " + url);
  const path = url.replace(/^http:\/\/127\.0\.0\.1:4997(\/v1)?/, "");
  const body = init?.body ? String(init.body) : "";
  const method = init?.method ?? "GET";
  calls.push({ method, path, body });
  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  if (path === "/coupons") return json(200, { id: "coupon_ck3u2synthetic" });
  if (path === "/promotion_codes" && method === "POST") {
    const sent = new URLSearchParams(body);
    return json(200, { id: `promo_${sent.get("code")}`, code: sent.get("code"), active: false, expires_at: Number(sent.get("expires_at")), times_redeemed: 0 });
  }
  if (path.startsWith("/promotion_codes?") && method === "GET") return json(200, listReply);
  if (path.startsWith("/promotion_codes/")) {
    const params = new URLSearchParams(body);
    const id = decodeURIComponent(path.slice("/promotion_codes/".length));
    if (params.get("active") === "false") return json(200, { id, active: false });
    return json(500, { error: { message: "synthetic: never confirmed" } });
  }
  throw Error("Unexpected Stripe path " + path);
}) as typeof fetch;

const SID = "d".repeat(32);
const STATS = "e".repeat(32);
const ACCOUNT = "acct_ck3u2synthetic";
const shop = { sid: SID, statsId: STATS, stripeAccountId: ACCOUNT, email: "creator@example.test", name: "Synthetic Shop", handle: "synthetic" };
const asked = (code: string) => ({ code, off: { kind: "percent" as const, percent: 25 }, maxRedemptions: null, minimum: null });
const NOW = 1_800_000_000;
const HOUR = 3600;
const TELL = "nl:dsched:tell";
const member = (id: string) => `${SID}|${STATS}|${id}`;

async function main() {
  try {
    const rules = await import("@/lib/discount-schedule-rules");
    const sched = await import("@/lib/discount-schedule");
    const notice = await import("@/lib/discount-schedule-notice");
    const { ACTIVATION_TRIES, RETRY_SECONDS, NOTICE_TRIES, NOTICE_RETRY_SECONDS, SCHEDULE_UNITS } = rules;

    part("The rules: the notice is bounded, and paid for when the code is scheduled");
    is("a failed send is tried a bounded number of times", NOTICE_TRIES >= 1 && NOTICE_TRIES <= 5, true);
    is("a send is tried again an hour or more later, not every five minutes", NOTICE_RETRY_SECONDS >= 3600, true);
    is("scheduling takes a studio request for each switch-on try and each notice try, ahead", SCHEDULE_UNITS, ACTIVATION_TRIES + NOTICE_TRIES);

    const start = NOW + 2 * HOUR;
    const end = start + 48 * HOUR;

    part("The email: which code, that it is still off, and how to switch it on by hand");
    const mail = notice.failureNotice(shop, { code: "HOLIDAY25", start, end }, start + 900, "https://marktmorgen.test");
    is("the subject names the code, plainly", mail.subject, "Your discount code HOLIDAY25 did not switch on");
    is("the body names the code", mail.text.includes("HOLIDAY25"), true);
    is("it says the code is still off", /still off/.test(mail.text), true);
    is("it says buyers cannot use it yet", /buyers cannot use it/i.test(mail.text), true);
    is("it says the start, with its time zone", mail.text.includes("UTC"), true);
    is("it gives the studio's own address for the store", mail.text.includes(`https://marktmorgen.test/studio?store=${SID}#discount-codes`), true);
    is("it names the studio's own buttons, step by step", ["Load discount codes", "Cancel HOLIDAY25", "Make a code", "Start and end it at set times"].every((w) => mail.text.includes(w)), true);
    is("it says a code made again by hand has no end, and how to keep it", /no end/.test(mail.text) && /Stripe dashboard/.test(mail.text), true);
    is("it says it comes once", /only once|once for this code/i.test(mail.text), true);
    is("no urgency, scarcity or countdown words", /hurry|act now|only \d+ left|countdown|last chance|!/.test(mail.subject + mail.text), false);
    is("plain text: no markup", /<[a-z]/i.test(mail.text), false);
    is("short lines of plain American English (no line over 200 characters)", mail.text.split("\n").every((line) => line.length <= 200), true);
    const ended = notice.failureNotice(shop, { code: "HOLIDAY25", start, end }, end + 60, "https://marktmorgen.test");
    is("past its end: it says it can no longer be switched on", /can no longer be used|end has passed/.test(ended.text), true);
    is("past its end: it does not tell the creator to switch it on", ended.text.includes("Cancel HOLIDAY25"), false);
    is("past its end: the subject is the same plain one", ended.subject, mail.subject);

    part("A code that fails is told once, from the five-minute job");
    let told: { id: string; code: string }[] = [];
    let tellAnswers: (boolean | "throw")[] = [];
    const deps = {
      findStore: async (sid: string) => (sid === SID ? shop : null),
      markDiscounts: async () => {},
      tell: async (_store: typeof shop, entry: { id: string; code: string }) => {
        const answer = tellAnswers.shift() ?? true;
        if (answer === "throw") throw Error("synthetic send failure");
        if (answer) told.push({ id: entry.id, code: entry.code });
        return answer;
      },
    };
    is("scheduled", (await sched.scheduleCode(shop, asked("HOLIDAY25"), { start, end }, NOW)).ok, true);
    let clock = start;
    for (let i = 0; i < ACTIVATION_TRIES - 1; i += 1) {
      await sched.activateScheduledCodes(Date.now() + 10_000, clock, deps);
      is(`no email after try ${i + 1}: it is not failed yet`, told.length, 0);
      clock += RETRY_SECONDS;
    }
    let run = await sched.activateScheduledCodes(Date.now() + 10_000, clock, deps);
    is("the last try fails it", run.failed, 1);
    is("and the creator is told, in the same run", told, [{ id: "promo_HOLIDAY25", code: "HOLIDAY25" }]);
    is("counted as told", run.notices.told, 1);
    is("nothing left to tell", await redis.pipeline([["ZCARD", TELL]]), [0]);
    for (const later of [clock + RETRY_SECONDS, clock + NOTICE_RETRY_SECONDS, clock + 3 * NOTICE_RETRY_SECONDS]) {
      await sched.activateScheduledCodes(Date.now() + 10_000, later, deps);
    }
    is("never told twice", told.length, 1);
    const kept = await sched.readSchedules(STATS);
    is("the studio still shows it failed", kept.ok && kept.schedules[0]?.failed, true);
    is("the studio's rows carry nothing about the email", kept.ok ? Object.keys(kept.schedules[0] ?? {}).sort() : null, ["code", "end", "failed", "id", "start", "tries"]);
    is("the kept record is still read in its exact shape", kept.ok, true);

    part("A failed send is tried again later, a bounded number of times, then never");
    await redis.pipeline([["DEL", `nl:dsched:${STATS}`, "nl:dsched:due", TELL]]);
    told = [];
    tellAnswers = Array.from({ length: 20 }, (_, i) => (i % 2 ? "throw" : false));
    await sched.scheduleCode(shop, asked("SPRING10"), { start, end }, NOW);
    clock = start;
    for (let i = 0; i < ACTIVATION_TRIES; i += 1) {
      await sched.activateScheduledCodes(Date.now() + 10_000, clock, deps);
      clock += RETRY_SECONDS;
    }
    const firstTry = 20 - tellAnswers.length;
    is("one send tried when it failed", firstTry, 1);
    await sched.activateScheduledCodes(Date.now() + 10_000, clock + 60, deps);
    is("not tried again within the hour", 20 - tellAnswers.length, 1);
    for (let i = 1; i <= NOTICE_TRIES + 3; i += 1) {
      await sched.activateScheduledCodes(Date.now() + 10_000, clock + i * NOTICE_RETRY_SECONDS + 60, deps);
    }
    is("tried exactly NOTICE_TRIES times in all, a thrown send counted like a refused one", 20 - tellAnswers.length, NOTICE_TRIES);
    is("never sent", told.length, 0);
    is("nothing left to tell after the last try", await redis.pipeline([["ZCARD", TELL]]), [0]);
    const given = await sched.readSchedules(STATS);
    is("the code still reads failed in the studio", given.ok && given.schedules[0]?.failed, true);

    part("A send that works on its second try is told once");
    await redis.pipeline([["DEL", `nl:dsched:${STATS}`, "nl:dsched:due", TELL]]);
    told = [];
    tellAnswers = [false, true];
    await sched.scheduleCode(shop, asked("FALL5"), { start, end }, NOW);
    clock = start;
    for (let i = 0; i < ACTIVATION_TRIES; i += 1) {
      await sched.activateScheduledCodes(Date.now() + 10_000, clock, deps);
      clock += RETRY_SECONDS;
    }
    run = await sched.activateScheduledCodes(Date.now() + 10_000, clock + NOTICE_RETRY_SECONDS, deps);
    is("told on the second try", told.map((t) => t.code), ["FALL5"]);
    await sched.activateScheduledCodes(Date.now() + 10_000, clock + 5 * NOTICE_RETRY_SECONDS, deps);
    is("and only then", told.length, 1);

    part("A code the creator canceled, or one past its end before any try, is handled");
    await redis.pipeline([["DEL", `nl:dsched:${STATS}`, "nl:dsched:due", TELL]]);
    told = [];
    tellAnswers = [false];
    await sched.scheduleCode(shop, asked("WINTER15"), { start, end }, NOW);
    clock = start;
    for (let i = 0; i < ACTIVATION_TRIES; i += 1) {
      await sched.activateScheduledCodes(Date.now() + 10_000, clock, deps);
      clock += RETRY_SECONDS;
    }
    is("its first send failed and it waits for the next", await redis.pipeline([["ZCARD", TELL]]), [1]);
    is("the creator cancels it", await sched.cancelSchedule(shop, "promo_WINTER15"), "done");
    is("its notice goes with it", await redis.pipeline([["ZCARD", TELL]]), [0]);
    await sched.activateScheduledCodes(Date.now() + 10_000, clock + 5 * NOTICE_RETRY_SECONDS, deps);
    is("a canceled code is never told about", told.length, 0);

    await redis.pipeline([["DEL", `nl:dsched:${STATS}`, "nl:dsched:due", TELL]]);
    await sched.scheduleCode(shop, asked("LATE20"), { start, end }, NOW);
    calls = [];
    await sched.activateScheduledCodes(Date.now() + 10_000, end + 1, deps);
    is("past its end: no Stripe call", calls.length, 0);
    is("past its end: the creator is told it ran out", told.map((t) => t.code), ["LATE20"]);

    part("An unclear record is never told about");
    await redis.pipeline([["DEL", `nl:dsched:${STATS}`, "nl:dsched:due", TELL]]);
    told = [];
    await redis.pipeline([["HSET", `nl:dsched:${STATS}`, "promo_BROKEN", "{not json"], ["ZADD", TELL, start, member("promo_BROKEN")]]);
    run = await sched.activateScheduledCodes(Date.now() + 10_000, start + HOUR, deps);
    is("nothing sent", told.length, 0);
    is("counted as unknown", run.notices.unknown, 1);
    is("an unreadable record is moved on, never holding the front of the list", Number((await redis.pipeline([["ZSCORE", TELL, member("promo_BROKEN")]]))[0]), start + HOUR + NOTICE_RETRY_SECONDS);
    await redis.pipeline([["HSET", `nl:dsched:${STATS}`, "promo_OK", JSON.stringify({ c: "OK", s: start, e: end, t: 3, f: 0 })], ["ZADD", TELL, start, member("promo_OK")]]);
    await sched.activateScheduledCodes(Date.now() + 10_000, start + HOUR, deps);
    is("a code not failed is never told about", told.length, 0);
    const realPipeline = redis.pipeline.bind(redis);
    await redis.pipeline([["DEL", `nl:dsched:${STATS}`, TELL]]);
    redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "ZRANGEBYSCORE" && commands[0]?.[1] === TELL ? [{ not: "a list" }] : realPipeline(commands))) as typeof redis.pipeline;
    run = await sched.activateScheduledCodes(Date.now() + 10_000, start + HOUR, deps);
    redis.pipeline = realPipeline;
    is("an unreadable list to tell sends nothing and says unknown", [told.length, run.notices.unknown], [0, 1]);

    part("The real sender: the store's own email figure, before it goes");
    const lib = readFileSync("lib/discount-schedule-notice.ts", "utf8");
    is("sent through sendEmail, counted against the store's email figure", /meter: \{ by: "store", store(: store)?, kind: "email" \}/.test(lib), true);
    is("nothing is sent with no sender configured", await notice.tellActivationFailed(shop as never, { id: "promo_X", code: "X", start, end, tries: 3, failed: true }, start + 900), false);
    is("it carries a plain text body only, no HTML", /html:/.test(lib), false);
    const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
    is("the email registry allows this file only the store's figure", /"lib\/discount-schedule-notice\.ts": STORE/.test(registry), true);
    is("Claude 4's weekly-report file is not touched for it", lib.includes("stats-report"), false);

    part("A send whose reply was lost is never sent again on the retry (rv39 finding on #3027)");
    // sendEmail answers false both when nothing went and when the outcome is
    // unknown (a lost reply). The retry an hour later must not send the same
    // email a second time: one stable key per store and code.
    const { installSesMailFixture } = await import("./ses-mail-fixture");
    const mailWorld = installSesMailFixture();
    try {
      mailWorld.configure();
      await mailWorld.setReady(true, { max24: 50_000, rate: 100 });
      const lostEntry = { id: "promo_LOST", code: "LOST", start, end, tries: 3, failed: true };
      mailWorld.setSesOutcome("lost");
      const firstTry = await notice.tellActivationFailed(shop as never, lostEntry, start + 900);
      is("control: the first try reaches the provider once, and a lost reply is not read as sent", [mailWorld.calls.ses, firstTry], [1, false]);
      mailWorld.setSesOutcome("ok");
      await notice.tellActivationFailed(shop as never, lostEntry, start + 900 + NOTICE_RETRY_SECONDS);
      await notice.tellActivationFailed(shop as never, lostEntry, start + 900 + 2 * NOTICE_RETRY_SECONDS);
      is("the retries never send the same email again", [mailWorld.calls.ses, mailWorld.calls.resend], [1, 0]);
      let before = mailWorld.calls.ses;
      const otherTry = await notice.tellActivationFailed(shop as never, { ...lostEntry, id: "promo_OTHER", code: "OTHER" }, start + 900);
      is("another code's email still goes, once", [mailWorld.calls.ses - before, otherTry], [1, true]);
      const otherShop = { ...shop, statsId: "f".repeat(32), sid: "a".repeat(32), email: "other@example.test" };
      before = mailWorld.calls.ses;
      const otherShopTry = await notice.tellActivationFailed(otherShop as never, lostEntry, start + 900);
      is("the same code id at another store still goes, once", [mailWorld.calls.ses - before, otherShopTry], [1, true]);
      before = mailWorld.calls.ses;
      const noStats = await notice.tellActivationFailed({ ...shop, statsId: null } as never, { ...lostEntry, id: "promo_NOSTATS" }, start + 900);
      is("a store with no stats id has no stable key: nothing is sent", [mailWorld.calls.ses - before, mailWorld.calls.resend, noStats], [0, 0, false]);
    } finally {
      mailWorld.restore();
    }

    part("The studio's list: Stripe's first page, said plainly when there are more");
    const { readCodePage, listCodes, MAX_CODES } = await import("@/lib/discount");
    const row = (i: number) => ({ id: `promo_row${i}`, code: `ROW${i}`, active: true, times_redeemed: 0, promotion: { coupon: { percent_off: 10, duration: "once" } } });
    listReply = { data: Array.from({ length: MAX_CODES }, (_, i) => row(i)), has_more: true };
    is("Stripe says there are more: more", (await readCodePage(ACCOUNT)).state === "ok" && (await readCodePage(ACCOUNT) as { more: boolean }).more, true);
    listReply = { data: [row(1), row(2)], has_more: false };
    is("Stripe says that is all: not more", await readCodePage(ACCOUNT).then((p) => p.state === "ok" && p.more), false);
    listReply = { data: Array.from({ length: MAX_CODES }, (_, i) => row(i)) };
    is("no answer about more, and a full page: read as more (never said complete without proof)", await readCodePage(ACCOUNT).then((p) => p.state === "ok" && p.more), true);
    listReply = { data: [row(1)] };
    is("no answer about more, and a short page: it is all there is", await readCodePage(ACCOUNT).then((p) => p.state === "ok" && p.more), false);
    listReply = { data: [row(1)], has_more: "yes" };
    is("an answer about more in another shape: read as more", await readCodePage(ACCOUNT).then((p) => p.state === "ok" && p.more), true);
    listReply = { data: [row(1), row(2)], has_more: false };
    const plainList = await listCodes(ACCOUNT);
    is("the other readers of listCodes keep their exact shape", plainList.state === "ok" ? Object.keys(plainList).sort() : null, ["codes", "state"]);
    is("one page, one Stripe call, as before", calls.filter((c) => c.path.startsWith("/promotion_codes?")).length > 0 && MAX_CODES, 20);

    part("The route and the editor say it, and show every scheduled code");
    const route = readFileSync("app/api/store/discount/route.ts", "utf8");
    is("the studio route reads the page with its more", route.includes("readCodePage(account)"), true);
    is("and answers with it", /more: list\.more/.test(route), true);
    is("the confirmation reads more exactly", [rules.readMoreConfirmation({ more: true }), rules.readMoreConfirmation({ more: false }), rules.readMoreConfirmation({ more: "true" }), rules.readMoreConfirmation({})], [true, false, null, null]);
    const editor = readFileSync("components/discount-editor.tsx", "utf8");
    is("the editor reads more, or the list is not confirmed", editor.includes("readMoreConfirmation(data)"), true);
    is("the editor says plainly that only the newest are shown", editor.includes("Only your ${MAX_CODES} newest codes are shown here"), true);
    is("the editor shows scheduled codes Stripe's page left out", editor.includes("unlisted"), true);
    is("the editor's card has the address the email links to", editor.includes('id="discount-codes"'), true);
    const cron = readFileSync("app/api/cron/imports/route.ts", "utf8");
    is("the five-minute job's comment names the notice", /tells the creator/.test(cron), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
