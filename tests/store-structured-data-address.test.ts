/**
 * What a store's pages tell search engines about their own address, in their
 * structured data (JSON-LD), must be the address the page names as its own
 * (its canonical). On a creator's live domain that is the domain's short
 * address (chef.com/p/…); a JSON-LD "url" still on marktmorgen.com/@handle
 * told Google the same page lived at two addresses, which is the duplicate
 * this site's canonicals exist to avoid.
 *
 * What is checked:
 *   - storeAddress gives the domain's address on a live domain, and the
 *     address here otherwise, the front page written as its canonical is;
 *   - the product page, its breadcrumb, a collection, the blog and a blog
 *     post build every JSON-LD address from it, never from SITE_URL.
 */
import { readFileSync } from "node:fs";
import { storeAddress } from "@/lib/store-sitemap";
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

const here = { handle: "mapshop", tier: "creator", subscriptionActive: true, domain: null } as unknown as Store;
const owned = { handle: "mapshop", tier: "pro", subscriptionActive: true, domain: { name: "shop.example.com", liveAt: "2026-10-01", verifiedAt: "2026-10-01" } } as unknown as Store;
const lapsed = { ...owned, tier: "creator" } as unknown as Store;

part("The address a page names as its own");
is("here: under marktmorgen.com/@handle", [storeAddress(here), storeAddress(here, "/p/rye-1")], [`${SITE_URL}/@mapshop`, `${SITE_URL}/@mapshop/p/rye-1`]);
is("on a live domain: the domain's, its front page with a slash", [storeAddress(owned), storeAddress(owned, "/p/rye-1")], ["https://shop.example.com/", "https://shop.example.com/p/rye-1"]);
is("a domain the plan no longer serves: the address here again", storeAddress(lapsed, "/blog"), `${SITE_URL}/@mapshop/blog`);

part("Every JSON-LD address on a store's pages is the page's own");
const product = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
const collection = readFileSync("app/[handle]/shop/[collection]/page.tsx", "utf8");
const blog = readFileSync("app/[handle]/blog/page.tsx", "utf8");
const post = readFileSync("app/[handle]/blog/[post]/page.tsx", "utf8");
is("the product's url and its offer's, from its canonical", product.includes("const url = storeAddress(store, `/p/${productSegment(product)}`);"), true);
is("its breadcrumb: the store and the product, from theirs", product.includes("breadcrumbData({ name: store.name, url: storeAddress(store) }, { title: product.title, url: storeAddress(store, `/p/${productSegment(product)}`) })"), true);
is("a collection and the products in it", [collection.includes("url: storeAddress(store, `/shop/${collectionSegment(collection)}`),"), collection.includes("url: storeAddress(store, `/p/${productSegment(product)}`)")], [true, true]);
is("the blog and each post on it", [blog.includes("url: storeAddress(store, \"/blog\"),"), blog.includes("url: storeAddress(store, `/blog/${postSegment(post)}`),")], [true, true]);
is("a post's author is the store at its own address", post.includes('author: { "@type": "Organization", name: store.name, url: storeAddress(store) },'), true);
// Nothing on these pages' structured data is written from the site's address any more.
for (const [name, text] of [["product", product], ["collection", collection], ["blog", blog], ["post", post]] as const) {
  is(`no JSON-LD address on the ${name} page starts at SITE_URL`, /url: `\$\{SITE_URL\}(?:\$\{|\/@)/.test(text) || /const url = `\$\{SITE_URL\}/.test(text), false);
}
done();
