/**
 * Outage drill (Claude 7, 14 November 2026; synthetic only): replacing a product's file
 * (app/api/store/file/attach) while the file store's delete does not answer. The old file is on no record any more,
 * so nothing else could ever delete it (the creator no longer sees it) and it would count against the store's
 * storage until the store closes. It goes to the daily job that deletes uploads nobody keeps (lib/file-drop.ts),
 * and a replacement whose delete works deletes the old file at once. The other routes that let files go after a
 * save use the same helper (checked by their source below).
 */
import { NextRequest } from "next/server";
import { POST as attachRoute } from "@/app/api/store/file/attach/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { sweepTaskUploads } from "@/lib/assignment";
import { deleteFile } from "@/lib/file-store";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, productFile, setProductFile, setStripeAccount, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { files, state } from "./file-drop-sweep-world";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const OWNER = "file-drop-sweep@example.com";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "filedropsweep", "File Drop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_FileDropSweep", true);
  await setSubscription(OWNER, { customerId: "cus_file_drop", subscriptionId: "sub_file_drop", active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const headers = { "content-type": "application/json", "x-nimbus-store": store.sid!, cookie: `${SESSION_COOKIE}=${session}` };

  const made = await addProduct(OWNER, "A guide", "", "40");
  if (!made.ok) throw new Error("product not made");
  const folder = await storeFolder(OWNER);
  const id = made.product.id;
  const oldPath = `stores/${folder}/${id}/old-aaaaaaaaaaaaaaaaaaaa.zip`;
  const newPath = `stores/${folder}/${id}/new-bbbbbbbbbbbbbbbbbbbb.zip`;
  files.add(oldPath);
  files.add(newPath);
  const set = await setProductFile(OWNER, id, { pathname: oldPath, name: "old.zip", bytes: 10, contentType: "application/zip", addedAt: new Date(0).toISOString() });
  is("the product carries its first file", set.ok, true);

  part("Replacing the file while the file store's delete does not answer");
  state.failing = true;
  const response = await attachRoute(new NextRequest("https://marktmorgen.com/api/store/file/attach", { method: "POST", headers, body: JSON.stringify({ id, pathname: newPath, name: "new.zip" }) }));
  state.failing = false;
  const body = await response.json();
  is("the replacement is accepted", [response.status, body.ok], [200, true]);
  is("the product now points at the new file", (await productFile(OWNER, id))?.file.pathname, newPath);
  is("the old file is still in the store's folder", files.has(oldPath), true);

  part("Anything retries the old file's delete");
  const deleted = await sweepTaskUploads(deleteFile, Date.now() + 2 * 86_400_000);
  is("the daily job deletes the old file", [deleted.includes(oldPath), files.has(oldPath)], [true, false]);
  is("and keeps the new one", files.has(newPath), true);

  part("A replacement whose delete works");
  const thirdPath = `stores/${folder}/${id}/third-cccccccccccccccccccc.zip`;
  files.add(thirdPath);
  const again = await attachRoute(new NextRequest("https://marktmorgen.com/api/store/file/attach", { method: "POST", headers, body: JSON.stringify({ id, pathname: thirdPath, name: "third.zip" }) }));
  is("is accepted", again.status, 200);
  is("deletes the old file at once", [files.has(newPath), files.has(thirdPath)], [false, true]);
  is("and hands nothing to the daily job", await sweepTaskUploads(deleteFile, Date.now() + 2 * 86_400_000), []);

  part("Every route that lets a file go after a save hands a failed delete to the daily job");
  const { readFileSync } = await import("node:fs");
  for (const route of ["file/attach", "option", "course", "podcast", "image", "links", "link-image", "page", "site-page"]) {
    const source = readFileSync(`app/api/store/${route}/route.ts`, "utf8");
    is(`app/api/store/${route}: no delete whose failure is only logged`, /\bdel\([^)]*\)\.catch\(/.test(source), false);
    is(`app/api/store/${route}: uses deleteOrSweep`, source.includes("deleteOrSweep("), true);
  }
  done();
}

void main();
