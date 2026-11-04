import type { NextRequest } from "next/server";
import { StoreFullError } from "@/lib/store-full";
import { randomBytes } from "node:crypto";
import { ensureStatsId, setPostCount } from "@/lib/store";
import { itemFor, readListing } from "@/lib/catalog";
import { guardStoreWrite, text } from "@/lib/store-request";
import { MAX_POST_BODY, cleanPost, deletePost, savePost } from "@/lib/store-blog";
import { outlinePromptsLeft } from "@/lib/blog-outline";
import { productChoice } from "@/lib/letter-rules";

/**
 * Writes the store's blog (lib/store-blog.ts): `{ action: "save", id?, title,
 * body, product?, products?, draft }` or `{ action: "delete", id }`.
 * `products`: an array of the ids of this store's products whose holders
 * alone may read the post, [] for everyone; left out (or null), a post kept
 * for members stays so; anything else, or a product the store does not have,
 * is refused ("products"), never read as "everyone" (lib/letter-rules.ts,
 * productChoice). What the blog says
 * is part of what the store says, so it needs the "page" permission. The
 * number published is kept on the store's record each time, so the store
 * page links to the blog without asking.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "page", MAX_POST_BODY * 2 + 4_000);
  if (!guarded.ok) return guarded.response;
  const { body } = guarded;
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
  try {
    const store = guarded.store.statsId ? guarded.store : await ensureStatsId(guarded.ref);
    if (!store?.statsId) return fail("none");
    if (body.action === "delete") {
      const left = await deletePost(store.statsId, text(body.id, 20), store);
      if (left === null) return fail("unknown", 404);
      await setPostCount(guarded.ref, left);
      return Response.json({ ok: true });
    }
    const choice = productChoice(body.products, (pid) => itemFor(store, pid) !== null);
    if (!choice) return fail("products");
    const input = { ...cleanPost(body), ...(choice.keep ? {} : { products: choice.ids }) };
    // A post started from an outline (lib/blog-outline.ts) is never published with its prompts left in; a draft may keep them.
    if (!input.draft && outlinePromptsLeft(input.title, input.body).length) return fail("outline_left");
    // Only one of the store's own products, as it is now.
    if (input.product && !(await readListing(store, input.product))) input.product = null;
    const id = typeof body.id === "string" && body.id ? text(body.id, 20) : null;
    const saved = await savePost(store.statsId, id, input, () => randomBytes(5).toString("hex"), store);
    if (!saved.ok) return fail(saved.reason, saved.reason === "unknown" ? 404 : 400);
    await setPostCount(guarded.ref, saved.published);
    return Response.json({ ok: true, post: saved.post });
  } catch (error) {
    // What does not fit in the store's data room is not written (lib/store-data.ts).
    if (error instanceof StoreFullError) return fail("store_full", 409);
    console.error("saving a blog post failed", error);
    return fail("server_error", 500);
  }
}
