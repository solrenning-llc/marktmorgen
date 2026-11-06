/** Actual client components/callbacks plus authenticated actual internal routes; synthetic Node hook host only. */
import assert from "node:assert/strict";
import { createElement } from "react";
import { Socket } from "node:net";
import { fetch as dispatcherFetch } from "undici";
import { NextRequest } from "next/server";
import { CourseEditor } from "@/components/course-editor";
import { BundleEditor } from "@/components/bundle-editor";
import { GET as courseGet, POST as coursePost } from "@/app/api/store/course/route";
import { GET as bundleGet } from "@/app/api/store/bundle/route";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductLink, setSubscription, storeForEmail, storeFolder } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { readBody, readCourse, type Course } from "@/lib/course";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { ClientWorld, ControlledTimers, textOf } from "./j-client-fetch-world";
import { done, is, part } from "./check";

type Guard = { dispatcherAttempts: number; socketAttempts: number; unexpectedFetch: number };
const guard = (globalThis as typeof globalThis & { __jClientNetwork: Guard }).__jClientNetwork;
assert.ok(guard, "transport guards must precede evaluation of the imported graph");
const OWNER = "j-client-fetch@example.test", ORIGIN = "https://marktmorgen.com", ORIGINAL = "Previously saved lesson words. Keep this content.";
type Mode = "healthy" | "http-error" | "network-error" | "invalid-json" | "partial" | "bad-status";
let mode: Mode = "healthy", session = "", productId = "", lessonId = "", courseId = "", folder = "";
let posts: Record<string, unknown>[] = [];
const observations: Record<string, unknown>[] = [];
const internalCalls: string[] = [];
function request(path: string, method = "GET", body?: string) {
  return new NextRequest(new URL(path, ORIGIN), { method, headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, ...(body === undefined ? {} : { body }) });
}
async function post(body: Record<string, unknown>) {
  const response = await coursePost(request("/api/store/course", "POST", JSON.stringify(body)));
  const answer = await response.json() as { ok?: boolean; error?: string; courseId?: string; course?: Course };
  assert.equal(response.ok && answer.ok, true, `actual course setup/write must succeed: ${answer.error ?? response.status}`);
  return answer;
}
let slowOld: { promise: Promise<Response>; resolve: (r: Response) => void } | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), ORIGIN), method = init?.method ?? "GET";
  if (url.origin === ORIGIN && ["/api/store/course", "/api/store/bundle"].includes(url.pathname)) {
    internalCalls.push(`${method} ${url.pathname}`);
    if (method === "GET") {
      if (mode === "network-error") throw new Error("Synthetic internal fetch rejection");
      if (mode === "http-error") return Response.json({ ok: false, error: "server_error" }, { status: 503 });
      if (mode === "invalid-json") return new Response("{", { status: 200, headers: { "content-type": "application/json" } });
      if (mode === "partial") return Response.json({ ok: true });
      if (mode === "bad-status") return Response.json({ ok: true, products: [], matches: 0, more: false }, { status: 503 });
      if (url.pathname === "/api/store/bundle" && url.searchParams.get("q") === "Old" && slowOld) return slowOld.promise;
      return url.pathname === "/api/store/course" ? courseGet(request(url.pathname + url.search)) : bundleGet(request(url.pathname + url.search));
    }
    if (method === "POST" && url.pathname === "/api/store/course") {
      const body = String(init?.body ?? ""); posts.push(JSON.parse(body) as Record<string, unknown>);
      return coursePost(request(url.pathname, method, body));
    }
  }
  guard.unexpectedFetch++;
  throw new Error("Client proof blocks every HTTP call outside its explicit synthetic internal routes");
}) as typeof fetch;

async function mountCourse(body = ORIGINAL) {
  mode = "healthy";
  await post({ action: "body", id: productId, lessonId, text: body });
  const initial = await readCourse(courseId); assert.ok(initial);
  const world = new ClientWorld(createElement(CourseEditor, { productId, initial, folder, openFirst: lessonId }));
  world.render(); posts = [];
  return world;
}
async function mountBundle() {
  const timer = new ControlledTimers(); timer.install();
  const world = new ClientWorld(createElement(BundleEditor, { mode: "create", owner: null, initial: [], currency: "usd" }));
  world.render(); await timer.runNext(); world.render();
  return { world, timer };
}
async function clickSaveText(world: ClientWorld) {
  const form = world.one(node => node.type === "form" && textOf(node).includes("Save text"));
  await world.invoke(form, "onSubmit", { preventDefault() {} });
}

async function main() {
  part("Hard network guard controls before any scenario");
  let dispatcherBlocked = false, socketBlocked = false;
  try { await dispatcherFetch("https://client-network-blocked.invalid/probe"); }
  catch (error) { dispatcherBlocked = (error as { cause?: { code?: string } }).cause?.code === "UND_MOCK_ERR_MOCK_NOT_MATCHED"; }
  const socket = new Socket();
  try { socket.connect({ host: "client-network-blocked.invalid", port: 443 }); }
  catch (error) { socketBlocked = error instanceof Error && error.message === "Client proof forbids network sockets"; }
  finally { socket.destroy(); }
  assert.ok(dispatcherBlocked && socketBlocked, "hard-stop if either network guard fails");
  is("SDK dispatcher and socket controls are blocked before transport", [dispatcherBlocked, socketBlocked], [true, true]);

  redis.clear();
  await claimHandle(OWNER, "j-client-fetch", "Synthetic client fetch store", "A synthetic store for local proof.");
  await ensureStatsId(OWNER); await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_JClientFetch", subscriptionId: "sub_JClientFetch", active: true, tier: "creator", period: paidPeriod() });
  session = await openSession(OWNER);
  const made = await addProduct(OWNER, "Existing course", "", "39"); assert.ok(made.ok); productId = made.product.id;
  const enabled = await post({ action: "enable", id: productId }); assert.ok(enabled.courseId); courseId = enabled.courseId;
  const saved = await readCourse(courseId); assert.ok(saved);
  const added = await post({ action: "edit", id: productId, op: "lesson-add", moduleId: saved.modules[0].id, title: "Existing lesson" });
  assert.ok(added.course); lessonId = added.course.modules[0].lessons[0].id;
  const store = await storeForEmail(OWNER); assert.ok(store); folder = await storeFolder(OWNER);
  for (const title of ["Old guide", "New guide"]) { const guide = await addProduct(OWNER, title, "", "19"); assert.ok(guide.ok); assert.equal((await setProductLink(OWNER, guide.product.id, "https://example.test/guide")).ok, true); }
  is("the actual product record points to the saved real course", (await readListing((await storeForEmail(OWNER))!, productId))?.course?.id, courseId);

  part("Course editor: healthy and genuinely empty reads");
  {
    const world = await mountCourse();
    await world.invoke(world.button("Edit the text"), "onClick");
    const textarea = world.one(node => node.type === "textarea" && String(node.props.id).endsWith("-text"));
    is("actual healthy route text reaches the actual client field", textarea.props.value, ORIGINAL);
    await clickSaveText(world);
    is("healthy unchanged Save sends and preserves the original body", [posts.at(-1)?.text, await readBody(courseId, lessonId)], [ORIGINAL, ORIGINAL]);
    world.dispose();
  }
  {
    const world = await mountCourse("");
    await world.invoke(world.button("Write text for this lesson"), "onClick");
    is("an explicitly confirmed empty route body is a legitimate empty field", world.one(node => node.type === "textarea" && String(node.props.id).endsWith("-text")).props.value, "");
    world.dispose();
  }

  part("Course editor: a failed read must not enable saving a fabricated empty body");
  for (const failure of ["http-error", "network-error", "invalid-json", "partial"] as const) {
    const world = await mountCourse(); mode = failure;
    await world.invoke(world.button("Edit the text"), "onClick");
    const textareas = world.nodes(node => node.type === "textarea" && String(node.props.id).endsWith("-text"));
    const blank = textareas.some(node => node.props.value === "");
    const saves = world.nodes(node => node.type === "button" && textOf(node) === "Save text" && node.props.disabled !== true);
    const beforeSave = await readBody(courseId, lessonId);
    if (saves.length) await clickSaveText(world);
    const afterSave = await readBody(courseId, lessonId);
    observations.push({ component: "CourseEditor/LessonEditor", failure, blankField: blank, enabledSave: saves.length > 0, storedBeforeSave: beforeSave, sentText: posts.at(-1)?.text, storedAfterSave: afterSave, alertVisible: world.nodes(node => node.props.role === "alert").length > 0 });
    is(`${failure}: the failed read itself did not alter the real saved body`, beforeSave, ORIGINAL);
    is(`${failure}: no unconfirmed empty editor with an enabled Save action`, blank && saves.length > 0, false);
    is(`${failure}: unchanged Save after failed loading cannot erase the actual saved body`, afterSave, ORIGINAL);
    world.dispose();
  }

  part("Bundle picker: healthy, known-empty and explicit failures");
  mode = "healthy";
  {
    const { world, timer } = await mountBundle();
    is("actual healthy bundle route products reach the actual picker", world.text().includes("Old guide") && world.text().includes("New guide"), true);
    await world.invoke(world.one(node => node.type === "input" && node.props.id === "bundle-find"), "onChange", { target: { value: "nothing-matches-this" } });
    await timer.runNext(); world.render();
    is("a confirmed empty query may show the actual no-match message", world.text().includes("Nothing has that in its name."), true);
    world.dispose(); timer.restore();
  }
  for (const failure of ["http-error", "network-error", "invalid-json"] as const) {
    mode = failure; const { world, timer } = await mountBundle();
    is(`${failure}: existing explicit error handling shows an alert rather than an empty result`, [world.nodes(node => node.props.role === "alert").length > 0, world.text().includes("Your store has no other products yet.")], [true, false]);
    world.dispose(); timer.restore();
  }
  part("Bundle picker: partial JSON and failed HTTP status must remain unknown");
  for (const failure of ["partial", "bad-status"] as const) {
    mode = failure; const { world, timer } = await mountBundle();
    const falseEmpty = world.text().includes("Your store has no other products yet.");
    observations.push({ component: "BundleEditor", failure, falseEmpty, alertVisible: world.nodes(node => node.props.role === "alert").length > 0 });
    is(`${failure}: an unconfirmed response cannot claim that the populated store has no other products`, falseEmpty, false);
    world.dispose(); timer.restore();
  }

  part("Bundle picker: the existing late-response fence is a passing race control");
  mode = "healthy";
  {
    const { world, timer } = await mountBundle();
    let resolveOld!: (r: Response) => void;
    slowOld = { promise: new Promise<Response>(resolve => { resolveOld = resolve; }), resolve: response => resolveOld(response) };
    const search = () => world.one(node => node.type === "input" && node.props.id === "bundle-find");
    await world.invoke(search(), "onChange", { target: { value: "Old" } });
    const oldPending = timer.runNext();
    await world.invoke(search(), "onChange", { target: { value: "New" } });
    await timer.runNext(); world.render();
    slowOld.resolve(await bundleGet(request("/api/store/bundle?q=Old&page=1"))); await oldPending; world.render();
    is("the late old query cannot replace the newer actual route result", [world.text().includes("New guide"), world.text().includes("Old guide")], [true, false]);
    slowOld = null; world.dispose(); timer.restore();
  }
  is("no SDK, direct socket or unmatched HTTP escapes the deliberate blocked controls", [guard.dispatcherAttempts, guard.socketAttempts, guard.unexpectedFetch], [1, 1, 0]);
  console.log(JSON.stringify({ source: "5c07315505e1d53ee6401021601cd688fa98ecda", runtime: "actual components/React elements/handlers and authenticated routes; controlled Node hook/effect host, no DOM/hydration", observations, internalCalls }));
  done();
}
main().catch(error => { console.error("CLIENT HARNESS/SETUP FAILURE: not automatically a product RED", error); process.exitCode = 2; });
