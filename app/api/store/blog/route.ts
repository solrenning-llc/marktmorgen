import type { NextRequest } from "next/server";
import { StoreFullError } from "@/lib/store-full";
import { randomBytes } from "node:crypto";
import { ensureStatsId, setPostCount } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { guardStoreWrite, text } from "@/lib/store-request";
import { BlogCountUnavailable, BlogWriteUnconfirmed, MAX_POST_BODY, cleanPost, deletePost, savePost } from "@/lib/store-blog";
import { outlinePromptsLeft } from "@/lib/blog-outline";

/**
 * Writes the store's blog (lib/store-blog.ts): `{ action: "save", id?, title,
 * body, product?, draft }` or `{ action: "delete", id }`. What the blog says
 * is part of what the store says, so it needs the "page" permission. The
 * number published is kept on the store's record each time, so the store
 * page links to the blog without asking.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "page", MAX_POST_BODY * 2 + 4_000);
  if (!guarded.ok) return guarded.response;
  const { body } = guarded;
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status, ...(status === 503 ? { headers: { "Cache-Control": "no-store" } } : {}) });
  try {
    const store = guarded.store.statsId ? guarded.store : await ensureStatsId(guarded.ref);
    if (!store?.statsId) return fail("none");
    if (body.action === "delete") {
      const left = await deletePost(store.statsId, text(body.id, 20), store);
      if (left === null) return fail("unknown", 404);
      const counted = await setPostCount(guarded.ref, left).catch(() => null);
      return Response.json({ ok: true, countUnavailable: counted === null });
    }
    const input = cleanPost(body);
    // A post started from an outline (lib/blog-outline.ts) is never published with its prompts left in; a draft may keep them.
    if (!input.draft && outlinePromptsLeft(input.title, input.body).length) return fail("outline_left");
    // Only one of the store's own products, as it is now.
    if (input.product && !(await readListing(store, input.product))) input.product = null;
    const id = typeof body.id === "string" && body.id ? text(body.id, 20) : null;
    const saved = await savePost(store.statsId, id, input, () => randomBytes(5).toString("hex"), store);
    if (!saved.ok) return fail(saved.reason, saved.reason === "unknown" || saved.reason === "unconfirmed" ? 503 : 400);
    const counted = saved.published === null ? null : await setPostCount(guarded.ref, saved.published).catch(() => null);
    return Response.json({ ok: true, post: saved.post, countUnavailable: counted === null });
  } catch (error) {
    if (error instanceof BlogCountUnavailable) return Response.json({ ok: true, countUnavailable: true });
    if (error instanceof BlogWriteUnconfirmed) return fail("unconfirmed", 503);
    // What does not fit in the store's data room is not written (lib/store-data.ts).
    if (error instanceof StoreFullError) return fail("store_full", 409);
    console.error("saving a blog post failed", error);
    return fail("server_error", 500);
  }
}
