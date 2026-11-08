/**
 * 631 [AA1] (a), unit 10: an agent reads a course's outline and a lesson's
 * text through the real MCP route with a synthetic store. Files are named,
 * never located; another store's course is never read; unknown ids say so.
 */
import { POST } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { editCourse, emptyCourse, saveBody, saveCourse } from "@/lib/course";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const OWNER = "mcp-course-tools@example.com";
const OTHER = "mcp-course-tools-other@example.com";

async function courseFor(email: string, title: string) {
  const made = await addProduct(email, title, "", "49", null);
  if (!made.ok) throw new Error("no product");
  let course = emptyCourse();
  for (const lesson of ["Starter dough", "First loaf"]) {
    const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title: lesson });
    if (!added.ok) throw new Error("no lesson");
    course = added.course;
  }
  course = { ...course, modules: course.modules.map((m) => ({ ...m, lessons: m.lessons.map((l, i) => (i === 0 ? { ...l, files: [{ pathname: "private/abc/secret-path/worksheet.pdf", name: "Worksheet.pdf", bytes: 10, contentType: "application/pdf", addedAt: "2026-11-02T00:00:00Z" }] } : l)) })) };
  await saveCourse(course, ROOM);
  const set = await setProductCourse(email, made.product.id, { id: course.id, lessons: 2 });
  if (!set.ok) throw new Error("not a course");
  return { product: made.product.id, course };
}

async function main(): Promise<void> {
  redis.clear();
  const previousFetch = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = (async () => {
    outside += 1;
    throw new Error("No outside requests in this test");
  }) as typeof fetch;
  try {
    for (const [email, handle] of [[OWNER, "mcp-course-tools"], [OTHER, "mcp-course-other"]] as const) {
      await claimHandle(email, handle, "Course Tools", "");
      await ensureStatsId(email);
      await setSubscription(email, { customerId: `cus_${handle.replace(/-/g, "")}`.slice(0, 24), subscriptionId: `sub_${handle.replace(/-/g, "")}`.slice(0, 24), active: true, tier: "pro", cycle: "month", period: paidPeriod() });
    }
    const mine = await courseFor(OWNER, "Bread Course");
    const theirs = await courseFor(OTHER, "Their Course");
    const first = mine.course.modules[0].lessons[0].id;
    await saveBody(mine.course.id, first, "Mix flour and water.", ROOM);
    const store = (await storeForEmail(OWNER))!;
    const made = await makeKey(store.sid, "Synthetic reader");
    if (!made.ok) throw new Error("No synthetic key");
    let id = 0;
    const tool = async (name: string, args: Record<string, unknown>) => {
      const response = await POST(new Request("https://marktmorgen.com/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${made.key}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
      }));
      const body = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };
      return { isError: body.result.isError, raw: body.result.content[0].text, value: JSON.parse(body.result.content[0].text) as Record<string, unknown> };
    };

    part("The outline");
    const outline = await tool("get_course_outline", { product: mine.product });
    const modules = outline.value.modules as { lessons: { title: string; files: string[] }[] }[];
    is("answers with the lessons in order", [outline.isError, modules[0].lessons.map((l) => l.title)], [false, ["Starter dough", "First loaf"]]);
    is("files by name", modules[0].lessons[0].files, ["Worksheet.pdf"]);
    is("never where they are kept", outline.raw.includes("secret-path"), false);

    part("A lesson");
    const lesson = await tool("get_lesson", { product: mine.product, lesson: first });
    is("its text, as written", [lesson.isError, lesson.value.title, lesson.value.text], [false, "Starter dough", "Mix flour and water."]);
    is("no quiz or task yet reads as none", [lesson.value.quiz, lesson.value.task], [null, null]);

    part("Only this store's courses; unknown ids say so");
    is("another store's course is not read", (await tool("get_course_outline", { product: theirs.product })).isError, true);
    is("nor its lessons", (await tool("get_lesson", { product: theirs.product, lesson: theirs.course.modules[0].lessons[0].id })).isError, true);
    is("a lesson of another course under this product is not read", (await tool("get_lesson", { product: mine.product, lesson: theirs.course.modules[0].lessons[0].id })).value, { error: "There is no such lesson in this store's courses. Use get_course_outline for the ids." });
    is("a product that is not a course", (await tool("get_course_outline", { product: "nope" })).value, { error: "There is no course with that id in this store. Use list_products for the ids." });

    is("nothing reached outside", outside, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
  done();
}

void main();
