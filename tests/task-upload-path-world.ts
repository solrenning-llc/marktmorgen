/**
 * The edges of the assignment upload door (app/api/store/course/task/upload) for tests/task-upload-path.test.ts: one
 * student on one lesson whose assignment takes a file, and no limit on the way. The file store is
 * tests/failure-cleanup-world.ts and the database is the in-memory Redis (tests/redis-stub.ts), so lib/assignment.ts
 * runs as it is. The door's SDK (@vercel/blob/client) is the real one: only the token it is handed is made here, in
 * the shape Vercel issues one (a delegation scope, then a key the scope is signed with), and the network under the
 * SDK (undici) is the test's own fetch, so the browser's PUT is read instead of sent.
 */
import { del as deleteStored } from "./failure-cleanup-world";

export { deleted, files, get, head, list, put } from "./failure-cleanup-world";

/** Whether the file store refuses to delete, to follow what a hand-in does with a file it cannot let go of. */
let failDeletes = false;
export function setFailDeletes(fail: boolean): void {
  failDeletes = fail;
}
export async function del(pathnames: string | string[]): Promise<void> {
  if (failDeletes) throw new Error("the file store did not delete");
  await deleteStored(pathnames);
}

/** The key a delegation's presigned requests are signed with (IssuedSignedToken.clientSigningToken). */
export const SIGNING_KEY = "client-signing-key-for-tests";
/** What the door asked the token for, each time. */
export const issued: { pathname?: string; operations?: string[]; allowOverwrite?: boolean }[] = [];

// ---------------------------------------------------------------- @/lib/blob

export async function issueSignedToken(options: { pathname?: string; operations?: string[]; validUntil?: number; maximumSizeInBytes?: number; allowedContentTypes?: string[] }) {
  issued.push(options);
  const scope = { storeId: "store_test", pathname: options.pathname, operations: options.operations, validUntil: options.validUntil, maximumSizeInBytes: options.maximumSizeInBytes, allowedContentTypes: options.allowedContentTypes };
  return { clientSigningToken: SIGNING_KEY, delegationToken: `${Buffer.from(JSON.stringify(scope)).toString("base64url")}.signature`, validUntil: options.validUntil ?? 0 };
}

export const presignUrl = () => {
  throw new Error("not used by the assignment door");
};

// ---------------------------------------------------------------- undici (under the real SDK)

/** Looked up at each call, so the test can put its own fetch in place after the SDK is loaded. */
export const fetch = (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args);

// ---------------------------------------------------------------- @/lib/assignment-access

export const STORE = { handle: "shop", name: "Shop", email: "creator@example.com", sid: "s-1", tier: "creator", subscriptionActive: true, trialEnds: 0, language: "en" };
/** A course's, a lesson's and two students' ids in the shapes lib/course.ts and lib/learn.ts make them. */
export const COURSE = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";
export const LESSON = "lesson000001";
export const STUDENT_A = "a".repeat(32);
export const STUDENT_B = "b".repeat(32);
let student = STUDENT_A;
/** Signs in as this student. */
export function asStudent(who: string): void {
  student = who;
}

export async function studentOnTask() {
  return {
    ok: true as const,
    store: STORE,
    product: { id: "product-1" },
    course: { id: COURSE },
    lesson: { id: LESSON, title: "Your plan" },
    unit: { id: "unit-1" },
    task: { prompt: "Send your plan.", review: false, gate: false, file: true },
    who: student,
    email: `${student}@example.com`,
  };
}

// ---------------------------------------------------------------- @/lib/buyer-actions

export async function takeBuyerAction() {
  return true;
}

export async function takeBuyerRead() {
  return true;
}
