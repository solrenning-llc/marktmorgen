/**
 * "Send me a link" on a course page must not tell a stranger whether an
 * address bought the course. With the mail route ready but the final send
 * failing (SES refuses the message, no Resend key, or the send throws), the
 * buyer used to get "error" while an address that never bought got "sent",
 * and the token written for the failed email stayed in Redis for an hour.
 *
 * Actual functions under test: requestCourseLink, sendCourseLink and
 * POST /api/store/course/link, with MemoryRedis and the synthetic SES fixture
 * (provider HTTP replies only, never the send result).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setPastBuyers, setProductCourse, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { grantImported } from "@/lib/imported-purchases";
import { openCourseLink, requestCourseLink, sendCourseLink } from "@/lib/learn";
import { coursesWords } from "@/lib/buyer-words/courses";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { POST as courseLinkRoute } from "@/app/api/store/course/link/route";
import { store as redis } from "@/tests/redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";

const origin = "https://marktmorgen.com";
const owner = "uniform-course-owner@example.test";
const buyer = "uniform-course-buyer@example.test";
const stranger = "uniform-course-stranger@example.test";
type Command = (string | number)[];

const tokens = () => redis.keys().filter((k) => k.startsWith("nl:learn:link:") && !k.endsWith(":opens")).length;

async function world(handle: string) {
  delete process.env.RESEND_API_KEY;
  const fixture = installSesMailFixture();
  redis.clear();
  fixture.configure();
  await fixture.setReady(true, { max24: 50_000, rate: 100 });
  assert.ok((await claimHandle(owner, handle, "Uniform School", "")).ok);
  await ensureStatsId(owner);
  await setPastBuyers(owner);
  const made = await addProduct(owner, "Uniform course", "Original summary", "49", null);
  assert.ok(made.ok);
  await setProductCourse(owner, made.product.id, { id: "e".repeat(32), lessons: 1 });
  const stored = (await storeForEmail(owner))!;
  const product = (await readProduct(stored, made.product.id))!;
  assert.ok(product.course);
  // An independent imported right, written by its real function: synthetic, not a real purchase.
  await grantImported(stored.statsId!, "f".repeat(24), [{ email: buyer, productId: product.id, items: null }], 1793293200, stored.sid);
  const paidStore = { ...stored, subscriptionActive: true, subscriptionId: null, trialEnds: 0, planEndedAt: "", tier: "pro" as const };
  return { fixture, stored, product, paidStore };
}

test("a refused final send gives the buyer and a stranger the same reply and keeps no token", async () => {
  const { fixture, product, paidStore } = await world("uniform-refused-school");
  try {
    fixture.setSesOutcome("refused");
    const entitled = await requestCourseLink({ store: paidStore, product, email: buyer, ip: "192.0.2.50", origin });
    const unentitled = await requestCourseLink({ store: paidStore, product, email: stranger, ip: "192.0.2.51", origin });
    assert.ok(fixture.calls.ses > 0, "the buyer's send really reached SES and was refused");
    assert.equal(fixture.sent.length, 0);
    assert.equal(entitled, unentitled, "the reply never says whether the address bought the course");
    assert.equal(entitled, "sent");
    assert.equal(tokens(), 0, "the token of an email that was never sent is removed");
  } finally {
    fixture.restore();
  }
});

test("the direct sender removes its token when the send fails and still reports the failure", async () => {
  const { fixture, product, paidStore } = await world("uniform-direct-school");
  try {
    fixture.setSesOutcome("refused");
    assert.equal(await sendCourseLink(paidStore, product, buyer, origin), false);
    assert.equal(tokens(), 0);
  } finally {
    fixture.restore();
  }
});

test("an outage after the token was written gives the same reply as a stranger and keeps no token", async () => {
  const { fixture, product, paidStore } = await world("uniform-thrown-school");
  const original = redis.pipeline;
  let armed = false;
  let thrown = 0;
  try {
    // Once the token is written, every later Redis call fails (an outage),
    // except removing that token: whatever catches it, nothing may leak.
    redis.pipeline = async (commands: Command[]) => {
      const removesToken = commands.every((c) => c[0] === "DEL" && String(c[1]).startsWith("nl:learn:link:"));
      if (armed && !removesToken) { thrown += 1; throw new Error("synthetic outage"); }
      const reply = await original(commands);
      if (commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:learn:link:"))) armed = true;
      return reply;
    };
    const entitled = await requestCourseLink({ store: paidStore, product, email: buyer, ip: "192.0.2.52", origin });
    armed = false;
    const unentitled = await requestCourseLink({ store: paidStore, product, email: stranger, ip: "192.0.2.53", origin });
    assert.ok(thrown > 0, "the outage really happened after the token was written");
    assert.equal(fixture.sent.length, 0);
    assert.equal(entitled, unentitled);
    assert.equal(tokens(), 0);
    armed = false;
    const direct = await sendCourseLink(paidStore, product, buyer, origin).catch(() => "threw" as const);
    assert.ok(direct === false || direct === "threw", "the direct sender never reports a failed send as sent");
    assert.equal(tokens(), 0, "the direct sender removes its token whether the send failed or threw");
  } finally {
    redis.pipeline = original;
    fixture.restore();
  }
});

test("the public route redirects the buyer and a stranger to the same place when the send fails", async () => {
  const { fixture, stored, product } = await world("uniform-route-school");
  try {
    fixture.setSesOutcome("refused");
    const post = (email: string, ip: string) =>
      courseLinkRoute(new NextRequest(`${origin}/api/store/course/link`, {
        method: "POST",
        headers: { Host: "marktmorgen.com", Origin: origin, "Content-Type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
        body: new URLSearchParams({ handle: stored.handle, product: product.id, email }),
      }));
    const a = await post(buyer, "192.0.2.54");
    const b = await post(stranger, "192.0.2.55");
    assert.equal(a.status, 303);
    assert.equal(a.headers.get("location"), b.headers.get("location"));
    assert.equal(tokens(), 0);
  } finally {
    fixture.restore();
  }
});

test("a delivered link still opens the course", async () => {
  const { fixture, product, paidStore } = await world("uniform-ok-school");
  try {
    assert.equal(await requestCourseLink({ store: paidStore, product, email: buyer, ip: "192.0.2.56", origin }), "sent");
    const mail = fixture.sent.at(-1)!;
    const token = /token=([a-f0-9]{64})/.exec(mail.text)?.[1];
    assert.ok(token);
    assert.equal(tokens(), 1);
    const grant = await openCourseLink(token);
    assert.equal(grant?.e, buyer);
  } finally {
    fixture.restore();
  }
});

// The notice before this fix promised a link "on its way" to an address that bought the course.
const PROMISED = [
  "a link to open it is on its way",
  "va en camino un enlace para abrirlo",
  "un lien pour l'ouvrir est en route",
  "ist ein Link zum Öffnen unterwegs",
  "un link per aprirlo è in arrivo",
  "is er een link onderweg om hem te openen",
  "uma ligação para o abrir está a caminho",
];

test("the reply is honest when nothing was sent: no promise of a link, and what to do if none arrives, in every language", () => {
  for (const code of LANGUAGE_CODES) {
    const { sent } = coursesWords(code).linkNotices;
    assert.ok(sent.title.length > 0 && sent.body.length > 0, code);
    assert.ok(PROMISED.every((p) => !sent.body.includes(p)), `${code}: never promises a link that may not have been sent`);
  }
  assert.match(coursesWords("en").linkNotices.sent.body, /ask again/i, "tells the buyer what to do if nothing arrives");
});
