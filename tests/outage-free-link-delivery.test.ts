/**
 * Outage drill (Claude 7, 13 November 2026; synthetic only): a free copy's emailed link while the file store is down
 * (the Blob stand-in's get throws on every try). A delivery that never happened gives its use back, so the buyer is
 * never told "used as many times as it can be" after only failures, and the file goes out once the store is back.
 * The count can only stay high, never fall below what was handed over: a use is given back only after a 5xx of the
 * delivery itself, and only once.
 */
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { POST } from "@/app/api/store/free/download/route";
import { addProduct, claimHandle, ensureStatsId, setProductFile, storeFolder, setSubscription } from "@/lib/store";
import { MAX_CLAIM_USES } from "@/lib/free";
import { blobDown } from "./outage-free-link-blob-world";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const OWNER = "olive@example.com";

async function main() {
  redis.clear();
  await claimHandle(OWNER, "olive", "Olive", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_x", subscriptionId: "sub_x", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Free guide", "", "0", null);
  if (!made.ok) throw new Error("no product " + JSON.stringify(made));
  const folder = await storeFolder(OWNER);
  const r = await setProductFile(OWNER, made.product.id, { pathname: `stores/${folder}/${made.product.id}/guide-Ab12Cd34Ef.pdf`, name: "guide.pdf", bytes: 1000, contentType: "application/pdf", addedAt: new Date().toISOString() });
  is("file attached", r.ok, true);
  const token = randomBytes(32).toString("hex");
  const claimKey = `nl:free:claim:${sha(`nimbus-free-claim:${token}`).slice(0, 40)}`;
  await redis.pipeline([["SET", claimKey, JSON.stringify({ h: "olive", p: made.product.id, e: "ana@example.com", c: false, at: "" }), "EX", 86400]]);
  const usesKey = `nl:free:uses:${sha(`nimbus-free-uses:${token}`).slice(0, 40)}`;
  const press = () => POST(new NextRequest("https://marktmorgen.com/api/store/free/download", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() }));

  part("The file store down on every try");
  const statuses: number[] = [];
  for (let i = 0; i < MAX_CLAIM_USES + 2; i++) statuses.push((await press()).status);
  is("every failed delivery says so (502), never 'used as many times as it can be'", statuses.every((s) => s === 502), true);
  is("the store was asked each time", blobDown.reads, MAX_CLAIM_USES + 2);
  is("no use is left spent by a delivery that never happened", (await redis.pipeline([["GET", usesKey]]))[0], "0");

  part("The store is back");
  blobDown.now = false;
  const back = await press();
  is("the file goes out", [back.status, await back.text()], [200, "%PDF-1.7 synthetic"]);
  is("and that delivery is counted, once", (await redis.pipeline([["GET", usesKey]]))[0], "1");

  part("Uses that were handed over still run out");
  for (let i = 1; i < MAX_CLAIM_USES; i++) await press();
  const over = await press();
  is("the eleventh delivered use is refused as spent", [over.status, (await over.text()).includes("used as many times")], [429, true]);
  done();
}
main();
