/**
 * The preservation hold on a product taken off by a child-safety report
 * (C1-20261109-1546-TODOS-70, unit 2; 18 U.S.C. § 2258A(h) as amended by the
 * REPORT Act: one year from the report).
 *
 * The automatic hold now also marks the product for 400 days, before it is
 * taken off, and while the mark is there the product route refuses to remove,
 * edit or publish it again, with words that do not reveal the report. A mark
 * that cannot be read refuses too (503), never lets the change through.
 * Synthetic store, in-memory Redis.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { KEEP_SECONDS, holdReported, isHeldForReport } from "@/lib/child-safety";
import { POST as productRoute } from "@/app/api/store/product/route";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function main(): Promise<void> {
  redis.clear();
  const owner = "keep@example.com";
  await claimHandle(owner, "keepshop", "Keep Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_keep", subscriptionId: "sub_keep", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const session = await openSession(owner);
  const send = async (body: Record<string, unknown>) => {
    const response = await productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: "https://marktmorgen.com", host: "marktmorgen.com" }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };
  const held = await addProduct(owner, "Held Product", "On sale", "19", null);
  const free = await addProduct(owner, "Free Product", "On sale", "19", null);
  if (!held.ok || !free.ok) throw new Error("no products");
  const store = (await storeForEmail(owner))!;

  part("The hold marks it for a year and more");
  is("400 days", KEEP_SECONDS, 400 * 86_400);
  is("held", await holdReported({ kind: "child_safety", url: `https://marktmorgen.com/@keepshop/p/${held.product.id}` }, store), "held");
  is("marked", [await isHeldForReport(store, held.product.id), await isHeldForReport(store, free.product.id)], [true, false]);
  const ttl = Number(redis.run(["TTL", redis.keys().find((key) => key.startsWith("nl:csa:keep:")) ?? ""]));
  is("and the mark ends by itself", ttl > 399 * 86_400 && ttl <= KEEP_SECONDS, true);

  part("While held, the creator cannot remove, edit or publish it");
  const removed = await send({ action: "remove", id: held.product.id });
  is("remove is refused", [removed.status, removed.body.error], [409, "held_for_report"]);
  const published = await send({ action: "visibility", id: held.product.id, hidden: false });
  is("publishing again is refused", [published.status, published.body.error], [409, "held_for_report"]);
  const edited = await send({ action: "edit", id: held.product.id, title: "Renamed", summary: "x", price: "19" });
  is("editing is refused", [edited.status, edited.body.error], [409, "held_for_report"]);
  const after = await readListing((await storeForEmail(owner))!, held.product.id);
  is("the product is still there, as it was, off the store", [after?.title, after?.hidden], ["Held Product", true]);
  const other = await send({ action: "remove", id: free.product.id });
  is("another product is not touched by it", other.status, 200);

  part("A mark that cannot be read refuses, never lets the change through");
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => (String(commands[0]?.[1] ?? "").startsWith("nl:csa:keep:") ? [42] : real(commands))) as typeof redis.pipeline;
  const unread = await send({ action: "remove", id: held.product.id });
  redis.pipeline = real;
  is("503", unread.status, 503);

  part("What the creator reads");
  const editor = readFileSync("components/product-editor.tsx", "utf8");
  is("the studio says it plainly, without naming the report", editor.includes("held_for_report:"), true);

  done();
}

main();
