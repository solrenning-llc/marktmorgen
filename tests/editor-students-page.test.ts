/**
 * ALL-160, the students page (synthetic only). The studio's page for a course's students
 * (app/studio/students/page.tsx, "Filter students and change many at once") and its bulk route
 * (app/api/store/students/route.ts) list and act on students by their email address, and asked
 * only for "products". A team Editor has "products" but not "orders" (lib/team-roles.ts), and
 * buyers' email addresses are orders data (lib/buyer-addresses.ts), so an Editor read every
 * student's address there. Both now also need "orders": the Editor gets the studio's refusal,
 * the page as on every screen it may not open (team=forbidden) and the route as every role
 * refusal (403, "role"). The owner and the Admin keep both.
 *
 * In-memory Redis (tests/redis-stub.ts), a stand-in next/headers and next/navigation; no network.
 */
import { NextRequest } from "next/server";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCourse, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { emailKey } from "@/lib/learn";
import { saveCourse, type Course } from "@/lib/course";
import StudioStudentsPage from "@/app/studio/students/page";
import { POST as studentsPost } from "@/app/api/store/students/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const OWNER = "all160s-owner@example.com";
const EDITOR = "all160s-editor@example.com";
const ADMIN = "all160s-admin@example.com";
const STUDENT = "all160s-student@example.com";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "allonesixtys", "All 160 Students", "Courses.");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  let store = (await storeForEmail(OWNER))!;
  is("the editor is put on the team", await putMember(store, EDITOR, "editor"), true);
  is("the admin is put on the team", await putMember(store, ADMIN, "admin"), true);
  const cookie = async (who: string) => `${SESSION_COOKIE}=${await openSession(who)}`;

  const course = await addProduct(OWNER, "Desk Course", "A short course.", "49", null);
  if (!course.ok) throw new Error("no course product");
  const courseId = "c0ffee00c0ffee00c0ffee00c0ffee01";
  const outline = { id: courseId, certificate: false, startsAt: null, modules: [{ id: "all160smodule", title: "Start", dripDays: 0, lessons: [{ id: "all160slesson", title: "One" }] }] } as unknown as Course;
  store = (await storeForEmail(OWNER))!;
  await saveCourse(outline, store, true);
  await setProductCourse(OWNER, course.product.id, { id: courseId, lessons: 1 });
  redis.run(["HSET", `nl:course:${courseId}:students`, emailKey(STUDENT), JSON.stringify({ e: STUDENT, s: 1_760_000_000, l: 1_760_000_500 })]);

  /** The page as `who`: "redirect <to>" when it sends them away, "drawn" when it renders. */
  const page = async (who: string): Promise<string> => {
    answering(new Request("https://marktmorgen.com/studio", { headers: { cookie: await cookie(who) } }));
    try {
      await StudioStudentsPage({ searchParams: Promise.resolve({ product: course.product.id }) } as never);
      return "drawn";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return message.startsWith("REDIRECT ") ? `redirect ${message.includes("team=forbidden") ? "forbidden" : "elsewhere"}` : `error ${message}`;
    } finally {
      answering(null);
    }
  };
  const bulk = async (who: string) => {
    const response = await studentsPost(
      new NextRequest("https://marktmorgen.com/api/store/students", {
        method: "POST",
        headers: { cookie: await cookie(who), "content-type": "application/json", host: "marktmorgen.com", origin: "https://marktmorgen.com", "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ action: "review", id: course.product.id, change: "revoke", emails: [STUDENT] }),
      }),
    );
    const body = (await response.json()) as { error?: string };
    return { status: response.status, error: body.error ?? "", leaks: JSON.stringify(body).includes(STUDENT) };
  };

  part("The students page: an Editor (products, no orders) is refused, as on other screens it may not open");
  is("the editor is sent to the studio's refusal", await page(EDITOR), "redirect forbidden");
  part("The students page: the owner and the admin still open it");
  is("the owner opens it", await page(OWNER), "drawn");
  is("the admin opens it", await page(ADMIN), "drawn");

  part("The bulk route: the Editor is refused before anything is read");
  const editor = await bulk(EDITOR);
  is("403, as every role refusal", [editor.status, editor.error], [403, "role"]);
  is("no student's address in the answer", editor.leaks, false);
  part("The bulk route: the owner is not refused for their role");
  const owner = await bulk(OWNER);
  is("the owner is not answered with a role refusal", owner.status === 403 && owner.error === "role", false);

  done();
}

void main();
