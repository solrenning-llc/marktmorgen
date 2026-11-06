/**
 * Encanto 5b, first part (C4-20261106-0700-C5-27): a product picture's average color, painted under it while it
 * loads, so a slow page shows the picture's color instead of a flat box. Made in the creator's browser from the
 * picture already being shrunk (components/shrink-image.ts), kept on the picture's own record, no file of its own.
 * The approved conditions it keeps:
 *
 *   - (1) the color is exactly #rrggbb, lowercase: anything else sent with a picture is refused without being
 *     written (app/api/store/image/route.ts), and anything else read back is dropped (parseProductImage);
 *   - (2, 3) no new file and no new upload: the color is a few bytes on the picture's record;
 *   - (4) pictures from before have none and are drawn as they were;
 *   - (5) only a background while the picture loads: a picture with any transparency gets no color (it would show
 *     through once loaded), and nothing is ever written over it.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TONE_PATTERN, parseProductImage, toneOf } from "@/lib/product-image";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { ProductCard } from "@/components/store-product";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const pixels = (...rgba: number[][]) => Uint8ClampedArray.from(rgba.flat());

async function main(): Promise<void> {
  part("The color: the average of an opaque picture, exactly #rrggbb");
  is("two pixels averaged", toneOf(pixels([200, 100, 0, 255], [100, 50, 20, 255])), "#964b0a");
  is("lowercase hex, two digits each", toneOf(pixels([0, 15, 255, 255])), "#000fff");
  is("any transparency: no color (it would show through once loaded)", toneOf(pixels([10, 10, 10, 255], [10, 10, 10, 254])), null);
  is("nothing to read: no color", toneOf(new Uint8ClampedArray(0)), null);
  is("a length that is not whole pixels: no color", toneOf(Uint8ClampedArray.from([1, 2, 3])), null);
  is("the pattern is exact", ["#964b0a", "#FFFFFF", "#fff", "red", "#12345g", " #123456"].map((t) => TONE_PATTERN.test(t)), [true, false, false, false, false, false]);

  part("Kept on the picture's record, read back only in its exact shape");
  const base = { path: "images/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp", width: 1200, height: 675, alt: "", bytes: 1, small: null };
  is("a color in its shape stays", parseProductImage({ ...base, tone: "#964b0a" })?.tone, "#964b0a");
  for (const bad of ["#FFFFFF", "#fff", "red", 7, null]) is(`a color ${JSON.stringify(bad)} is dropped`, "tone" in (parseProductImage({ ...base, tone: bad }) ?? {}), false);
  is("a picture from before has none", "tone" in (parseProductImage(base) ?? {}), false);

  part("Made in the browser from the picture being shrunk, sent with it, refused unless exact");
  const shrinkSource = readFileSync("components/shrink-image.ts", "utf8");
  // Codex K2 on #2790 (L2): a sample shrunk to 16 px averages one transparent pixel away; every pixel is read.
  is("shrink reads every pixel of the canvas it drew and asks toneOf", /getImageData\(0, 0, source\.width, source\.height\)/.test(shrinkSource) && /toneOf\(/.test(shrinkSource) && !/TONE_SAMPLE/.test(shrinkSource), true);
  const editor = readFileSync("components/product-image-editor.tsx", "utf8");
  is("the editor sends it with the picture", /\.\.\.\(shrunk\.tone \? \{ tone: shrunk\.tone \} : \{\}\)/.test(editor), true);
  const route = readFileSync("app/api/store/image/route.ts", "utf8");
  // Codex K2 on #2790 (L1), condition (1): a color sent that is not exact refuses the picture, nothing written
  // (tests/encanto-tone-route.test.ts runs the real route).
  is("the route refuses a picture sent with a color that is not exact", /body\.tone !== undefined && !\(typeof body\.tone === "string" && TONE_PATTERN\.test\(body\.tone\)\)/.test(route) && /\.\.\.\(tone \? \{ tone \} : \{\}\)/.test(route), true);

  part("Painted under the picture while it loads, nowhere else");
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_encanto_tone_only";
  await claimHandle("tone@example.com", "tonestore", "Tone Kitchen", "");
  await ensureStatsId("tone@example.com");
  await setStripeAccount("tone@example.com", "acct_1EncantoTone001", true);
  await setSubscription("tone@example.com", { customerId: "cus_Tone000001", subscriptionId: "sub_Tone000001", active: true, period: paidPeriod() });
  const made = await addProduct("tone@example.com", "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("tone@example.com", made.product.id, "https://example.com/course");
  const store = (await storeForEmail("tone@example.com"))!;
  const listed = (await readListing(store, made.product.id))!;
  const card = (image: unknown) =>
    renderToStaticMarkup(createElement(ProductCard, { store, product: { ...listed, image, display: "preview" } as Listing, related: [], remaining: null, writes: false, selling: true, manageable: false }));
  const toned = card({ ...base, tone: "#964b0a" });
  is("a card's picture with a color has it as its background", /<img[^>]*style="[^"]*background-color:#964b0a/.test(toned), true);
  is("one without keeps the style it had", /<img[^>]*background-color/.test(card(base)), false);
  for (const [file, count] of [["components/more-from.tsx", 2], ["components/store-collections.tsx", 1], ["app/[handle]/p/[product]/page.tsx", 1]] as const) {
    const source = readFileSync(file, "utf8");
    is(`${file}: its ${count} product picture(s) paint the color under them`, (source.match(/backgroundColor: [\w.?]*image\??\.tone/g) ?? []).length, count);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
