/**
 * Existing product POST regression, entirely synthetic. Pause only its final
 * description write after setProductAbout has completed, erase the real parent,
 * then let that SAME write resume. This file uses no new proposal exports.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, closeStoreRecord, ensureStatsId, ERASING_KEY, erasingField, storeForEmail, storeRef } from "@/lib/store";
import { dataKey } from "@/lib/store-data";
import { POST } from "@/app/api/store/product/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "about-erasure@example.com";
const privateText = "Alice Example, alice@example.com. Private intake notes.";
async function fixture() {
  redis.clear();
  await claimHandle(OWNER, "abouterasure", "About erasure", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Guide", "A useful guide.", "19", null);
  const parent = await storeForEmail(OWNER);
  if (!made.ok || !parent?.statsId) throw new Error("setup");
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const key = `nl:product:about:${parent.statsId}:${made.product.id}`;
  const request = () => new NextRequest("https://marktmorgen.com/api/store/product", {
    method: "POST",
    headers: { "content-type": "application/json", "x-nimbus-store": parent.sid, cookie },
    body: JSON.stringify({ action: "edit", id: made.product.id, title: "Guide", summary: "A useful guide.", price: "19", about: privateText }),
  });
  return { parent, key, request };
}
async function main(): Promise<void> {
  for (const state of ["closed", "erasing"] as const) {
    part(state);
    const f = await fixture();
    const original = redis.pipeline;
    let intercepted = 0;
    redis.pipeline = async (commands) => {
      const first = commands[0];
      // The description's own write: a plain SET of its key, or any script that names its key among its KEYS.
      const description = first && ((first[0] === "SET" && first[1] === f.key) ||
        (first[0] === "EVAL" && first.slice(3, 3 + Number(first[2])).includes(f.key)));
      if (intercepted || !description) return original.call(redis, commands);
      intercepted++;
      // This writer runs AFTER the product setter returned and released its
      // lock. Unlike the page callback, no expired-lock shortcut is needed.
      if (state === "closed") {
        const quota = dataKey(f.parent);
        is("real parent close completed", await closeStoreRecord(f.parent, [f.key, ...(quota ? [quota] : [])]), true);
      } else {
        await original.call(redis, [["DEL", f.key], ["HSET", ERASING_KEY, await erasingField(storeRef(f.parent)), "synthetic-walk"]]);
      }
      return original.call(redis, commands);
    };
    try { await POST(f.request()); } finally { redis.pipeline = original; }
    is("real route reached its description mutation", intercepted, 1);
    is("private description was not recreated", await redis.pipeline([["GET", f.key]]), [null]);
    // On main the prepared SET stores privateText here. HTTP failure alone
    // would not prove erasure; the absent persisted body is the RED assertion.
  }
  part("live route control");
  const f = await fixture();
  is("healthy product save", (await POST(f.request())).status, 200);
  is("same private body while parent is live", await redis.pipeline([["GET", f.key]]), [privateText]);
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
