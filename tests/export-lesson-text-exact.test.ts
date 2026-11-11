/**
 * A store's whole export reads every lesson's text exactly (rule 24): an
 * answer that is neither the text nor Redis's own "no text" is unknown, and the
 * export says that part could not be read, never writes the lesson as empty.
 * The file is what a creator takes away before the store closes
 * (lib/plan-closing.ts), so a lesson written out as "" there is text lost.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { POST as courseRoute } from "@/app/api/store/course/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { lessonsInOrder, readAllBodies, readCourse } from "@/lib/course";
import { readListing } from "@/lib/catalog";
import { storeExport } from "@/lib/store-export";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";

const OWNER = "export-lesson-text-exact@example.com";
type Pipeline = typeof redis.pipeline;

async function textOf(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

test("an unknown lesson-text answer is never exported as an empty lesson", async () => {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "exportlessonexact", "Export Lesson Exact", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_ExportLesson", true);
  await setSubscription(OWNER, { customerId: "cus_export_lesson", subscriptionId: "sub_export_lesson", active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const headers = { "content-type": "application/json", "x-nimbus-store": store.sid!, cookie: `${SESSION_COOKIE}=${session}` };
  const call = async (body: Record<string, unknown>) => {
    const response = await courseRoute(new NextRequest("https://marktmorgen.com/api/store/course", { method: "POST", headers, body: JSON.stringify(body) }));
    return (await response.json()) as { ok?: boolean; error?: string };
  };
  const made = await addProduct(OWNER, "Course with text", "", "40");
  if (!made.ok) throw new Error("product not made");
  const id = made.product.id;
  assert.equal((await call({ action: "enable", id })).ok, true);
  const courseId = (await readListing((await storeForEmail(OWNER))!, id))!.course!.id;
  const outline = (await readCourse(courseId))!;
  assert.equal((await call({ action: "edit", id, op: "lesson-add", moduleId: outline.modules[0].id, title: "Lesson with text" })).ok, true);
  assert.equal((await call({ action: "edit", id, op: "lesson-add", moduleId: outline.modules[0].id, title: "Lesson without text" })).ok, true);
  const [withText, withoutText] = lessonsInOrder((await readCourse(courseId))!).map(({ lesson }) => lesson.id);
  assert.equal((await call({ action: "body", id, lessonId: withText, text: "The creator's real lesson text." })).ok, true);

  // Known answers: the text, and "" only for Redis's own null.
  const known = JSON.parse(await textOf(storeExport((await storeForEmail(OWNER))!)));
  const course = known.courses.find((c: { id: string }) => c.id === courseId);
  assert.equal(course.lessonText[withText], "The creator's real lesson text.");
  assert.equal(course.lessonText[withoutText], "");

  const real: Pipeline = redis.pipeline.bind(redis);
  const bodyRead = (c: (string | number)[]) => c[0] === "MGET" && String(c[1]).includes(":body:");
  const cases: [string, (out: unknown[], i: number) => unknown][] = [
    ["not a list", () => "OK"],
    ["a list one short", (out, i) => (out[i] as unknown[]).slice(0, -1)],
    ["a list one long", (out, i) => [...(out[i] as unknown[]), "extra"]],
    ["a number for a text", (out, i) => (out[i] as unknown[]).map(() => 7)],
    ["false for a text", (out, i) => (out[i] as unknown[]).map(() => false)],
  ];
  try {
    for (const [name, reply] of cases) {
      (redis as unknown as { pipeline: Pipeline }).pipeline = (async (commands: (string | number)[][]) => {
        const out = await real(commands);
        return commands.map((c, i) => (bodyRead(c) ? reply(out, i) : out[i]));
      }) as Pipeline;
      await assert.rejects(readAllBodies([{ id: courseId, lessons: [withText, withoutText] }]), `${name}: the read refuses`);
      const file = await textOf(storeExport((await storeForEmail(OWNER))!));
      const parsed = JSON.parse(file);
      // Rule 23 (claude5/store-export-exact): the lessons' text that cannot be read no longer takes the whole part
      // (products and outlines) with it. The products and the course outlines stay; no course carries a lessonText
      // written from the unknown answer, and the file says the text could not be read (lessonTextNote), where it
      // said "unreadPart2" and had no products or courses at all.
      assert.equal(parsed.courses.length, 1, `${name}: the course outline is kept`);
      assert.equal("lessonText" in parsed.courses[0], false, `${name}: no lesson text written from an unknown answer`);
      assert.equal(parsed.products.length, 1, `${name}: the products are kept`);
      assert.match(file, /"lessonTextNote":"The lessons' text could not be read just now/, `${name}: the export says the text could not be read`);
      assert.doesNotMatch(file, new RegExp(`"${withText}":""`), `${name}: the lesson with text is never written as empty`);
    }
  } finally {
    (redis as unknown as { pipeline: Pipeline }).pipeline = real;
  }
});
