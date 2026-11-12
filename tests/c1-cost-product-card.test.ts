/**
 * The picture a product's shared link unfolds into (app/[handle]/p/[product]/opengraph-image.tsx) reads the
 * product's own picture from the file store (up to MAX_IMAGE_BYTES, a paid read and its transfer), may turn it into
 * a JPEG with sharp, and draws a 1200 x 630 PNG: heavier than a certificate's card, which is paid for with
 * CERTIFICATE_CARD_UNITS of the store's public requests before anything is read or drawn
 * (tests/certificate-card-standing.test.ts). The product's own page takes one (isResting); the card took none, so
 * an address asked again and again (a query string makes each one new to every cache) read the file store and drew
 * the card every time, counted against no store and refused for none, even a store whose requests were all spent.
 *
 * What is checked, with a synthetic store, an in-memory file store (tests/c1-cost-product-card-world.ts) and next/og
 * kept as the element it was asked to draw:
 *   - a card drawn for a live product takes the store's public requests, at least CERTIFICATE_CARD_UNITS;
 *   - a store past its public requests gets no card: 503, its picture not read, nothing drawn;
 *   - a product that is not there still takes them (a made-up id is not free), and reads no picture.
 */
import OpengraphImage from "@/app/[handle]/p/[product]/opengraph-image";
import { CERTIFICATE_CARD_UNITS } from "@/lib/certificate";
import { requestsIn } from "@/lib/traffic";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { allowanceWindow } from "@/lib/allowance-window";
import { addProduct, claimHandle, ensureStatsId, imageFolder, setProductImage, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { drawn } from "./certificate-card-world";
import { files, reads } from "./c1-cost-product-card-world";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "card-cost-owner@example.com";
const HANDLE = "cardcost";

async function cardFor(product: string): Promise<number | "image"> {
  const result: unknown = await OpengraphImage({ params: Promise.resolve({ handle: `@${HANDLE}`, product }) });
  return result instanceof Response ? result.status : "image";
}

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  answering(null);
  await claimHandle(OWNER, HANDLE, "Card Cost", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_cardcost01", subscriptionId: "sub_cardcost01", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Synthetic guide", "A synthetic product for the card cost test", "29", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const path = `images/${await imageFolder(OWNER)}/${"a".repeat(32)}.jpg`;
  // A JPEG by its first bytes, so the card takes it as it is (no sharp): a synthetic picture of 200 KB.
  const bytes = new Uint8Array(200_000);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  files.set(path, { bytes, contentType: "image/jpeg" });
  const pictured = await setProductImage(OWNER, id, { path, width: 800, height: 800, alt: "", bytes: bytes.length, small: null } as never);
  if (!pictured.ok) throw new Error("no picture");
  const store = (await storeForEmail(OWNER)) as Store;
  const folder = await storeFolder(OWNER);
  const window = allowanceWindow(store)!.id;
  const counter = `nl:traffic:r:${folder}:${window}`;

  part("A live product's card");
  let before = await requestsIn(folder, window);
  reads.length = 0;
  is("is drawn, with its picture read once", [await cardFor(id), reads.filter((p) => p === path).length], ["image", 1]);
  const taken = (await requestsIn(folder, window)) - before;
  is("and takes at least as many of the store's public requests as a certificate's lighter card", taken >= CERTIFICATE_CARD_UNITS, true);

  part("A made-up product id is not free");
  before = await requestsIn(folder, window);
  reads.length = 0;
  await cardFor("nosuchproduct");
  is("it takes the store's public requests too, as many as a live one", (await requestsIn(folder, window)) - before, taken);
  is("and reads no picture", reads.length, 0);

  part("A store past its public requests");
  const publicLimit = publicVisitLimit(requestLimitFor(store, Date.now() / 1000));
  await redis.pipeline([["SET", counter, String(publicLimit)]]);
  reads.length = 0;
  let drawnBefore = drawn.length;
  is("gets no card: 503, its picture not read, nothing drawn", [await cardFor(id), reads.length, drawn.length - drawnBefore], [503, 0, 0]);
  // 1,000 more asks of the same card with a fresh query string each: none reads the file store.
  for (let i = 0; i < 1_000; i += 1) await cardFor(id);
  is("a thousand more asks read the picture 0 times (before: 1,000 reads of 200 KB, 200 MB, counted nowhere)", reads.length, 0);
  await redis.pipeline([["SET", counter, String(publicLimit - 1)]]);
  drawnBefore = drawn.length;
  is("with fewer requests left than the card takes: nothing drawn", [await cardFor(id), drawn.length - drawnBefore], [503, 0]);
  await redis.pipeline([["DEL", counter]]);
  is("requests back, the card is drawn again", await cardFor(id), "image");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
