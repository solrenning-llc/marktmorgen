/**
 * Claude 6's LEVE 1 on #2794 (7057905304): two courses brought over, one record legible and one not. The exact reader
 * (paidCoursesExact, whose contract is that unknown is never "not had") refuses instead of counting the second as
 * not had; the access reader still opens the legible one. Synthetic: the tests' in-memory Redis, a stubbed Stripe.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { addProduct, claimHandle, ensureStatsId, setPastBuyers, setProductCourse, setStripeAccount, storeForEmail, storeRef } from "@/lib/store";
import { importedKey } from "@/lib/imported-purchases";
import { paidCourses, paidCoursesExact } from "@/lib/learn";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_learn_imported_mixed_row";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const JOB = "0123456789abcdef01234567";
const EMAIL = "zed@example.com";

test("a course brought over whose record does not read is unknown to the exact reader, never not had", async () => {
  redis.clear();
  const OWNER = "teacher-mixed@example.com";
  await claimHandle(OWNER, "mixedschool", "Mixed School", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMixedRow01", true);
  const make = async (title: string, course: string) => {
    const made = await addProduct(OWNER, title, "", "15", null);
    if (!made.ok) throw new Error(`no ${title}`);
    await setProductCourse(OWNER, made.product.id, { id: course, lessons: 4 });
    return made.product.id;
  };
  const a = await make("Course A", "a".repeat(32));
  const b = await make("Course B", "b".repeat(32));
  await setPastBuyers(storeRef((await storeForEmail(OWNER))!));
  const store = (await storeForEmail(OWNER))!;
  const at = Math.floor(Date.now() / 1000) - 86_400;
  await redis.pipeline([["HSET", importedKey(store.statsId!, EMAIL), a, JSON.stringify({ at, job: JOB }), b, JSON.stringify({ at, job: JOB, option: "not a valid option" })]]);

  await assert.rejects(paidCoursesExact(store, EMAIL), UnknownReplyError, "the exact reader never counts Course B as not had");
  const open = await paidCourses(store, EMAIL);
  assert.equal(open.has(a), true, "the access reader still opens the legible Course A");

  // Control: both records legible, the exact reader answers both.
  await redis.pipeline([["HSET", importedKey(store.statsId!, EMAIL), b, JSON.stringify({ at, job: JOB })]]);
  const both = await paidCoursesExact(store, EMAIL);
  assert.deepEqual([both.has(a), both.has(b)], [true, true]);
});
