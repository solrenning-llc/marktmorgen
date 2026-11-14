/**
 * Signing out of a store's community ends the buyer's pass at the server, not only in this browser (the security
 * audit of 14 November 2026, LOW). The pass (lib/learn.ts, mintPass) is kept 90 days under its token and opens the
 * store's courses and community; the sign-out only cleared the cookie, so a copy of it taken before kept working.
 * Now the sign-out deletes the pass and its entry among the address's passes (endPass), and only this store's: a
 * token another store minted is left alone.
 */
import { NextRequest } from "next/server";
import { POST as communityRoute } from "@/app/api/store/community/route";
import { emailKey, mintPass, passCookieName, passKeyOfHash, storeKey } from "@/lib/learn";
import { claimHandle, ensureStatsId, ensureStoreId, setCommunity, storeForEmail } from "@/lib/store";
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const signOut = async (handle: string, cookie: string) => {
  const form = new FormData();
  form.set("handle", handle);
  form.set("action", "signout");
  return communityRoute(new NextRequest("https://marktmorgen.com/api/store/community", { method: "POST", headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie }, body: form }));
};
const kept = async (token: string) => (await redis.pipeline([["EXISTS", passKeyOfHash(sha(token))]]))[0];

async function main(): Promise<void> {
  redis.clear();
  for (const [owner, handle, name] of [["owner@example.com", "signoutclub", "Sign Out Club"], ["other@example.com", "otherclub", "Other Club"]] as const) {
    const made = await claimHandle(owner, handle, name, "");
    if (!made.ok) throw new Error(`no store ${handle}`);
    await ensureStatsId(owner);
    await ensureStoreId(owner);
    await setCommunity(owner, true);
  }
  const store = (await storeForEmail("owner@example.com"))!;
  const other = (await storeForEmail("other@example.com"))!;

  part("Signing out ends the pass at the server");
  const token = await mintPass(store, "ana@example.com", "all");
  is("(the pass is kept before)", await kept(token), 1);
  const response = await signOut(store.handle, `${passCookieName(store)}=${token}`);
  is("back to the store", [response.status, response.headers.get("location")], [303, `https://marktmorgen.com/@${store.handle}`]);
  is("this browser's cookie is cleared", /Max-Age=0/.test(response.headers.get("set-cookie") ?? ""), true);
  is("and the pass itself is gone, so a copy of the cookie opens nothing", await kept(token), 0);
  const listed = (await redis.pipeline([["SMEMBERS", `nl:learn:passes:${storeKey(store)}:${emailKey("ana@example.com")}`]]))[0];
  is("nor is it listed among the address's passes", Array.isArray(listed) && listed.includes(sha(token)), false);

  part("Only this store's pass");
  const theirs = await mintPass(other, "ana@example.com", "all");
  await signOut(store.handle, `${passCookieName(store)}=${theirs}`);
  is("another store's token, put in this store's cookie, is left alone", await kept(theirs), 1);

  part("Nothing to end");
  const none = await signOut(store.handle, "");
  is("with no cookie it signs out as before", none.status, 303);

  done();
}

void main();
