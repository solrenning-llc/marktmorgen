/**
 * Encanto 5a, pictures that load faster on the store without changing the upload (C4-20261106-0520-TODOS-19, unit 5;
 * docs/encanto-visual-comparison-2026-11-06.md: product thumbnails of 1200 px drawn 56 px wide, about 13 s to the
 * largest picture on a slow network):
 *
 *   - a small picture beside a product in a list ("More from", "Also bought", a collection) offers the browser the
 *     smaller copy made at upload (lib/product-image.ts, SMALL_LONG_SIDE) with the width it is drawn at, so a 56 px
 *     slot no longer takes the full picture;
 *   - only the first card's picture is fetched at once; every one below it waits until it is near (loading="lazy");
 *   - on a computer, where the store page's cards go two to a row (Encanto 3), a card's cover there is described at
 *     the width it is drawn, so the browser does not fetch more than it shows; a one-column list (a collection) keeps
 *     the column's width (Codex K2 on #2786).
 */
import { readFileSync } from "node:fs";
import { IMAGE_SIZES } from "@/lib/product-image";
import { servedSrcSet } from "@/lib/picture-served";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const thumbs = (source: string) => source.match(/<img[^>]*className="st-thumb shrink-0"[^>]*\/>/g) ?? [];

part("A small picture in a list takes the smaller copy");
for (const [file, count] of [["components/more-from.tsx", 2], ["components/store-collections.tsx", 1]] as const) {
  const tags = thumbs(read(file));
  is(`${file}: each of its ${count} small pictures offers both copies`, tags.length === count && tags.every((tag) => tag.includes("srcSet={servedSrcSet(product.image)}")), true);
  is(`${file}: and says it is drawn 56 px wide`, tags.every((tag) => tag.includes('sizes="56px"') && tag.includes("width={56}")), true);
}
const image = { path: "images/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp", width: 1200, small: { path: "images/aaaaaaaaaaaaaaaaaaaaaaaa/cccccccccccccccccccccccccccccccc.webp", width: 800, bytes: 1 } };
is("the set it offers names the smaller copy first", servedSrcSet(image, null)?.startsWith("/api/image/aaaaaaaaaaaaaaaaaaaaaaaa/cccccccccccccccccccccccccccccccc.webp 800w"), true);

part("Only the first card's picture at once");
const store = read("app/[handle]/page.tsx");
const collection = read("app/[handle]/shop/[collection]/page.tsx");
is("the store page: eager only for the first", store.includes("eager={(position.get(product.id) ?? 9) < 1 && page === 1}"), true);
is("a collection: eager only for the first", collection.includes("eager={i < 1}"), true);

part("A card's cover is described at the width it is drawn");
// Codex K2 on #2786: only the store page's grid is two to a row; a collection and every other one-column list keep
// the column's width, or the browser would pick a copy narrower than it draws.
is("the store's grid: two to a row from 1024 px, the phone's own width below", IMAGE_SIZES.grid, "(min-width: 64rem) 25rem, (max-width: 36rem) calc(100vw - 2rem), 34rem");
is("a one-column list keeps the column's width", IMAGE_SIZES.cover, "(max-width: 36rem) calc(100vw - 2rem), 34rem");
const card = read("components/store-product.tsx");
is("a card says the grid's width only when it stands in the grid", /sizes=\{image\.small \? \(style === "preview" \? \(grid \? IMAGE_SIZES\.grid : IMAGE_SIZES\.cover\) : IMAGE_SIZES\.thumb\) : undefined\}/.test(card), true);
is("the store page's cards stand in the grid", /<ProductCard[\s\S]*?\bgrid\b[\s\S]*?\/>/.test(store), true);
is("a collection's do not", /<ProductCard[\s\S]*?\bgrid\b[\s\S]*?\/>/.test(collection), false);

done();
