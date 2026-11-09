/**
 * A course's "a module opens" email (lib/learn.ts sendDripEmails) that the
 * sender refuses for certain on every run (rule 30; Claude 5's MEDIUM on the
 * -v3 branches, 9 November 2026).
 *
 * A refusal can come after the store's figure was taken (a stop before the
 * request since #3377, a 4xx after it: a 422 here). The job let the mark go
 * on each one, so every run inside the module's three-day window took the
 * figure again; how many depended only on how often the job runs. Each
 * refusal is now counted (lib/refused-tries.ts) and the mark kept at
 * REFUSED_TRIES. The sender is a stand-in for `fetch`; no real email is sent.
 */
import { registerDrip, sendDripEmails, touchStudent } from "@/lib/learn";
import type { Course } from "@/lib/course";
import { readProduct } from "@/lib/catalog";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setPastBuyers, setProductCourse, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { allowanceUsed } from "@/lib/store-allowance";
import { done, is, part } from "./check";

const asked: string[] = [];
const senderAnswers = new Map<string, () => Response>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const to = [(JSON.parse(String(init?.body)) as { to: string | string[] }).to].flat()[0] ?? "";
    asked.push(to);
    const special = senderAnswers.get(to);
    if (special) return special();
    return new Response(JSON.stringify({ id: `email_${asked.length}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  for (const k of ["AWS_SES_ROLE_ARN", "AWS_SES_REGION", "AWS_SES_CONFIGURATION_SET", "AWS_SES_TOPIC_ARN", "STRIPE_SECRET_KEY"]) delete process.env[k];
  const OWNER = "owner@example.com";
  if (!(await claimHandle(OWNER, "harbor", "Harbor Kitchen", "")).ok) throw new Error("no store");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await setPastBuyers(OWNER);
  const made = await addProduct(OWNER, "Knife skills", "A course", "49", null);
  if (!made.ok) throw new Error("no product");
  const courseId = "c".repeat(32);
  await setProductCourse(OWNER, made.product.id, { id: courseId, lessons: 1 });
  const harbor = (await storeForEmail(OWNER))!;
  const paidStore = { ...harbor, subscriptionActive: true, subscriptionId: null, trialEnds: 0, planEndedAt: "", tier: "pro" as const };
  const product = (await readProduct(harbor, made.product.id))!;
  const lesson = { id: "l1", title: "Holding the knife", preview: false, video: null, files: [], link: null, hasBody: true };
  const course = { id: courseId, modules: [{ id: "m2", title: "Week 2", dripDays: 7, lessons: [lesson] }], certificate: false, startsAt: null } as unknown as Course;

  const now = Math.floor(Date.now() / 1000);
  const refused = "drip-422@example.com";
  // Joined seven days and an hour ago: week 2 opened an hour ago, inside the three-day window for every run below.
  await touchStudent(courseId, refused, now - 7 * 86_400 - 3_600, harbor);
  await registerDrip(harbor, product, course);
  senderAnswers.set(refused, () => new Response(JSON.stringify({ message: "invalid" }), { status: 422 }));

  part("Six runs inside the window, against a sender that refuses for certain");
  const load = async (handle: string) => (handle === "harbor" ? paidStore : null);
  const loadCourse = async (id: string) => (id === courseId ? course : null);
  const before = await allowanceUsed(paidStore, "email");
  // Twelve hours apart: the job is daily today, but nothing here may rest on how often it runs.
  for (let run = 0; run < 6; run += 1) await sendDripEmails(load, loadCourse, "https://marktmorgen.com", now + run * 12 * 3_600);
  is("the sender is asked at most REFUSED_TRIES (3) times", asked.filter((to) => to === refused).length, 3);
  is("the store's figure is taken at most 3 times", (await allowanceUsed(paidStore, "email")) - before, 3);
  is("at the third refusal the mark is kept", redis.keys().some((k) => k.startsWith(`nl:course:${courseId}:dripmail:`)), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
