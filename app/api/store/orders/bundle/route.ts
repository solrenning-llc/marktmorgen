import type { NextRequest } from "next/server";
import { withinStore } from "@/lib/metered-limits";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { BUMP_KEYS, type BumpKey } from "@/lib/bundle-rules";
import { ORDERS_BUNDLE_PER_HOUR, OrdersBusy, bundleFor } from "@/lib/buyer-orders";
import { ordersWords } from "@/lib/buyer-words/orders";
import type { OrdersBundleAnswer, OrdersBundleLine } from "@/components/orders-bundle";

/** The longest one answer may run: its lookup waits DOWNLOAD_LOOKUP_MS at the most (lib/buyer-orders.ts, bundleFor). */
export const maxDuration = 30;

function answer(status: number, body: OrdersBundleAnswer): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

/**
 * The products of one bundle on a buyer's list of purchases, asked for with
 * the button under it (components/orders-bundle.tsx): the list does not draw
 * them, so an opening stays small whatever its bundles hold (C3-80).
 *
 * Read as a download is: the link's own limit and the request's call first,
 * then lib/buyer-orders.ts (bundleFor) takes ORDERS_BUNDLE_UNITS of the
 * store's buyer requests before the grant is read and every listing and key
 * through its meter before it is read, and reads only that purchase, from the
 * creator's own Stripe account, so a refund made a minute ago is honored.
 * A store with no room answers "too often" and reads nothing.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const handle = normaliseHandle(params.get("handle") ?? "");
  if (!handle) return answer(400, { ok: false, message: "Which store?" });
  const store = await storeForHandle(handle);
  if (!store) return answer(404, { ok: false, message: "We could not find this store." });
  const words = ordersWords(store.language);
  const say = words.downloadProblems;
  const asked = params.get("item") ?? "";
  const which: "main" | BumpKey | null = asked === "main" ? "main" : (BUMP_KEYS as readonly string[]).includes(asked) ? (asked as BumpKey) : null;
  if (!which) return answer(404, { ok: false, message: say.nothingToDownload });
  const token = params.get("token") ?? "";
  if (!(await withinStore("orders-bundle", `${store.handle}:t:${token}`, ORDERS_BUNDLE_PER_HOUR, 3600, store, "buyer"))) {
    return answer(429, { ok: false, message: say.tooOften });
  }
  let shown;
  try {
    shown = await bundleFor(store, token, params.get("ref") ?? "", which);
  } catch (error) {
    if (error instanceof OrdersBusy) return answer(429, { ok: false, message: say.tooOften });
    console.error("showing a bundle's products failed", error);
    return answer(502, { ok: false, message: say.purchaseCheckFailed });
  }
  if (!shown) return answer(410, { ok: false, message: say.linkExpired });
  const { purchase, items, keys } = shown;
  const lines: OrdersBundleLine[] = items.lines.map((line) => {
    const key = keys.get(line.productId);
    const issued = key && key !== "error" && key.state === "issued" ? key : null;
    return {
      id: line.productId,
      title: line.title,
      link: line.delivery?.link ?? null,
      download: line.delivery?.file
        ? `/api/store/download?${new URLSearchParams({ handle: store.handle, ref: purchase.reference, token, pid: line.productId, ...(which !== "main" ? { item: which } : {}) })}`
        : null,
      course: line.courseProduct ? `/@${store.handle}/course/${line.courseProduct}` : null,
      key: key
        ? { label: words.yourKeyFor(line.title), value: issued ? issued.key : null, revoked: Boolean(issued?.revoked), waiting: key !== "error" && key.state === "waiting" }
        : null,
    };
  });
  return answer(200, { ok: true, lines, missing: items.missing > 0 ? words.bundleMissing(items.missing, store.name) : null });
}
