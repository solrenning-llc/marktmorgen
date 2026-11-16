/**
 * A link to a creator's store page, shared in a chat or a post, unfolds into
 * what the page's head says. Pages of a store with no picture of their own (a
 * front page with no photo, a collection, a page of the store, a blog post,
 * the emails) took the site's own: Marktmorgen's preview illustration, "an
 * example Stripe checkout and a delivered file", with its alt text about
 * Marktmorgen's paid plans, under a large card. That is not what the page
 * shows, and not the creator's (VR item 2).
 *
 * The store's layout now sets the share card for all of its pages: the
 * store's name as the site, no picture, a small card. A page with a picture
 * of its own (a photo on the front page, a product's drawn picture) still
 * sets its own over it.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const layout = readFileSync("app/[handle]/layout.tsx", "utf8");
const meta = layout.slice(layout.indexOf("export async function generateMetadata"), layout.indexOf("export default"));

part("The share card of a store's pages");
is("the store's name as the site, and no picture of the site's", meta.includes("openGraph: { type: \"website\", siteName: store.name, images: [] },"), true);
is("a small card with no picture, unless the page sets its own", meta.includes('twitter: { card: "summary", images: [] },'), true);
is("the front page's photo and a product's picture still set their own", [/images: \[\{ url: photoUrl\(store\.photoId\)/.test(readFileSync("app/[handle]/page.tsx", "utf8")), readFileSync("app/[handle]/p/[product]/page.tsx", "utf8").includes('twitter: { card: "summary_large_image", title, description }')], [true, true]);
done();
