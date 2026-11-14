/**
 * A link read back from storage is a web address again before it is rendered (the security audit of 14 November
 * 2026, LOW). Four records keep a link the creator typed, and each was checked only when it was saved (lib/
 * product-link.ts, readLink): a store page's links (lib/store-link.ts), a product's link (lib/catalog.ts), a price
 * option's link (lib/product-option.ts) and a lesson's link (lib/course.ts). Each is drawn into an href on the main
 * domain. A record written another way (an old one, a restored copy, a hand edit) with a link that is not a web
 * address now reads as no link, while every https and http link reads exactly as it was stored: nothing a creator
 * saved is rewritten or dropped for being an old or unusual web address.
 */
import { parseProduct } from "@/lib/catalog";
import { parseCourse } from "@/lib/course";
import { parseOptions } from "@/lib/product-option";
import { parseStoreLinks } from "@/lib/store-link";
import { done, is, part } from "./check";

const NOT_WEB = ["javascript:void(0)", "JavaScript:void(0)", " javascript:void(0)", "data:text/plain,hello", "vbscript:x", "file:///etc/hosts", "not a link at all"];
const WEB = ["https://example.com/guide", "http://example.com/old-guide", "https://example.com/a?b=c#d"];

const product = (link: string) => parseProduct({ id: "p8w2m4q9zz", title: "Guide", priceCents: 1200, link })?.link ?? null;
const option = (link: string) => parseOptions([{ id: "opt1", label: "Basic", priceCents: 500, link }])[0]?.link ?? null;
const lesson = (link: string) =>
  parseCourse(JSON.stringify({ id: "0123456789abcdef0123456789abcdef", modules: [{ id: "mod000000001", title: "One", lessons: [{ id: "les000000001", title: "Hello", link }] }] }))?.modules[0]?.lessons[0]?.link ?? null;
const storeLink = (url: string) => parseStoreLinks([{ id: "l1", title: "My site", url, addedAt: "" }])[0]?.url ?? null;

async function main(): Promise<void> {
  for (const [name, read] of [["a product's link", product], ["a price option's link", option], ["a lesson's link", lesson], ["a store page's link", storeLink]] as const) {
    part(name);
    is("(a record of this kind is read at all)", read("https://example.com/") !== null, true);
    for (const raw of NOT_WEB) is(`not a web address (${raw.trim().split(":")[0]}): read as none`, read(raw), null);
    for (const raw of WEB) is(`a web address reads as stored: ${raw}`, read(raw), raw);
  }
  part("A store page's header keeps its empty address");
  is("a header has no link and is still read", parseStoreLinks([{ id: "h1", title: "Section", url: "", header: true, addedAt: "" }]).length, 1);
  done();
}

void main();
