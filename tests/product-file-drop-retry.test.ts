/**
 * A removed product's file whose delete fails (a timeout of the file store) is never lost: it goes to the daily job
 * that deletes uploads nobody keeps (sweepTaskUploads, app/api/cron/courses), as a deleted person's files do
 * (lib/person-erasure.ts) and as the product's stamped copies do on their own list (lib/pdf-stamp.ts). Before, the
 * failure was only logged: the file stayed in the store's folder for good, nothing pointed at it so the creator could
 * not delete it, and it went on counting against the store's storage (lib/storage-quota.ts measures the folder) and
 * costing until the store closed.
 */
import { NextRequest } from "next/server";
import { POST as productRoute } from "@/app/api/store/product/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { sweepTaskUploads } from "@/lib/assignment";
import { deleteFile } from "@/lib/file-store";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductFile, setStripeAccount, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { files, state } from "./product-file-drop-retry-world";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const OWNER = "product-file-drop-retry@example.com";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "productfiledropretry", "Product File Drop Retry", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_ProductFileDrop", true);
  await setSubscription(OWNER, { customerId: "cus_product_file_drop", subscriptionId: "sub_product_file_drop", active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const headers = { "content-type": "application/json", "x-nimbus-store": store.sid!, cookie: `${SESSION_COOKIE}=${session}` };

  const made = await addProduct(OWNER, "A guide", "", "40");
  if (!made.ok) throw new Error("product not made");
  const pathname = `stores/${await storeFolder(OWNER)}/guide.zip`;
  files.add(pathname);
  const set = await setProductFile(OWNER, made.product.id, { pathname, name: "guide.zip", bytes: 10, contentType: "application/zip", addedAt: new Date(0).toISOString() });
  is("the product carries its file", set.ok, true);

  part("Removing the product while the file store does not answer");
  state.failing = true;
  const response = await productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers, body: JSON.stringify({ action: "remove", id: made.product.id }) }));
  state.failing = false;
  is("the product is removed", response.status, 200);
  is("its file is still in the store's folder", files.has(pathname), true);

  part("The daily job finishes it");
  const deleted = await sweepTaskUploads(deleteFile, Date.now() + 2 * 86_400_000);
  is("the file is deleted by the daily job", [deleted.includes(pathname), files.has(pathname)], [true, false]);
  done();
}

void main();
