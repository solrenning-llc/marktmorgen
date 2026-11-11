import type { NextRequest } from "next/server";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { originFrom } from "@/lib/request-origin";
import { nextOpen, withMark } from "@/lib/page-funnel";
import { readPageFunnelsStrict, stepStates } from "@/lib/page-funnel-store";

/**
 * A funnel of pages' own address, /@chef/go/launch (and chef.com/go/launch on
 * the store's own domain): sends the visitor to its first step that can be
 * shown, with the funnel's mark (lib/page-funnel.ts). Whatever the link
 * carried — utm tags, an affiliate's code — goes along, so the step is
 * credited exactly as a link straight to it would be.
 *
 * An inactive funnel is unavailable, without redirecting to any public step.
 * An address no funnel has leads to the store, and only on a whole reading:
 * a reading out of shape is unknown, never "no funnel has it", so the route
 * says try again later and sends nobody anywhere (CX-123 rule 24). The same
 * holds for the funnel's product steps.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ handle: string; funnel: string }> }) {
  const { handle: raw, funnel: slug } = await params;
  const origin = originFrom(request);
  const away = (path: string) =>
    new Response(null, { status: 307, headers: { Location: `${origin}${path}`, "Cache-Control": "no-store" } });

  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return new Response("Not found", { status: 404 });
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) return new Response("Not found", { status: 404 });
  if (store.suspended) return away(`/@${store.handle}`);

  // A store without a stats id has never kept a funnel; any other reading is exact or unknown.
  const later = () =>
    new Response("Try again later", { status: 503, headers: { "Retry-After": "60", "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
  const funnels = store.statsId ? await readPageFunnelsStrict(store.statsId).catch(() => null) : [];
  if (funnels === null) return later();
  const funnel = funnels.find((f) => f.slug === slug.toLowerCase()) ?? null;
  if (!funnel) return away(`/@${store.handle}`);
  if (!funnel.on) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  // A product the store still lists whose listing cannot be read is unknown, never "a deleted product".
  const states = await stepStates(store, funnel, { strictProducts: true }).catch(() => null);
  if (states === null) return later();
  const first = nextOpen(funnel, -1, (step) => states.find((s) => s.step === step)?.open ?? false);
  const path = first >= 0 ? states[first].path : null;
  if (!path) return away(`/@${store.handle}`);

  // What the link carried, kept; a mark of another funnel, dropped.
  const carried = new URLSearchParams(request.nextUrl.searchParams);
  carried.delete("f");
  const query = carried.toString();
  const target = withMark(path, funnel.id);
  return away(query ? `${target}${target.includes("?") ? "&" : "?"}${query}` : target);
}
