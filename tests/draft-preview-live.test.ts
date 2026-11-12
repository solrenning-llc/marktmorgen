/**
 * Claude 1's LOW on #3440 at f56131a35a: after a reload the studio did not say that a preview link was still open,
 * and had no "Stop this link". The route now answers `{ action: "status" }` with whether the draft's link is live
 * and until when (never its code, which is not kept), from the pointer and its record; a reply that cannot be read
 * is server_error, never "no link". The editor asks on load and offers "Stop this link" while one is open.
 */
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductHidden, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { makeDraftPreview, revokeDraftPreview } from "@/lib/draft-preview";
import { POST as previewRoute } from "@/app/api/store/draft-preview/route";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function main(): Promise<void> {
  redis.clear();
  const owner = "livepreview@example.com";
  await claimHandle(owner, "livepreview", "Live Preview", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_live", subscriptionId: "sub_live", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const session = await openSession(owner);
  const send = async (body: Record<string, unknown>) => {
    const response = await previewRoute(new NextRequest("https://marktmorgen.com/api/store/draft-preview", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const draft = await addProduct(owner, "The Draft Guide", "Not out yet", "19", null);
  if (!draft.ok) throw new Error("no product");
  await setProductHidden(owner, draft.product.id, true);
  const store = (await storeForEmail(owner))!;

  const none = await send({ action: "status", id: draft.product.id });
  is("no link yet: status answers none", [none.status, none.body.ok, none.body.live], [200, true, null]);
  const made = await makeDraftPreview(store, draft.product.id);
  const open = await send({ action: "status", id: draft.product.id });
  is("a link made: status says until when, never the code", [open.status, open.body.ok, (open.body.live as { expiresAt?: number } | null)?.expiresAt, JSON.stringify(open.body).includes(made.code)], [200, true, made.expiresAt, false]);
  await revokeDraftPreview(store, draft.product.id);
  const stopped = await send({ action: "status", id: draft.product.id });
  is("stopped: status answers none", stopped.body.live, null);

  await makeDraftPreview(store, draft.product.id);
  const real = redis.pipeline.bind(redis);
  // Only the read of this draft's link pointer answers in another shape; the session and the store still read.
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:dpv:p:") ? [{ not: "a reply" }] : real(commands)) as typeof redis.pipeline;
  let unread: { status: number; body: Record<string, unknown> };
  try {
    unread = await send({ action: "status", id: draft.product.id });
  } finally {
    redis.pipeline = real;
  }
  is("a reply that cannot be read is server_error, never 'no link'", [unread.status, unread.body.error], [503, "server_error"]);

  const component = readFileSync("components/draft-preview-link.tsx", "utf8");
  is("the editor asks for the status when it opens", /action: "status"/.test(component) && /useEffect/.test(component), true);
  is("it says a link is open, until when, and offers to stop it", /A preview link is open until/.test(component) && /Stop this link/.test(component), true);

  done();
}

void main();
