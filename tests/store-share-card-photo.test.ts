/**
 * LEVE of the review at d2ce0a1fad on #4250: the store layout's empty openGraph/twitter images left every page that
 * sets no picture of its own (a blog post, a collection, the letters page) with no picture at all. The store's own
 * photo, when it has one, is the default for every page of the store; with none, still no picture of the site's.
 * Reads the layout's source, as tests/store-share-card.test.ts does; and the unused productPath import is gone.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const layout = readFileSync("app/[handle]/layout.tsx", "utf8");
const meta = layout.slice(layout.indexOf("export async function generateMetadata"), layout.indexOf("export default"));

part("The store's photo is the share picture of every page that sets none");
is("one picture list, from the store's photo when it has one", /const pictures = store\.photoId \? \[\{ url: photoUrl\(store\.photoId\), width: 480, height: 480, alt: store\.name \}\] : \[\];/.test(meta), true);
is("used for the share card and the small card", [meta.includes('openGraph: { type: "website", siteName: store.name, images: pictures },'), meta.includes('twitter: { card: "summary", images: pictures },')], [true, true]);
is("never the site's own picture", /opengraph-image|og\.png|\/og\//.test(meta), false);

part("No unused import left in the collection page");
is("productPath is not imported where it is not used", readFileSync("app/[handle]/shop/[collection]/page.tsx", "utf8").includes("ProductCard, productPath }"), false);
done();
