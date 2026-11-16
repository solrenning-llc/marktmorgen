/**
 * ALL-160 (synthetic only): a team Editor has "products" but not "orders"
 * (lib/team-roles.ts). Buyers' email addresses are orders data, so an Editor
 * must not read them, while the rest of the screen keeps working:
 *
 *   - the license keys a product gave (app/api/store/keys/route.ts GET) come
 *     without the buyer's address, a search by that address finds nothing,
 *     and the answer says so (`buyers: false`) for the editor to show the line
 *     "You need the Orders permission to see buyers' email addresses.";
 *   - the course page (app/studio/course/[product]/page.tsx) lists the
 *     students and certificates without their addresses, anywhere in the
 *     tree it returns, client component props included, and says why;
 *   - the owner, and a role with "orders", still see the addresses.
 *
 * In-memory Redis (tests/redis-stub.ts), a stand-in next/headers; no network.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { isValidElement } from "react";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCourse, setProductKeys, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { keyForSale } from "@/lib/licence-keys";
import { readListing } from "@/lib/catalog";
import { emailKey } from "@/lib/learn";
import { saveCourse, type Course } from "@/lib/course";
import { GET as keysGet } from "@/app/api/store/keys/route";
import StudioCoursePage from "@/app/studio/course/[product]/page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const OWNER = "all160-owner@example.com";
const EDITOR = "all160-editor@example.com";
const ADMIN = "all160-admin@example.com";
const BUYER = "all160-buyer@example.com";
const STUDENT = "all160-student@example.com";
const MESSAGE = "You need the Orders permission to see buyers' email addresses.";

const read = (path: string) => (existsSync(join(process.cwd(), path)) ? readFileSync(join(process.cwd(), path), "utf8") : "");

/** Every string in a React tree: text, and every string prop of every element, client components included. */
async function strings(node: unknown, out: string[] = []): Promise<string[]> {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (typeof (node as PromiseLike<unknown>).then === "function") return strings(await node, out);
  if (Array.isArray(node)) {
    for (const child of node) await strings(child, out);
    return out;
  }
  if (!isValidElement(node)) {
    if (typeof node === "object") for (const value of Object.values(node as Record<string, unknown>)) await strings(value, out);
    return out;
  }
  const { type, props } = node as { type: unknown; props: Record<string, unknown> };
  if (typeof type === "function" && type.constructor.name === "AsyncFunction") return strings(await (type as (p: unknown) => Promise<unknown>)(props), out);
  for (const value of Object.values(props)) await strings(value, out);
  return out;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "allonesixty", "All 160 Shop", "Keys and courses.");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  let store = (await storeForEmail(OWNER))!;
  is("the editor is put on the team", await putMember(store, EDITOR, "editor"), true);
  is("the admin is put on the team", await putMember(store, ADMIN, "admin"), true);
  const cookie = async (who: string) => `${SESSION_COOKIE}=${await openSession(who)}`;

  // A product that gives license keys, one key given to a buyer.
  const tool = await addProduct(OWNER, "Desk Tool", "A small tool.", "19", null);
  if (!tool.ok) throw new Error("no product");
  await setProductKeys(OWNER, tool.product.id, { source: "generated", prefix: "ALL", groups: 4, groupLength: 4, lowAt: 0 });
  store = (await storeForEmail(OWNER))!;
  const listing = (await readListing(store, tool.product.id))!;
  const given = await keyForSale(store, listing, "cs_test_all160sale0001", BUYER);
  is("a key was given to the buyer", Boolean(given), true);

  type KeysReply = { ok: boolean; buyers?: boolean; keys?: { key: string; email: string }[]; matching?: number };
  const keys = async (who: string, q = ""): Promise<KeysReply> => {
    const url = `https://marktmorgen.com/api/store/keys?id=${tool.product.id}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
    const response = await keysGet(new NextRequest(url, { headers: { cookie: await cookie(who) } }));
    return (await response.json()) as KeysReply;
  };

  part("License keys: an Editor sees the keys, never the buyer's address");
  const editorKeys = await keys(EDITOR);
  is("the editor still reads the keys given", [editorKeys.ok, editorKeys.keys?.length], [true, 1]);
  is("without the buyer's email address", editorKeys.keys?.map((k) => k.email), [""]);
  is("and the answer says the addresses are held back", editorKeys.buyers, false);
  is("nowhere in the answer is the address", JSON.stringify(editorKeys).includes(BUYER), false);
  const probed = await keys(EDITOR, BUYER);
  is("a search by the buyer's address finds nothing for the editor", [probed.matching, probed.keys?.length], [0, 0]);
  is("a search by part of the address finds nothing either", (await keys(EDITOR, "all160-buyer")).matching, 0);
  is("a search by the key still works", (await keys(EDITOR, editorKeys.keys?.[0]?.key ?? "x")).matching, 1);

  part("License keys: the owner and an admin, who have Orders, still see it");
  const ownerKeys = await keys(OWNER);
  is("the owner sees the buyer's address", [ownerKeys.keys?.map((k) => k.email), ownerKeys.buyers], [[BUYER], true]);
  is("the owner finds the key by the address", (await keys(OWNER, BUYER)).matching, 1);
  is("an admin sees the buyer's address", (await keys(ADMIN)).keys?.map((k) => k.email), [BUYER]);

  part("License keys: the studio editor shows the line, as text that is announced");
  const editorSource = read("components/licence-key-editor.tsx");
  const statusLine = /<p[^>]*role="status"[^>]*>\s*\{NO_BUYER_ADDRESSES\}\s*<\/p>/.test(editorSource);
  is(
    "the key list says why the addresses are missing, as a status paragraph, and its search does not offer email then",
    [read("lib/buyer-addresses.ts").includes(`"${MESSAGE}"`), statusLine, editorSource.includes("Find by key or order reference")],
    [true, true, true],
  );

  // A course with one student who finished and holds a certificate.
  const course = await addProduct(OWNER, "Desk Course", "A short course.", "49", null);
  if (!course.ok) throw new Error("no course product");
  const courseId = "c0ffee00c0ffee00c0ffee00c0ffee00";
  const outline = { id: courseId, certificate: true, startsAt: null, modules: [{ id: "all160module", title: "Start", dripDays: 0, lessons: [{ id: "all160lesson", title: "One", task: { prompt: "Hand in a sketch." } }] }] } as unknown as Course;
  await saveCourse(outline, store, true);
  await setProductCourse(OWNER, course.product.id, { id: courseId, lessons: 1 });
  redis.run(["HSET", `nl:course:${courseId}:students`, emailKey(STUDENT), JSON.stringify({ e: STUDENT, s: 1_760_000_000, l: 1_760_000_500 })]);
  redis.run(["SADD", `nl:course:${courseId}:done:${emailKey(STUDENT)}`, "all160lesson"]);
  const certId = "abcdefgh12345678";
  redis.run(["SET", `nl:cert:${certId}`, JSON.stringify({ id: certId, name: "Ana Example", email: STUDENT, title: "Desk Course", store: "allonesixty", productId: course.product.id, courseId, issuedAt: 1_760_000_600, withdrawnAt: 0 })]);
  redis.run(["SADD", `nl:course:${courseId}:certs:all`, certId]);
  // Work handed in, waiting for the creator (the course page's "work handed in" rows, CourseWorkStudio): the guard on
  // their studentEmail reads is exercised only with one (Claude 1 cloud MEDIUM on #4233).
  redis.run(["ZADD", `nl:course:${courseId}:tasks:waiting`, "1760000700", `all160lesson|${emailKey(STUDENT)}`]);
  redis.run(["SET", `nl:course:${courseId}:task:all160lesson:sub:${emailKey(STUDENT)}`, JSON.stringify({ text: "my sketch", file: null, at: 1_760_000_700, state: "waiting", feedback: "", reviewedAt: 0, tries: 1 })]);

  const page = async (who: string): Promise<string[]> => {
    answering(new Request("https://marktmorgen.com/studio", { headers: { cookie: await cookie(who) } }));
    try {
      return await strings(await StudioCoursePage({ params: Promise.resolve({ product: course.product.id }), searchParams: Promise.resolve({}) }));
    } finally {
      answering(null);
    }
  };

  part("Course page: an Editor sees the students' progress, never their addresses");
  const editorPage = await page(EDITOR);
  is("the page still draws the students and the certificates", [editorPage.includes("Students"), editorPage.includes("Ana Example"), editorPage.includes("1 of 1")], [true, true, true]);
  is("(control) the work handed in is drawn for the editor", editorPage.some((s) => s.includes("my sketch")), true);
  is("the student's address is nowhere in the page, props included", editorPage.some((s) => s.includes(STUDENT)), false);
  is("the page says why, in plain words", editorPage.includes(MESSAGE), true);

  part("Course page: the owner still sees the addresses");
  const ownerPage = await page(OWNER);
  is("the owner sees the student's address", ownerPage.includes(STUDENT), true);
  is("and no message about the permission", ownerPage.includes(MESSAGE), false);

  done();
}

void main();
