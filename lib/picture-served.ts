/**
 * 313 [CV1] unit 4c: where a store's public pages take a product picture from. A picture copied to the pictures'
 * own R2 bucket (marked r2, lib/picture-r2-copy.ts) is taken from the images' own domain while that bucket is on
 * (lib/picture-r2.ts, pictureR2Config); every other picture, and every picture while it is off (as today), from
 * app/api/image as before. Server only: it reads the bucket's settings, so only the store's server-rendered
 * components call it; the studio's editors, which also run in the browser, keep imageUrl.
 */
import { pictureR2Config, pictureR2Url, type PictureR2Config } from "@/lib/picture-r2";
import { imageUrl, smallerCopies, type ProductImage } from "@/lib/product-image";

type Served = Pick<ProductImage, "path" | "width" | "small" | "r2" | "thumb">;

function bucketFor(image: Pick<ProductImage, "r2">, config: PictureR2Config | null | undefined): PictureR2Config | null {
  if (!image.r2) return null;
  return config === undefined ? pictureR2Config() : config;
}

/** The address of a product picture on a public page. */
export function servedImageUrl(image: Pick<ProductImage, "path" | "r2">, config?: PictureR2Config | null): string {
  const bucket = bucketFor(image, config);
  return bucket ? pictureR2Url(bucket, image.path) : imageUrl(image);
}

/** The copies with their widths, narrowest first, for the browser to choose by, from the same place as the picture. */
export function servedSrcSet(image: Served, config?: PictureR2Config | null): string | undefined {
  // The thumbnail copy (Encanto 5b-2) and the smaller copy, when there are any (lib/product-image.ts, smallerCopies).
  const copies = smallerCopies(image);
  if (!copies.length) return undefined;
  const bucket = bucketFor(image, config);
  const at = (path: string) => (bucket ? pictureR2Url(bucket, path) : imageUrl({ path }));
  return [...copies, { path: image.path, width: image.width }].map((copy) => `${at(copy.path)} ${copy.width}w`).join(", ");
}

/** The address made absolute for search data and sharing: the images' domain already is; the site's own needs its origin. */
export function absoluteImageUrl(url: string, site: string): string {
  return /^https:\/\//.test(url) ? url : `${site}${url}`;
}
