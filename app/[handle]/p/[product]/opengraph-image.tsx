import { ImageResponse } from "next/og";
import { get } from "@/lib/blob";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { productIdFromAddress, readListing } from "@/lib/catalog";
import { lookColours } from "@/lib/store-look";
import { MAX_IMAGE_BYTES } from "@/lib/product-image";
import { averageText, showsRating, summaryOf } from "@/lib/reviews";
import { canUseDomain } from "@/lib/domains";
import { pricePill } from "@/components/store-product";
import { holdState } from "@/lib/child-safety";

/**
 * The picture a product's link unfolds into when it is shared: the product's
 * own picture beside its name, its price, its store and — only when the page
 * shows them — its stars, drawn in the store's own colours.
 *
 * Every word on it is on the page it links to, so a shared card can never
 * promise what the page does not. A product without a picture gets the same
 * card in its store's colours. A store switched off after notices gets the
 * plain card a missing product gets, with no product on it.
 *
 * Product pictures are kept as WebP or JPEG (lib/product-image.ts). The card
 * drawer reads JPEG itself; a WebP picture is turned into JPEG first by
 * sharp, which ships with Next where it runs. Where sharp is not there, or
 * the picture cannot be read, the card is drawn without it rather than not
 * at all.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "A product, its price and the store that sells it";

type Params = { params: Promise<{ handle: string; product: string }> };

async function readPicture(path: string): Promise<string | null> {
  try {
    const found = await get(path, { access: "private" });
    if (!found || found.statusCode !== 200 || !found.stream) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = found.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES * 2) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    let bytes = Buffer.concat(chunks);
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!isJpeg) {
      const sharp = (await import("sharp").catch(() => null))?.default;
      if (!sharp) return null;
      // A picture is checked when it is uploaded; the pixel ceiling is here
      // too, so one that is small on disk but enormous decoded is refused
      // rather than filling the memory of the function drawing the card.
      bytes = await sharp(bytes, { limitInputPixels: 40_000_000 }).jpeg({ quality: 86 }).toBuffer();
    }
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

export default async function OpengraphImage({ params }: Params) {
  const { handle, product: id } = await params;
  let decoded = "";
  try {
    decoded = decodeURIComponent(handle);
  } catch {
    // An address with a broken escape in it names no store: the plain card.
  }
  const store = decoded.startsWith("@") ? await storeForHandle(normaliseHandle(decoded)).catch(() => null) : null;
  // A store switched off after notices (lib/takedown.ts) shows no product on
  // its pages, so its card is the plain one a missing product gets. A store
  // that cannot be read is already null above: the plain card too.
  const found =
    store && !store.suspended ? await readListing(store, productIdFromAddress(store, id) ?? id).catch(() => null) : null;
  // A draft has no picture to share either, nor a product held for a child-safety report (lib/child-safety.ts),
  // even when taking it off the store did not go through; a hold that cannot be read is not a yes.
  const product = found && store && !found.hidden && (await holdState(store, found.id)) === "free" ? found : null;
  const colours = lookColours(store?.look ?? { theme: "light", accent: "#5a36ee" });
  const title = product?.title ?? "Marktmorgen";
  const storeName = store?.name ?? "Marktmorgen";
  const [picture, summary] = await Promise.all([
    product?.image ? readPicture(product.image.path) : Promise.resolve(null),
    store && product ? summaryOf(store.statsId, product.id).catch(() => null) : Promise.resolve(null),
  ]);
  const stars = summary && showsRating(summary) ? summary : null;
  // In the store's own currency and language (lib/money.ts, lib/buyer-words), as the page writes it.
  const price = product && store ? pricePill(store, product) : "";
  const address =
    store?.domain?.liveAt && canUseDomain(store) ? store.domain.name : `marktmorgen.com/@${store?.handle ?? ""}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          backgroundImage: `linear-gradient(135deg, ${colours.accent}, ${colours.accent2})`,
          color: colours.onAccent,
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            width: picture ? 640 : 1200,
            padding: "64px 56px 64px 72px",
          }}
        >
          <div style={{ display: "flex", fontSize: 30, fontWeight: 700, opacity: 0.9 }}>{storeName}</div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                display: "flex",
                fontSize: title.length > 48 ? 54 : 68,
                fontWeight: 800,
                lineHeight: 1.08,
                letterSpacing: "-0.02em",
              }}
            >
              {title}
            </div>
            <div style={{ display: "flex", alignItems: "center", marginTop: 32, gap: 20 }}>
              {price ? (
                <div
                  style={{
                    display: "flex",
                    padding: "10px 26px",
                    borderRadius: 999,
                    background: colours.card,
                    color: colours.text,
                    fontSize: 34,
                    fontWeight: 700,
                  }}
                >
                  {price}
                </div>
              ) : null}
              {stars ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 30, fontWeight: 700 }}>
                  <svg width="34" height="34" viewBox="0 0 24 24">
                    <path d="m12 3.8 2.5 5.1 5.6.8-4.05 3.95.96 5.6L12 16.6l-5.01 2.65.96-5.6L3.9 9.7l5.6-.8L12 3.8Z" fill={colours.onAccent} />
                  </svg>
                  {`${averageText(stars)} · ${stars.count} verified ${stars.count === 1 ? "review" : "reviews"}`}
                </div>
              ) : null}
            </div>
          </div>
          <div style={{ display: "flex", fontSize: 24, opacity: 0.8 }}>{address}</div>
        </div>
        {picture ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 560, padding: "48px 56px 48px 0" }}>
            <img
              src={picture}
              alt=""
              width={504}
              height={534}
              style={{ width: 504, height: 534, objectFit: "cover", borderRadius: 36, border: `6px solid ${colours.card}` }}
            />
          </div>
        ) : null}
      </div>
    ),
    { ...size },
  );
}
