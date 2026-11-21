/**
 * The MCP read tools of lib/mcp-tools.ts never hand an agent an empty list, an
 * empty text, a "no such course" or a "names were read" for something that
 * was not read (CX-123 rule 24: unknown is never zero, empty, done or no).
 * Each case runs the real tool on a synthetic store, first as a control and
 * then with the one Redis reply it depends on failing or answering in another
 * shape:
 *
 *   - readFullNumbersPaid (get_product_numbers and the other "full" numbers):
 *     products' listings that could not be read are not "listed", so the
 *     answer says they were not read and the hour's copy is not kept without
 *     them;
 *   - productsTool and membershipsTool (titlesFor): products named by their id
 *     because their listings could not be read say so (names_note,
 *     by_product_named false), never that their names were read;
 *   - membershipsTool: recurring revenue by month whose invoices could not be
 *     read (a reading kept without movements) is null, never an empty list,
 *     and so is a by_channel the reading does not hold;
 *   - productTextTool (get_product_description): a description the listing
 *     says exists but that answered in another shape fails, never "";
 *   - readCourseTool and readLessonTool: a course that answered in another
 *     shape fails, never "there is no course".
 *
 * Synthetic data only; no outside request is made.
 */
import { membershipsTool, productsTool, productTextTool, readCourseTool, readFullNumbersPaid, readLessonTool } from "@/lib/mcp-tools";
import { editCourse, emptyCourse, saveBody, saveCourse } from "@/lib/course";
import { writeAbout } from "@/lib/product-about";
import { keepPaths } from "@/lib/next-bought";
import { membershipCacheKey, numbersFrom } from "@/lib/membership-numbers";
import { addProduct, claimHandle, ensureStatsId, setProductAbout, setProductCourse, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No outside requests in this test");
}) as typeof fetch;

type Command = (string | number)[];
const OWNER = "mcp-sweep@example.com";
const realPipeline = redis.pipeline.bind(redis);
// Changes the answer of the pipelines that touch `prefix`, and only those: a throw, or another shape.
let prefix = "";
let twist: "throw" | "number" | null = null;
let twisted = 0;
redis.pipeline = (async (batch: Command[]) => {
  const touches = twist && prefix && batch.some((command) => command.slice(1).some((arg) => String(arg).startsWith(prefix)));
  if (!touches) return realPipeline(batch);
  twisted += 1;
  if (twist === "throw") throw new Error("connection reset");
  return batch.map(() => 42);
}) as typeof redis.pipeline;

async function twisted_<T>(how: "throw" | "number", keys: string, run: () => Promise<T>): Promise<{ value?: T; failed: boolean; twisted: number }> {
  prefix = keys;
  twist = how;
  twisted = 0;
  try {
    return { value: await run(), failed: false, twisted };
  } catch {
    return { failed: true, twisted };
  } finally {
    twist = null;
    prefix = "";
  }
}

const charge = async () => null;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "mcp-sweep", "Sweep Kitchen", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_McpSweep001", subscriptionId: "sub_McpSweep001", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const made = await addProduct(OWNER, "Bread Guide", "", "29", null);
  if (!made.ok) throw new Error("no product");
  const product = made.product.id;
  const aboutSet = await setProductAbout(OWNER, product, true);
  if (!aboutSet.ok) throw new Error("no description flag");
  const course = await addProduct(OWNER, "Bread Course", "", "49", null);
  if (!course.ok) throw new Error("no course product");
  let outline = emptyCourse();
  const added = editCourse(outline, { op: "lesson-add", moduleId: outline.modules[0].id, title: "Starter dough" });
  if (!added.ok) throw new Error("no lesson");
  outline = added.course;
  await saveCourse(outline, ROOM);
  const lesson = outline.modules[0].lessons[0].id;
  await saveBody(outline.id, lesson, "Mix flour and water.", ROOM);
  const linked = await setProductCourse(OWNER, course.product.id, { id: outline.id, lessons: 1 });
  if (!linked.ok) throw new Error("not a course");
  const store = (await storeForEmail(OWNER)) as Store;
  if (!store.statsId || !store.catalog.id || store.catalog.inline) throw new Error("the store keeps its products in records of their own");
  await writeAbout(store.statsId, product, "A guide to bread.", ROOM);
  // Every product past the store record's own first page: each listing is read from its own record.
  const far: Store = { ...store, catalog: { ...store.catalog, head: [] } };
  const listings = `nl:catalog:${store.catalog.id}:l:`;

  part("readFullNumbersPaid: listings that could not be read are not listed");
  const control = await readFullNumbersPaid(far, null);
  is("control: the products are read and listed", [control?.listed, control?.data.products.map((p) => p.title).sort()], [true, ["Bread Course", "Bread Guide"]]);
  const failed = await twisted_("throw", listings, () => readFullNumbersPaid(far, null));
  is("the listings' read is really made to fail", failed.twisted > 0, true);
  is("listings that could not be read are not said to be listed", failed.value?.listed, false);

  part("productsTool: products named by their id say so");
  if (!control) throw new Error("no numbers");
  await keepPaths(store.statsId, { at: Date.now(), starts: { [product]: 3 }, next: {} });
  const unnamed = { ...control.data, products: [] };
  const named = (await productsTool(far, unnamed, "d30")) as { bought_next: { bought_first_most: { product: string }[]; names_note?: string } | null };
  is("control: what buyers bought first is named by its title", [named.bought_next?.bought_first_most[0]?.product, named.bought_next?.names_note], ["Bread Guide", undefined]);
  const byId = await twisted_("throw", listings, () => productsTool(far, unnamed, "d30") as Promise<{ bought_next: { bought_first_most: { product: string }[]; names_note?: string } | null }>);
  is("the names' read is really made to fail", byId.twisted > 0, true);
  is("named by its id when its name could not be read", byId.value?.bought_next?.bought_first_most[0]?.product, product);
  is("and the answer says the names were not read", typeof byId.value?.bought_next?.names_note, "string");

  part("membershipsTool: what was not read is null, never an empty list");
  const members: Store = { ...far, stripeAccountId: "acct_McpSweep01" };
  const reading = numbersFrom([], store.currency, Math.floor(Date.now() / 1000), true) as Record<string, unknown>;
  // As kept when the invoices could not be read (lib/membership-numbers.ts): no movements; and a reading without by_channel.
  delete reading.movements;
  delete reading.byChannel;
  reading.byProduct = [{ product, members: 1, trialing: 0, mrr: 2900 }];
  await redisPipeline([["SET", membershipCacheKey(store.statsId), JSON.stringify(reading), "EX", 600]]);
  const kept = (await membershipsTool(members, charge)) as Record<string, unknown>;
  is("control: the kept reading is read, the product by its title", [(kept.by_product as { product: string }[] | undefined)?.[0]?.product, kept.by_product_named], ["Bread Guide", true]);
  is("recurring revenue by month not read is null, never []", kept.mrr_by_month, null);
  is("each channel not read is null, never []", kept.by_channel, null);
  const memberIds = await twisted_("throw", listings, () => membershipsTool(members, charge) as Promise<Record<string, unknown>>);
  is("the members' product names' read is really made to fail", memberIds.twisted > 0, true);
  is("named by its id when its name could not be read", (memberIds.value?.by_product as { product: string }[] | undefined)?.[0]?.product, product);
  is("and by_product_named says the names were not read", memberIds.value?.by_product_named, false);

  part("productTextTool: a description in another shape is not an empty one");
  const text = await productTextTool(store, product, charge);
  is("control: the description as written", (text as { description?: string } | null)?.description, "A guide to bread.");
  const odd = await twisted_("number", `nl:product:about:${store.statsId}:`, () => productTextTool(store, product, charge));
  is("the description's read is really answered in another shape", odd.twisted > 0, true);
  is("a description that could not be read fails, never \"\"", [odd.failed, (odd.value as { description?: string } | undefined)?.description], [true, undefined]);

  part("readCourseTool and readLessonTool: a course in another shape is not \"no course\"");
  const outlineRead = await readCourseTool(store, course.product.id, charge);
  is("control: the outline is read", (outlineRead as { modules?: unknown[] } | null)?.modules?.length, 1);
  const lessonRead = await readLessonTool(store, course.product.id, lesson, charge);
  is("control: the lesson is read", (lessonRead as { text?: string } | null)?.text, "Mix flour and water.");
  const courseKey = `nl:course:${outline.id}`;
  const oddOutline = await twisted_("number", courseKey, () => readCourseTool(store, course.product.id, charge));
  is("the course's read is really answered in another shape", oddOutline.twisted > 0, true);
  is("an outline that could not be read fails, never \"no course\" (null)", [oddOutline.failed, oddOutline.value ?? "not given"], [true, "not given"]);
  const oddLesson = await twisted_("number", courseKey, () => readLessonTool(store, course.product.id, lesson, charge));
  is("a lesson whose course could not be read fails, never \"no lesson\" (null)", [oddLesson.failed, oddLesson.value ?? "not given"], [true, "not given"]);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
