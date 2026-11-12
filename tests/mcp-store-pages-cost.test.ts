/**
 * The store's pages and courses as an agent reads them through the MCP server
 * (631 [AA1] (a), units 9 to 14, #1821) take what they read before reading it,
 * as every other reading past the door (lib/api-read-rules.ts): a product's
 * description, its sales page, a course's outline, a lesson, a page test, how
 * far a page is read, a page's earlier versions and the saved sections.
 *
 *   - Each call takes the door's one request and exactly the further requests
 *     its envelope comes to (apiReadUnits of the listing and the tool's work).
 *   - At every size, up to each record's ceiling, what it reads and what it
 *     sends stay inside that envelope.
 *   - With too few requests left it is refused with the door's sentence, and
 *     none of the store's records is read.
 *
 * Synthetic stores and keys only; no outside request.
 */
import { POST as mcp } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import {
  ABOUT_BYTES, API_UNIT_COMMANDS, COURSE_BYTES, PAGE_BYTES, PAGE_VERSION_BYTES, SAVED_SECTIONS_MAX, SECTION_BYTES, type ReadWork, addWork, apiReadUnits, courseOutlineWork,
  lessonWork, listingsWork, pageReadingWork, pageTestWork, pageVersionsWork, productTextWork, salesPageWork, savedBlocksWork,
} from "@/lib/api-read-rules";
import { listingsToRead } from "@/lib/catalog-read-count";
import { editCourse, emptyCourse, saveBody, saveCourse } from "@/lib/course";
import { MAX_VERSIONS } from "@/lib/sales-page-store";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { addProduct, claimHandle, ensureStatsId, setProductAbout, setProductCourse, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

type Command = (string | number)[];
const RECORDS = ["nl:product:", "nl:course:", "nl:sblocks:", "nl:depth:", "nl:ab:", "nl:catalog:"];
const isRecord = (c: Command) => typeof c[1] === "string" && RECORDS.some((prefix) => (c[1] as string).startsWith(prefix));

let reads: { command: Command; bytes: number }[] = [];
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Command[]) => {
  const answers = await real(batch);
  batch.forEach((command, i) => {
    if (isRecord(command)) reads.push({ command, bytes: Buffer.byteLength(JSON.stringify(answers[i] ?? null) ?? "", "utf8") });
  });
  return answers;
}) as typeof redis.pipeline;
globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

const OWNER = "mcp-pages-cost@example.com";
let id = 0;
let key = "";
const store = async () => (await storeForEmail(OWNER))!;

async function call(name: string, args: Record<string, unknown> = {}) {
  reads = [];
  const response = await mcp(new Request("https://marktmorgen.com/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  }));
  const body = (await response.json()) as { result?: { content: { text: string }[]; isError: boolean }; error?: { code: number; message: string } };
  const text = body.result?.content[0].text ?? "";
  return { body, text, sent: Buffer.byteLength(text, "utf8") };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "mcp-pages-cost", "Pages Cost", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PagesCost00001", subscriptionId: "sub_PagesCost00001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const made = await makeKey((await store()).sid, "Synthetic reader");
  if (!made.ok) throw new Error("no synthetic key");
  key = made.key;

  // A product with a description, and a course with one lesson.
  const product = await addProduct(OWNER, "Guide", "A guide.", "29", null);
  if (!product.ok) throw new Error("no product");
  const p = product.product.id;
  await setProductAbout(OWNER, p, true);
  const courseProduct = await addProduct(OWNER, "Bread Course", "", "49", null);
  if (!courseProduct.ok) throw new Error("no course product");
  let course = emptyCourse();
  const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title: "Starter dough" });
  if (!added.ok) throw new Error("no lesson");
  course = added.course;
  await saveCourse(course, ROOM);
  const set = await setProductCourse(OWNER, courseProduct.product.id, { id: course.id, lessons: 1 });
  if (!set.ok) throw new Error("not a course");
  const c = courseProduct.product.id;
  const lesson = course.modules[0].lessons[0].id;
  await saveBody(course.id, lesson, "Mix flour and water.", ROOM);
  const statsId = (await store()).statsId!;

  // Each tool, its arguments and its envelope as the store stands.
  const versionsKept = async () => Number(await real([["LLEN", `nl:product:pages:${statsId}:${p}`]]).then((r) => r[0]));
  const sectionsHeld = async () => Number(await real([["HLEN", `nl:sblocks:${statsId}`]]).then((r) => r[0]));
  const tools: { name: string; args: Record<string, unknown>; product: string; work: () => Promise<ReadWork> }[] = [
    { name: "get_product_description", args: { product: p }, product: p, work: async () => productTextWork() },
    { name: "get_sales_page", args: { product: p }, product: p, work: async () => salesPageWork() },
    { name: "get_course_outline", args: { product: c }, product: c, work: async () => courseOutlineWork() },
    { name: "get_lesson", args: { product: c, lesson }, product: c, work: async () => lessonWork() },
    { name: "get_page_test", args: { product: p }, product: p, work: async () => pageTestWork() },
    { name: "get_page_reading", args: { product: p }, product: p, work: async () => pageReadingWork() },
    { name: "get_page_versions", args: { product: p }, product: p, work: async () => pageVersionsWork(await versionsKept(), false) },
    { name: "get_page_versions", args: { product: p, version: 0 }, product: p, work: async () => pageVersionsWork(await versionsKept(), true) },
    { name: "list_saved_blocks", args: {}, product: "", work: async () => savedBlocksWork(await sectionsHeld()) },
  ];
  const envelope = async (t: (typeof tools)[number]) => addWork(listingsWork(t.product ? listingsToRead(await store(), [t.product]) : 0), await t.work());

  part("Each call takes the door's request and exactly what its envelope comes to");
  for (const t of tools) {
    const before = await allowanceUsed(await store(), "api");
    const units = apiReadUnits(await envelope(t));
    const answered = await call(t.name, t.args);
    const after = await allowanceUsed(await store(), "api");
    is(`${t.name}${"version" in t.args ? " (one version)" : ""}: answered, and took 1 + ${units}`, [answered.body.error ?? null, after - before], [null, 1 + units]);
  }

  part("At every size up to each record's ceiling, what is read and sent stays inside the envelope");
  const fill = (bytes: number) => "€".repeat(Math.floor(bytes / 3) - 8);
  for (const [label, write] of [
    ["as small as they come", async () => {}],
    ["each record at its ceiling", async () => {
      // Raw values at each ceiling, three bytes a character: what is read is measured whether or not it parses.
      await real([
        ["SET", `nl:product:about:${statsId}:${p}`, fill(ABOUT_BYTES)],
        ["SET", `nl:product:page:${statsId}:${p}`, fill(PAGE_BYTES)],
        ["SET", `nl:course:${course.id}`, fill(COURSE_BYTES)],
        ["DEL", `nl:product:pages:${statsId}:${p}`],
        ...Array.from({ length: MAX_VERSIONS + 3 }, (): Command => ["RPUSH", `nl:product:pages:${statsId}:${p}`, `1730000000000\n${fill(PAGE_VERSION_BYTES - 16)}`]),
        ...Array.from({ length: SAVED_SECTIONS_MAX }, (_, i): Command => ["HSET", `nl:sblocks:${statsId}`, `s${i}`, fill(SECTION_BYTES)]),
      ]);
    }],
  ] as const) {
    await write();
    for (const t of tools) {
      const work = await envelope(t);
      const answered = await call(t.name, t.args);
      const read = reads.reduce((n, r) => n + r.bytes, 0);
      is(`${label}, ${t.name}${"version" in t.args ? " (one version)" : ""}: ${reads.length} record commands and ${read} bytes read, ${answered.sent} sent, within ${work.commands} commands, ${work.bytes} bytes and ${work.sent} sent`, [reads.length <= work.commands, read <= work.bytes, answered.sent <= work.sent], [true, true, true]);
    }
  }
  is("the envelope's commands stay in one request's share", apiReadUnits(addWork(listingsWork(1), lessonWork())) >= Math.ceil((1 + lessonWork().commands) / API_UNIT_COMMANDS), true);

  part("With too few requests left, refused with the door's sentence, and no record is read");
  const s = await store();
  const left = allowanceFor(s, "api") - (await allowanceUsed(s, "api"));
  if (left > 1) await takeAllowance(s, "api", left - 1);
  for (const t of tools) {
    const answered = await call(t.name, t.args);
    const counted = reads.filter((r) => !["LLEN", "HLEN"].includes(String(r.command[0])));
    is(`${t.name}${"version" in t.args ? " (one version)" : ""}: refused, nothing read but the count`, [answered.body.error?.code ?? null, /requests/i.test(answered.body.error?.message ?? ""), counted.length], [-32001, true, 0]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
