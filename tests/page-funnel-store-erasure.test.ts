/**
 * Codex L's MEDIUM on main (relatorios-codex/L-20261120-2144-fix-main-page-funnel-record-after-erasure.md): a funnel
 * save through the real studio route, paused just before its final metadata EVAL, must not write the store's private
 * funnel back once the store's erasure began (its erasing mark) or ended (its keys gone). A store with an id and one
 * from before ids (legacy), whose owner may open a new store under the same address meanwhile, and a store with an id
 * whose account moved and began erasing under the new ref (store-claim-live:v1). The live control still
 * saves. And every production caller saves through the fenced writer, never the bare one.
 * Synthetic: the Redis stand-in only.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { readPageFunnels } from "@/lib/page-funnel-store";
import { ERASING_KEY, type Store, addProduct, claimHandle, ensureStatsId, ensureStoreId, erasingField, ownerKey, setProductLink, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { dataKey } from "@/lib/store-data";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST } from "@/app/api/store/page-funnels/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const EMAIL = "funnel-erasure@example.invalid";
const PRIVATE = "Synthetic Person private intake";

/** The id key of the store kept under the owner's address now, if it has one. */
async function ownerIdKey(): Promise<string | null> {
  const raw = redis.run(["GET", await ownerKey(EMAIL)]);
  const sid = typeof raw === "string" ? (JSON.parse(raw) as { sid?: string }).sid : "";
  return sid ? storeIdCommand(sid)[1] : null;
}

/** Makes the store kept under the owner's address one from before ids: no id in its record, no id key. */
async function makeLegacy(): Promise<void> {
  const idKey = await ownerIdKey();
  if (idKey) redis.run(["DEL", idKey]);
  const kept = JSON.parse(String(redis.run(["GET", await ownerKey(EMAIL)]))) as Store;
  redis.run(["SET", await ownerKey(EMAIL), JSON.stringify({ ...kept, sid: "" })]);
}

/** Posts `body` to the real route, running `step` once just before the first funnel-save EVAL. */
async function postWith(body: Record<string, unknown>, step: () => Promise<void>): Promise<{ status: number; json: Record<string, unknown>; reached: boolean }> {
  const session = await openSession(EMAIL);
  const original = redis.pipeline;
  let reached = false;
  redis.pipeline = async (commands) => {
    if (!reached && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:funnel-save"))) {
      reached = true;
      await step();
    }
    return original.call(redis, commands);
  };
  try {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/page-funnels", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
      body: JSON.stringify(body),
    }));
    return { status: response.status, json: (await response.json()) as Record<string, unknown>, reached };
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  for (const kind of ["primary", "legacy"] as const) for (const state of ["live", "gone", "erasing", "reopened", "moved"] as const) {
    if (kind === "primary" && state === "reopened") continue;
    // A store from before ids has no id key to repoint: the move is a store with an id's case.
    if (kind === "legacy" && state === "moved") continue;
    const label = `${kind}/${state}`;
    part(label);
    redis.clear();
    await claimHandle(EMAIL, "funnel-erasure", "Synthetic", "");
    await ensureStatsId(EMAIL);
    await ensureStoreId(EMAIL);
    const made = await addProduct(EMAIL, "Guide", "", "19", null);
    if (!made.ok) throw new Error("no product");
    const linked = await setProductLink(EMAIL, made.product.id, "https://example.com/guide");
    if (!linked.ok) throw new Error("no link");
    if (kind === "legacy") await makeLegacy();
    const real = (await storeForEmail(EMAIL))!;
    if (kind === "legacy") is(label + " starts from a store with no id", real.sid, "");
    const ref = storeRef(real);
    const key = `nl:pfunnels:${real.statsId}`;
    const room = dataKey(real)!;

    const sent = await postWith({ funnel: { name: PRIVATE, slug: "private-intake", steps: [{ kind: "product", id: made.product.id }] } }, async () => {
      if (state === "gone" || state === "reopened") {
        // The erasure's record step: the store's own keys go (its id key, if it has one, and its record), then the walk's.
        const idKey = await ownerIdKey();
        if (idKey) redis.run(["DEL", idKey]);
        redis.run(["DEL", await ownerKey(EMAIL)]);
        redis.run(["DEL", key]);
        redis.run(["DEL", room]);
      }
      if (state === "reopened") {
        // The owner opens a new store under the same address: the same owner key, another statsId.
        const kept = JSON.parse(JSON.stringify(real)) as Store;
        redis.run(["SET", await ownerKey(EMAIL), JSON.stringify({ ...kept, sid: "", statsId: "0123456789abcdef0123456789abcdef" })]);
      }
      if (state === "moved") {
        // The rule of store-claim-live:v1 (lib/live-fence.ts): moveAccount repoints the id key to the new ref, and an
        // erasure begun after the move marks the new ref's field. The id key still exists, so only its value tells the
        // save prepared under the old ref that this store is no longer the one it read.
        const idKey = await ownerIdKey();
        if (!idKey) throw new Error("no id key");
        const moved = "funnel-erasure-moved@example.invalid";
        redis.run(["SET", idKey, moved]);
        redis.run(["HSET", ERASING_KEY, await erasingField(moved), "1"]);
        redis.run(["DEL", key]);
        redis.run(["DEL", room]);
      }
      if (state === "erasing") {
        redis.run(["HSET", ERASING_KEY, await erasingField(ref), "1"]);
        redis.run(["DEL", key]);
        redis.run(["DEL", room]);
      }
    });
    is(label + " reached the actual funnel save", sent.reached, true);
    if (state === "live") {
      is(label + " a live store still saves", [sent.status, sent.json.ok], [200, true]);
      is(label + " and its funnel is kept", (await readPageFunnels(real.statsId)).map((f) => f.name), [PRIVATE]);
      continue;
    }
    is(label + " answers that the store is gone (410), not saved", [sent.status, sent.json.ok, sent.json.error], [410, false, "gone"]);
    is(label + " does not write the erased store's private funnel back", redis.run(["HGETALL", key]), []);
    is(label + " nor its data room", redis.run(["EXISTS", room]), 0);
  }

  part("Every production caller saves through the fenced writer");
  for (const file of ["app/api/store/page-funnels/route.ts", "lib/funnel-bundle-store.ts", "lib/store-copy.ts", "lib/clickfunnels-funnel.ts"]) {
    const source = readFileSync(file, "utf8");
    is(file + " never calls the bare writePageFunnel", /\bwritePageFunnel\(/.test(source), false);
    is(file + " saves through writeStorePageFunnel", /\bwriteStorePageFunnel\(/.test(source), true);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
