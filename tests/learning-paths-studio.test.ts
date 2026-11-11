/**
 * 249 [ST2], unit 3: the studio screen where a creator keeps the store's
 * learning paths (app/studio/learning-paths/page.tsx,
 * components/learning-paths-editor.tsx) and the route that saves them
 * (app/api/store/learning-paths/route.ts, lib/learning-paths.ts savePaths).
 * Synthetic only: the in-memory Redis double, through the real route.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import * as route from "@/app/api/store/learning-paths/route";
import { LearningPathsEditor } from "@/components/learning-paths-editor";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readPaths } from "@/lib/learning-paths";
import { MAX_PATHS, MAX_PATH_COURSES, MAX_PATH_NAME } from "@/lib/learning-path-rules";
import { PATHS_BODY_BYTES, courseChoices, pathsRefusal } from "@/lib/learning-paths-studio";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Reply = { ok?: boolean; error?: string; message?: string; problem?: string; index?: number; paths?: { id: string; name: string; courses: string[]; order: string }[] };

async function main(): Promise<void> {
  part("The words and the choices (pure)");
  is("a refusal names the path by its place, counted from 1", pathsRefusal("name", 1).startsWith("Path 2:"), true);
  is("and says the name's limit", pathsRefusal("name", 0).includes(String(MAX_PATH_NAME)), true);
  is("a course refusal says how many courses a path takes", pathsRefusal("courses", 0).includes(`2 to ${MAX_PATH_COURSES}`), true);
  is("too many paths says the most a store keeps", pathsRefusal("too_many", -1).includes(String(MAX_PATHS)), true);
  is("a list that does not read names no path", pathsRefusal("list", -1).startsWith("Path"), false);
  is("every refusal is one plain sentence or two, never empty", (["name", "courses", "order", "too_many", "list"] as const).every((p) => pathsRefusal(p, 0).length > 10), true);
  is(
    "only products with a course are offered, in the catalog's order, by title",
    courseChoices([
      { id: "a", title: "Bread", course: { id: "c1", lessons: 3 } },
      { id: "b", title: "Ebook", course: null },
      { id: "c", title: "Pastry", course: { id: "c2", lessons: 0 } },
    ]),
    [{ id: "a", title: "Bread" }, { id: "c", title: "Pastry" }],
  );
  const worst = JSON.stringify({ paths: Array.from({ length: MAX_PATHS }, (_, i) => ({ id: `abcdefg${i % 10}`, name: "x".repeat(MAX_PATH_NAME * 2), courses: Array.from({ length: MAX_PATH_COURSES }, () => "y".repeat(64)), order: "sequence" })) });
  is("the body limit holds the longest list the rules keep (names counted at two bytes a character)", Buffer.byteLength(worst) <= PATHS_BODY_BYTES, true);
  is("and not much more", PATHS_BODY_BYTES - Buffer.byteLength(worst) < 2_000, true);

  part("The route");
  is("only a POST", Object.keys(route).sort(), ["POST"]);
  const source = readFileSync("app/api/store/learning-paths/route.ts", "utf8");
  is("for whoever may change products, with the body limit", source.includes('guardStoreWrite(request, "products", PATHS_BODY_BYTES)'), true);

  redis.clear();
  const owner = "paths@example.com";
  await claimHandle(owner, "pathshop", "Path Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1TestPaths00001", true);
  await setSubscription(owner, { customerId: "cus_paths", subscriptionId: "sub_paths", active: true, tier: "pro", period: paidPeriod() });
  const ids: string[] = [];
  for (const title of ["Bread School", "Pastry School", "Ebook"]) {
    const added = await addProduct(owner, title, "", "40");
    ids.push(added.ok ? added.product.id : "");
  }
  await setProductCourse(owner, ids[0], { id: "course0001", lessons: 0 });
  await setProductCourse(owner, ids[1], { id: "course0002", lessons: 0 });
  const [bread, pastry, ebook] = ids;
  const statsId = (await storeForEmail(owner))!.statsId!;
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = async (body: unknown, headers: Record<string, string> = { cookie }) => {
    const response = await route.POST(new NextRequest("https://marktmorgen.com/api/store/learning-paths", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply, cache: response.headers.get("cache-control") };
  };

  const out = await post({ paths: [{ name: "Baker", courses: [bread, pastry], order: "sequence" }] }, {});
  is("signed out: refused, nothing kept", [out.status, (await redisPipeline([["GET", `nl:paths:${statsId}`]]))[0]], [401, null]);

  const saved = await post({ paths: [{ name: "  Baker   path ", courses: [bread, pastry], order: "sequence" }] });
  is("a path of two courses is saved", [saved.status, saved.body.ok], [200, true]);
  is("and answered as kept, with its own id", saved.body.paths?.map((p) => [p.name, p.courses, p.order, /^[a-z0-9]{8}$/.test(p.id)]), [["Baker path", [bread, pastry], "sequence", true]]);
  is("never cached", saved.cache, "private, no-store");
  is("what is kept is what was answered", await readPaths(statsId), saved.body.paths);

  const id = saved.body.paths?.[0].id ?? "";
  const again = await post({ paths: [{ id, name: "Baker", courses: [pastry, bread], order: "free" }, { name: "Second", courses: [bread, pastry], order: "sequence" }] });
  is("a path changed keeps its id; a new one gets its own", [again.status, again.body.paths?.[0].id === id, again.body.paths?.[1].id !== id], [200, true, true]);

  const notCourse = await post({ paths: [{ name: "Mixed", courses: [bread, ebook], order: "sequence" }] });
  is("a product that is not a course is refused, saying which path and why", [notCourse.status, notCourse.body.error, notCourse.body.problem, notCourse.body.index, notCourse.body.message?.startsWith("Path 1:")], [400, "refused", "courses", 0, true]);
  is("and nothing changes", (await readPaths(statsId)).length, 2);

  const other = await post({ paths: [{ name: "Elsewhere", courses: [bread, "prodNotHere1"], order: "sequence" }] });
  is("a course of no product of this store is refused", [other.status, other.body.problem], [400, "courses"]);

  const noList = await post({ path: [] });
  is("a body without the list is refused as a whole", [noList.status, noList.body.problem], [400, "list"]);

  const emptied = await post({ paths: [] });
  is("every path taken away is a save of an empty list", [emptied.status, emptied.body.paths, (await readPaths(statsId)).length], [200, [], 0]);

  await redisPipeline([["SET", `nl:paths:${statsId}`, "{not json"]]);
  const unreadable = await post({ paths: [{ name: "Baker", courses: [bread, pastry], order: "sequence" }] });
  is("a kept list that does not read: nothing is said as saved, and it is not written over (rule 24)", [unreadable.status, unreadable.body.error, (await redisPipeline([["GET", `nl:paths:${statsId}`]]))[0]], [503, "unknown", "{not json"]);
  await redisPipeline([["DEL", `nl:paths:${statsId}`]]);

  await redisPipeline([["SET", `nl:paths:lock:${statsId}`, "someone-else", "EX", 60]]);
  const busy = await post({ paths: [{ name: "Baker", courses: [bread, pastry], order: "sequence" }] });
  is("another save in progress: refused as busy, nothing written", [busy.status, busy.body.error, (await redisPipeline([["GET", `nl:paths:${statsId}`]]))[0]], [409, "busy", null]);
  await redisPipeline([["DEL", `nl:paths:lock:${statsId}`]]);

  part("The editor (drawn on the server)");
  const courses = [{ id: bread, title: "Bread School" }, { id: pastry, title: "Pastry School" }];
  const html = renderToStaticMarkup(createElement(LearningPathsEditor, { initial: [{ id: "abcdefgh", name: "Baker", courses: [bread, pastry], order: "sequence" }], courses }));
  is("each path is a group named by its place", /<fieldset[^>]*>\s*<legend[^>]*>Path 1/.test(html), true);
  is("its name field has a label", /<label[^>]*for="path-0-name"/.test(html) && html.includes('id="path-0-name"'), true);
  is("the name field keeps to the rules' limit", html.includes(`maxLength="${MAX_PATH_NAME}"`), true);
  is("the order is a choice of two, said in words", [html.includes('type="radio"'), html.includes("One after another"), html.includes("In any order")], [true, true, true]);
  is("the order is said as a suggestion that never locks a course the student has (review of #3674)", [html.includes("opens when"), html.includes("can still open any course they have")], [false, true]);
  is("the courses are listed in the path's order, by title", html.indexOf("Bread School") < html.indexOf("Pastry School"), true);
  is("a course moves with buttons, never only by dragging (2.5.7)", html.includes("Move up") && html.includes("Move down"), true);
  is("one save for the whole list", (html.match(/type="submit"/g) ?? []).length, 1);
  is("messages are read out when they change", html.includes('role="status"'), true);
  is("every button is a 44px target", [...html.matchAll(/<button [^>]*class="([^"]*)"/g)].every((m) => /min-h-(11|\[44px\])/.test(m[1])), true);

  const few = renderToStaticMarkup(createElement(LearningPathsEditor, { initial: [], courses: [courses[0]] }));
  is("with fewer than two courses, it says so and offers no new path", [few.includes("two courses"), few.includes("Add a path")], [true, false]);

  const unread = renderToStaticMarkup(createElement(LearningPathsEditor, { initial: null, courses }));
  is("a list that could not be read shows no editor and says to try again (rule 24)", [unread.includes("could not be read"), unread.includes("<form")], [true, false]);

  part("The page");
  const page = readFileSync("app/studio/learning-paths/page.tsx", "utf8");
  is("only for whoever may change products", page.includes('studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "products")'), true);
  is("its words never say a course opens only after another", page.includes("opens when"), false);
  is("it draws the studio's trail", page.includes("<StudioTrail"), true);
  is("the courses are read exactly, never dropped when unread", page.includes('readKindExact(store, "course")'), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
