/**
 * Buyer area hunt (Claude 7, 14 November 2026; synthetic only): signing out of a store's community cleared the pass
 * cookie in the browser but left the pass itself live in Redis for 90 days, so the same token (a copied cookie,
 * another browser's jar, a shared computer's saved cookies) kept opening the courses and the community after
 * "Sign out". The pass is now let go on the server too (lib/learn.ts, dropPass).
 */
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { makeWorld, OWNER } from "./erasure-world";
import { learnerFrom, mintPass, passCookieName } from "@/lib/learn";
import { storeForEmail } from "@/lib/store";
import { POST } from "@/app/api/store/community/route";
import { createHash } from "node:crypto";

void redis;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

async function main() {
  await makeWorld();
  const store = (await storeForEmail(OWNER))!;
  part("a buyer's pass, then Sign out");
  const token = await mintPass(store, "buyer@example.com", "all");
  const jar = (t: string) => ({ get: (name: string) => (name === passCookieName(store) ? { value: t } : undefined) });
  is("before sign-out the pass lets the buyer in", (await learnerFrom(store, jar(token)))?.email, "buyer@example.com");

  const form = new FormData();
  form.set("handle", store.handle);
  form.set("action", "signout");
  const response = await POST(
    new NextRequest("https://marktmorgen.test/api/store/community", {
      method: "POST",
      body: form,
      headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", cookie: `${passCookieName(store)}=${token}` },
    }),
  );
  is("sign-out answers with a redirect", response.status, 303);
  is("sign-out clears the cookie in the browser", /Max-Age=0/.test(response.headers.get("set-cookie") ?? ""), true);
  const left = await redis.pipeline([["EXISTS", `nl:learn:pass:${sha(token)}`]]);
  is("after sign-out the pass record is gone from the server (expected 0)", left[0], 0);
  is("after sign-out the same token lets nobody in (expected null)", (await learnerFrom(store, jar(token)))?.email ?? null, null);
  done();
}
void main();
