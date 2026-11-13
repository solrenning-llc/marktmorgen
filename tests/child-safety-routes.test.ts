/**
 * The preservation hold (lib/child-safety.ts, C1-20261109-1546-TODOS-70 unit 2)
 * reaches every studio route that changes or deletes a held product's files,
 * not only the product route's remove, edit and publish (independent review
 * of #3471): a link or no link in place of its file, a new file or none, a
 * price option added, changed or removed, its picture, a podcast episode, the
 * course's lessons and handed-in work, and its page's pictures. Each is
 * refused with the neutral `on_hold` (409), before anything is written or
 * deleted; a hold that cannot be read refuses too (503). A product not held is
 * not touched by it, and reordering stays open.
 *
 * Nobody opens, downloads or describes reported content: the titles are
 * neutral placeholders, the files a few placeholder bytes that are never
 * read. Synthetic store, in-memory Redis, every outside call caught here.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { addOption, addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductFile, setProductImage, setProductPage, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { holdReported } from "@/lib/child-safety";
import { readDelivery, readListing } from "@/lib/catalog";
import { editPodcast, readPodcast, savePodcast } from "@/lib/podcast";
import { readCourse } from "@/lib/course";
import { parsePage } from "@/lib/sales-page";
import { readPage, writePage } from "@/lib/sales-page-store";
import { POST as productRoute } from "@/app/api/store/product/route";
import { POST as attachRoute } from "@/app/api/store/file/attach/route";
import { POST as imageRoute } from "@/app/api/store/image/route";
import { POST as podcastRoute } from "@/app/api/store/podcast/route";
import { POST as courseRoute } from "@/app/api/store/course/route";
import { POST as optionRoute } from "@/app/api/store/option/route";
import { POST as pageRoute } from "@/app/api/store/page/route";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { deleted, files } from "./failure-cleanup-world";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

/** Every call the routes made outside this process; the file store is the one in memory (tests/test-config.mjs). */
const outside: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  outside.push(`${init?.method ?? "GET"} ${String(input instanceof Request ? input.url : input)}`);
  return new Response(JSON.stringify({}), { status: 404, headers: { "content-type": "application/json" } });
}) as typeof fetch;

type Handler = (request: NextRequest) => Promise<Response>;
const OWNER = "hold.routes@example.com";
const ORIGIN = "https://marktmorgen.com";
/** A picture's path as the store keeps one (lib/product-image.ts). */
const picture = (n: string) => `images/${"a".repeat(24)}/${n.repeat(32)}.jpg`;

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  await claimHandle(OWNER, "holdroutes", "Hold Routes", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_hold", subscriptionId: "sub_hold", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const session = await openSession(OWNER);
  const send = async (route: Handler, path: string, body: Record<string, unknown>) => {
    const response = await route(new NextRequest(`${ORIGIN}/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: ORIGIN, host: "marktmorgen.com" }, body: JSON.stringify(body) }));
    return [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];
  };
  const make = async (title: string) => {
    const made = await addProduct(OWNER, title, "", "19", null);
    if (!made.ok) throw new Error("no product");
    return made.product.id;
  };
  const hold = async (id: string) => {
    const outcome = await holdReported({ kind: "child_safety", url: `${ORIGIN}/@holdroutes/p/${id}` }, (await storeForEmail(OWNER))!);
    if (outcome !== "held") throw new Error(`not held: ${outcome}`);
  };
  const listing = async (id: string) => (await readListing((await storeForEmail(OWNER))!, id))!;

  // What a held product has, set up before the report, as a creator would have made it.
  const item = await make("reported-item-1");
  await setProductFile(OWNER, item, { pathname: `stores/x/${item}/item-1.bin`, name: "item-1.bin", bytes: 4, contentType: "application/octet-stream", addedAt: "" });
  const optioned = await addOption(OWNER, item, "Option A", "29");
  if (!optioned.ok) throw new Error("no option");
  const option = (await listing(item)).options[0].id;
  await setProductFile(OWNER, option, { pathname: `stores/x/${option}/item-1a.bin`, name: "item-1a.bin", bytes: 4, contentType: "application/octet-stream", addedAt: "" });
  await setProductImage(OWNER, item, { path: picture("1"), width: 10, height: 10, alt: "", bytes: 4, small: null });
  await setProductPage(OWNER, item, true);
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  const pictures = { ...parsePage({}), blocks: [{ id: "blk001", kind: "pictures", heading: "", items: [{ path: picture("2"), width: 10, height: 10, alt: "", caption: "" }] }] };
  await writePage(statsId, item, pictures as never, ROOM);

  const show = await make("reported-item-2");
  const enabled = await send(podcastRoute as Handler, "podcast", { action: "enable", id: show });
  if (enabled[0] !== 200) throw new Error("no podcast");
  const podcastId = (await listing(show)).podcast!.id;
  const aired = editPodcast({ id: podcastId, episodes: [] }, { op: "add", pathname: `stores/x/${show}/item-2.bin`, bytes: 4, contentType: "audio/mpeg", title: "Episode A", notes: "", at: 1 });
  if (!aired.ok) throw new Error("no episode");
  await savePodcast(aired.podcast);
  const episode = aired.podcast.episodes[0].id;

  const lessons = await make("reported-item-3");
  await send(courseRoute as Handler, "course", { action: "enable", id: lessons });
  await send(courseRoute as Handler, "course", { action: "edit", id: lessons, op: "module-add", title: "Module A" });
  const courseId = (await listing(lessons)).course!.id;
  const moduleId = (await readCourse(courseId))!.modules[0].id;
  await send(courseRoute as Handler, "course", { action: "edit", id: lessons, op: "lesson-add", moduleId, title: "Lesson A" });
  const lessonId = (await readCourse(courseId))!.modules[0].lessons[0].id;
  if (!lessonId) throw new Error("no lesson");

  for (const id of [item, show, lessons]) await hold(id);
  const ON_HOLD = [409, "on_hold"];
  outside.length = 0;
  deleted.length = 0;

  part("The product route: a link or none in place of its file, and an option's, are refused");
  is("a link over its file", await send(productRoute as Handler, "product", { action: "link", id: item, link: "https://example.com/elsewhere" }), ON_HOLD);
  is("its link taken off", await send(productRoute as Handler, "product", { action: "unlink", id: item }), ON_HOLD);
  is("a link over a price option's file, named by the option", await send(productRoute as Handler, "product", { action: "link", id: option, link: "https://example.com/elsewhere" }), ON_HOLD);
  is("remove, edit and publish say the same neutral word", [
    await send(productRoute as Handler, "product", { action: "remove", id: item }),
    await send(productRoute as Handler, "product", { action: "edit", id: item, title: "Renamed", summary: "", price: "19" }),
    await send(productRoute as Handler, "product", { action: "visibility", id: item, hidden: false }),
  ], [ON_HOLD, ON_HOLD, ON_HOLD]);

  part("Its file, from the file route");
  is("a new file over it", await send(attachRoute as Handler, "file/attach", { id: item, pathname: `stores/x/${item}/item-1b.bin` }), ON_HOLD);
  is("its file taken off", await send(attachRoute as Handler, "file/attach", { id: item, detach: true }), ON_HOLD);
  is("a price option's file taken off", await send(attachRoute as Handler, "file/attach", { id: option, detach: true }), ON_HOLD);

  part("Its price options");
  is("an option removed, with its file", await send(optionRoute as Handler, "option", { action: "remove", id: option }), ON_HOLD);
  is("an option changed", await send(optionRoute as Handler, "option", { action: "edit", id: option, label: "Option B", price: "39" }), ON_HOLD);
  is("an option added", await send(optionRoute as Handler, "option", { action: "add", id: item, label: "Option C", price: "49" }), ON_HOLD);

  part("Its picture");
  is("removed", await send(imageRoute as Handler, "image", { action: "remove", id: item }), ON_HOLD);
  is("replaced", await send(imageRoute as Handler, "image", { action: "attach", id: item, path: picture("3"), width: 10, height: 10 }), ON_HOLD);
  is("its description changed", await send(imageRoute as Handler, "image", { action: "alt", id: item, alt: "Changed" }), ON_HOLD);

  part("Its page");
  is("saved without the picture it showed", await send(pageRoute as Handler, "page", { id: item, page: { blocks: [] } }), ON_HOLD);
  is("cleared", await send(pageRoute as Handler, "page", { id: item, page: null }), ON_HOLD);

  part("Its podcast");
  is("an episode removed, with its audio", await send(podcastRoute as Handler, "podcast", { action: "remove", id: show, episode }), ON_HOLD);
  is("an episode changed", await send(podcastRoute as Handler, "podcast", { action: "edit", id: show, episode, title: "Episode B", notes: "" }), ON_HOLD);

  part("Its course");
  is("a lesson removed, with its files", await send(courseRoute as Handler, "course", { action: "edit", id: lessons, op: "lesson-remove", lessonId }), ON_HOLD);
  is("a module removed", await send(courseRoute as Handler, "course", { action: "edit", id: lessons, op: "module-remove", moduleId }), ON_HOLD);
  is("a lesson's file taken off", await send(courseRoute as Handler, "course", { action: "edit", id: lessons, op: "media-remove", lessonId, pathname: "x" }), ON_HOLD);
  is("an assignment taken off, with the work handed in", await send(courseRoute as Handler, "course", { action: "task", id: lessons, lessonId, task: null }), ON_HOLD);

  part("And everything is still there, as it was; nothing deleted, nothing sent out");
  const kept = await listing(item);
  is("its file", kept.file?.pathname, `stores/x/${item}/item-1.bin`);
  is("its option, with the option's file", [kept.options.length, (await readDelivery((await storeForEmail(OWNER))!, option))?.option?.file?.pathname], [1, `stores/x/${option}/item-1a.bin`]);
  is("its picture", [kept.image?.path, kept.image?.alt], [picture("1"), ""]);
  is("its page", (await readPage(statsId, item)).blocks.length, 1);
  is("its episode", (await readPodcast(podcastId))?.episodes.map((entry) => entry.id), [episode]);
  is("its lesson", (await readCourse(courseId))!.modules[0].lessons.map((lesson) => lesson.id), [lessonId]);
  is("still off the store", [kept.hidden, (await listing(show)).hidden, (await listing(lessons)).hidden], [true, true, true]);
  is("no file deleted, no call made", [deleted, outside], [[], []]);

  part("A hold that cannot be read refuses, never lets the change through");
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => (String(commands[0]?.[1] ?? "").startsWith("nl:csa:keep:") ? [42] : real(commands))) as typeof redis.pipeline;
  const unread = [
    await send(attachRoute as Handler, "file/attach", { id: item, detach: true }),
    await send(imageRoute as Handler, "image", { action: "remove", id: item }),
    await send(optionRoute as Handler, "option", { action: "remove", id: option }),
    await send(podcastRoute as Handler, "podcast", { action: "remove", id: show, episode }),
    await send(courseRoute as Handler, "course", { action: "edit", id: lessons, op: "lesson-remove", lessonId }),
    await send(pageRoute as Handler, "page", { id: item, page: { blocks: [] } }),
    await send(productRoute as Handler, "product", { action: "link", id: item, link: "https://example.com/elsewhere" }),
  ];
  redis.pipeline = real;
  is("503 from every route", unread.map((answer) => answer[0]), [503, 503, 503, 503, 503, 503, 503]);
  is("and still nothing deleted", [(await listing(item)).file?.pathname, deleted.length], [`stores/x/${item}/item-1.bin`, 0]);

  part("A product not held is not touched by it; reordering stays open");
  const free = await make("item-not-held");
  await setProductFile(OWNER, free, { pathname: `stores/x/${free}/free.bin`, name: "free.bin", bytes: 4, contentType: "application/octet-stream", addedAt: "" });
  is("a link over its file goes through", await send(productRoute as Handler, "product", { action: "link", id: free, link: "https://example.com/elsewhere" }), [200, "ok"]);
  is("and its old file is deleted, which is what a refusal above would have shown", deleted.includes(`stores/x/${free}/free.bin`), true);
  is("a held product is moved", (await send(productRoute as Handler, "product", { action: "move", id: item, direction: "up" }))[0], 200);

  part("What the creator reads");
  const messages = readFileSync("lib/studio-messages.ts", "utf8");
  is("one neutral word, said by every studio form, without naming the report", [messages.includes("on_hold:"), /report|child|abuse/i.test(messages.split("on_hold:")[1]?.split("\n")[0] ?? "report")], [true, false]);
  is("the old word is gone", readFileSync("components/product-editor.tsx", "utf8").includes("held_for_report"), false);

  done();
}

main();
