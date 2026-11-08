/**
 * A door hands an issued upload back (lib/upload-hand-back.ts) only to a browser holding a session id's shape, the
 * same cheapest refusal the signed path gives one without it (lib/auth.ts emailForSession: no database read). The
 * studio unit prices one hand-back per counted upload (tests/plan-cost-registry.ts UPLOAD_HAND_BACK_EXTRA); a caller
 * with no session at all has no counted upload, so it is refused, not echoed. Real POST handlers, synthetic requests.
 */
import { NextRequest } from "next/server";
import { POST as imagePost } from "@/app/api/store/image/upload/route";
import { POST as filePost } from "@/app/api/store/file/route";
import { SESSION_COOKIE } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const issued = { delegationToken: "synthetic-delegation", signature: "synthetic-signature", params: { pathname: "x" } };
const handBack = JSON.stringify({ type: "blob.generate-presigned-url", payload: { pathname: "stores/f/images/a.webp", clientPayload: JSON.stringify({ handBack: issued }), multipart: false } });
const firstAsk = JSON.stringify({ type: "blob.generate-presigned-url", payload: { pathname: "stores/f/images/a.webp", clientPayload: JSON.stringify({ productId: "p1" }), multipart: false } });
const SHAPED = "a".repeat(64);

function ask(path: string, raw: string, extra: Record<string, string> = {}) {
  return new NextRequest(`https://marktmorgen.test${path}`, {
    method: "POST",
    headers: { host: "marktmorgen.test", "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)), ...extra },
    body: raw,
  });
}

let commands = 0;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = ((list: (string | number)[][]) => {
  commands += list.length;
  return pipeline(list);
}) as typeof redis.pipeline;

async function main() {
  const oldEnv = process.env.VERCEL_ENV;
  const oldKey = process.env.BLOB_WEBHOOK_PUBLIC_KEY;
  process.env.VERCEL_ENV = "production";
  // Presence only, so the library reaches the route's own signed path; nothing is verified or signed with it.
  process.env.BLOB_WEBHOOK_PUBLIC_KEY = "synthetic-public-key-presence-only";
  try {
    for (const [path, post] of [["/api/store/image/upload", imagePost], ["/api/store/file", filePost]] as const) {
      part(`${path}: a hand-back without a session is refused like the signed path refuses it`);
      redis.clear();
      commands = 0;
      is("control: another site is still refused", (await post(ask(path, handBack, { origin: "https://other.test" }))).status, 403);
      is("control: a first ask without a session is refused", (await post(ask(path, firstAsk))).status, 401);
      for (const [label, cookie] of [["no cookie", ""], ["an empty session cookie", `${SESSION_COOKIE}=`], ["a session cookie not of a session id's shape", `${SESSION_COOKIE}=not-a-session`], ["another cookie only", "other=1"]] as const) {
        const answer = await post(ask(path, handBack, cookie ? { cookie } : {}));
        const text = await answer.text();
        is(`${label}: refused as signed out, nothing echoed`, [answer.status, text.includes("synthetic-signature")], [401, false]);
      }
      is("refusals read nothing from the database", commands, 0);

      const shaped = await post(ask(path, handBack, { cookie: `${SESSION_COOKIE}=${SHAPED}` }));
      is("a browser holding a session id's shape is handed back what was issued, unchanged", [shaped.status, await shaped.json()], [200, { type: "blob.generate-presigned-url", presignedUrlPayload: issued }]);
      is("and the hand-back still reads nothing from the database (as priced)", commands, 0);
      is("no key was written", redis.keys(), []);
    }
  } finally {
    if (oldEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = oldEnv;
    if (oldKey === undefined) delete process.env.BLOB_WEBHOOK_PUBLIC_KEY;
    else process.env.BLOB_WEBHOOK_PUBLIC_KEY = oldKey;
    redis.clear();
  }
}

void main().then(done);
