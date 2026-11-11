/**
 * A product held for a child-safety report and a draft's private preview link
 * (Revisor 2, 11/11/2026 12h56, HIGH; lib/child-safety.ts, lib/draft-preview.ts).
 *
 * A held product is taken off the store, so it is a draft, and a draft can be
 * given a preview link that anyone with it opens. So: the studio route makes
 * no link for a held product; placing the hold revokes the link it had,
 * tried again by the hourly job until that is confirmed; and a link never
 * opens a held product, whatever made it, a mark that cannot be read included.
 * Neutral, synthetic products; nothing here names or describes reported material.
 */
import { NextRequest } from "next/server";
import * as childSafety from "@/lib/child-safety";
import { holdReported } from "@/lib/child-safety";
import { makeDraftPreview, readDraftPreview } from "@/lib/draft-preview";
import { POST as previewRoute } from "@/app/api/store/draft-preview/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductHidden, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "preview-held@example.com";
const HANDLE = "previewheld";
const BASE = "https://marktmorgen.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Preview Held", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_pvheld01", subscriptionId: "sub_pvheld01", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const session = await openSession(OWNER);
  const now = async () => (await storeForEmail(OWNER)) as Store;
  const make = async (id: string) => {
    const response = await previewRoute(new NextRequest(`${BASE}/api/store/draft-preview`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "make", id }) }));
    return [response.status, ((await response.json()) as { error?: string }).error ?? "made"];
  };
  const opens = async (code: string) => (await readDraftPreview(code).then((found) => (found ? "opens" : "closed"), () => "unknown")) as string;
  const real = redis.pipeline.bind(redis);
  const run = (at: number) => (childSafety as unknown as { hideHeldProducts?: (now: number) => Promise<unknown> }).hideHeldProducts?.(at);
  const queued = async () => ((await real([["ZRANGEBYSCORE", "nl:csa:hide", "-inf", "+inf"]]))[0] as string[]).length;

  const made = await addProduct(OWNER, "A draft", "", "19", null);
  const free = await addProduct(OWNER, "Another draft", "", "19", null);
  const late = await addProduct(OWNER, "A third draft", "", "19", null);
  if (!made.ok || !free.ok || !late.ok) throw new Error("no products");
  for (const id of [made.product.id, free.product.id, late.product.id]) await setProductHidden(OWNER, id, true);
  const before = await makeDraftPreview(await now(), made.product.id);
  is("before any hold, the draft's link opens", await opens(before.code), "opens");

  part("Placing a hold revokes the draft's link");
  is("held", await holdReported({ kind: "child_safety", url: `${BASE}/@${HANDLE}/p/${made.product.id}` }, await now()), "held");
  is("the link it had no longer opens", await opens(before.code), "closed");
  is("and nothing waits", await queued(), 0);

  part("The studio route makes no link for a held product");
  is("refused as on hold", await make(made.product.id), [409, "on_hold"]);
  is("a draft that is not held still gets one", (await make(free.product.id))[0], 200);

  part("A link never opens a held product, whatever made it");
  const bypass = await makeDraftPreview(await now(), made.product.id);
  is("a link made around the route does not open", await opens(bypass.code), "closed");
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.some((command) => command.slice(1).some((arg) => String(arg).startsWith("nl:csa:keep:"))) ? commands.map(() => 42) : real(commands)) as typeof redis.pipeline;
  is("a mark that cannot be read does not open it either", await opens(bypass.code), "unknown");
  redis.pipeline = real as typeof redis.pipeline;

  part("A revocation that does not go through is tried again by the hourly job");
  const lateLink = await makeDraftPreview(await now(), late.product.id);
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.some((command) => String(command[1] ?? "").startsWith("nl:dpv:p:")) ? commands.map(() => 42) : real(commands)) as typeof redis.pipeline;
  is("held, though its link could not be revoked", await holdReported({ kind: "child_safety", url: `${BASE}/@${HANDLE}/p/${late.product.id}` }, await now()), "held");
  redis.pipeline = real as typeof redis.pipeline;
  is("it waits", await queued(), 1);
  is("and its link opens nobody meanwhile", await opens(lateLink.code), "closed");
  await run(Date.now() + 2 * 3_600_000);
  is("the next run revokes it and lets it go", [await queued(), (await real([["GET", `nl:dpv:p:${(await now()).statsId}:${late.product.id}`]]))[0]], [0, null]);
  const freeLink = await makeDraftPreview(await now(), free.product.id);
  is("a draft that is not held still opens by its link", await opens(freeLink.code), "opens");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
