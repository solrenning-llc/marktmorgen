/**
 * The studio's lesson text is read exactly (rule 24): a reply that is neither
 * the text nor "no text" is unknown, and the editor says it could not be read
 * instead of opening an empty box with a Save button over the creator's real
 * text. The quiz and assignment editors already refuse the same way.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { GET as courseGet, POST as courseRoute } from "@/app/api/store/course/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { lessonsInOrder, readCourse } from "@/lib/course";
import { readListing } from "@/lib/catalog";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const OWNER = "course-lesson-text-exact@example.com";

type Pipeline = typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "lessontextexact", "Lesson Text Exact", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_LessonExact", true);
  await setSubscription(OWNER, { customerId: "cus_lesson_text_exact", subscriptionId: "sub_lesson_text_exact", active: true, tier: "creator", period: paidPeriod() });
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
  if (!(await call({ action: "enable", id })).ok) throw new Error("course not enabled");
  const courseId = (await readListing((await storeForEmail(OWNER))!, id))!.course!.id;
  const outline = (await readCourse(courseId))!;
  if (!(await call({ action: "edit", id, op: "lesson-add", moduleId: outline.modules[0].id, title: "Lesson with text" })).ok) throw new Error("lesson not added");
  if (!(await call({ action: "edit", id, op: "lesson-add", moduleId: outline.modules[0].id, title: "Lesson without text" })).ok) throw new Error("lesson not added");
  const [withText, withoutText] = lessonsInOrder((await readCourse(courseId))!).map(({ lesson }) => lesson.id);
  if (!(await call({ action: "body", id, lessonId: withText, text: "The creator's real lesson text." })).ok) throw new Error("text not saved");
  const get = async (lessonId: string) => {
    const response = await courseGet(new NextRequest(`https://marktmorgen.com/api/store/course?id=${id}&lessonId=${lessonId}`, { headers }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; text?: string; error?: string } };
  };
  const real: Pipeline = redis.pipeline.bind(redis);
  const answerBodyReadWith = (reply: (out: unknown[], i: number) => unknown) => {
    (redis as unknown as { pipeline: Pipeline }).pipeline = (async (commands: (string | number)[][]) => {
      const out = await real(commands);
      return commands.map((c, i) => (c[0] === "GET" && String(c[1]).includes(":body:") ? reply(out, i) : out[i]));
    }) as Pipeline;
  };

  part("Known replies");
  const known = await get(withText);
  is("a lesson's text is read as it is kept", [known.status, known.body.ok, known.body.text], [200, true, "The creator's real lesson text."]);
  const none = await get(withoutText);
  is("a lesson with no text kept reads as no text", [none.status, none.body.ok, none.body.text], [200, true, ""]);

  part("Unknown replies");
  for (const [label, reply] of [
    ["a number", () => 1],
    ["an object", () => ({ odd: true })],
    ["a missing reply", () => undefined],
  ] as const) {
    answerBodyReadWith(reply);
    const odd = await get(withText).finally(() => {
      (redis as unknown as { pipeline: Pipeline }).pipeline = real;
    });
    is(`${label} in place of the text is unknown, never an empty lesson`, [odd.status, odd.body.ok, odd.body.text], [503, false, undefined]);
  }

  part("The studio's editor");
  const editor = readFileSync("components/course-editor.tsx", "utf8");
  const load = editor.slice(editor.indexOf("async function loadText()"), editor.indexOf("async function upload("));
  is("the lesson-text loader is found", load.length > 0, true);
  is("a failed or unknown read never opens an empty text box", /setText\(""\)|data\.ok \? data\.text \?\? "" : ""/.test(load), false);
  is("a failed or unknown read is said, as the quiz and assignment editors say theirs", load.includes("The lesson text could not be read just now."), true);
  is("only a text that came back as text is put in the box", /typeof data\.text [!=]== "string"/.test(load), true);
  done();
}

void main();
