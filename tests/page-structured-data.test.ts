/**
 * What a sales page tells search engines (lib/page-structured-data.ts):
 * its answered questions, once each, not ones kept to computers, and where
 * it sits in the store.
 */
import { readFileSync } from "node:fs";
import { MIN_COURSE_LIST, breadcrumbData, courseData, courseListData, faqData } from "@/lib/page-structured-data";
import { parsePage } from "@/lib/sales-page";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("Questions and answers");
  const page = parsePage({
    blocks: [
      { id: "faq00001", kind: "faq", heading: "Questions", items: [{ q: "How long do I keep it?", a: "For good." }, { q: "Is there a refund?", a: "Within 30 days." }] },
      { id: "faq00002", kind: "faq", heading: "More", items: [{ q: "how long do I keep it?", a: "Again." }, { q: "Do I need a knife?", a: "Any sharp one." }], screens: "phone" },
      { id: "faq00003", kind: "faq", heading: "Wide", items: [{ q: "Only on computers?", a: "Yes." }], screens: "computer" },
    ],
  });
  const faq = faqData(page.blocks) as { "@type": string; mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
  is("an FAQ page", faq["@type"], "FAQPage");
  is("each question once, with its answer, in the page's order", faq.mainEntity.map((q) => [q.name, q.acceptedAnswer.text]), [["How long do I keep it?", "For good."], ["Is there a refund?", "Within 30 days."], ["Do I need a knife?", "Any sharp one."]]);
  is("none when the page has no answered question", faqData(parsePage({ blocks: [{ id: "text0001", kind: "text", heading: "A", body: "b" }] }).blocks), null);

  part("Where it sits");
  const crumbs = breadcrumbData({ name: "Harbor Kitchen", url: "https://marktmorgen.com/@harbor" }, { title: "Knife Skills", url: "https://marktmorgen.com/@harbor/p/knife-skills-5e3f350b52" }) as { itemListElement: { position: number; name: string }[] };
  is("the store, then the product", crumbs.itemListElement.map((i) => [i.position, i.name]), [[1, "Harbor Kitchen"], [2, "Knife Skills"]]);

  part("Courses (639 [GL7](20), Google's course list read on 4 November 2026)");
  const provider = { name: "Harbor Kitchen", url: "https://marktmorgen.com/@harbor" };
  const knife = { name: "Knife Skills", description: "Six lessons on holding, sharpening and cutting.", url: "https://marktmorgen.com/@harbor/p/knife-skills-5e3f350b52" };
  is("a course: its name, description, page and provider", courseData(knife, provider), { "@context": "https://schema.org", "@type": "Course", name: "Knife Skills", description: "Six lessons on holding, sharpening and cutting.", url: knife.url, provider: { "@type": "Organization", name: "Harbor Kitchen", sameAs: provider.url } });
  is("no markup for a name with a price, a discount or a call to buy, or without a description", [courseData({ ...knife, name: "Knife Skills - only $30!" }, provider), courseData({ ...knife, name: "Knife Skills 50% off" }, provider), courseData({ ...knife, name: "Knife Skills: buy now" }, provider), courseData({ ...knife, description: " " }, provider)], [null, null, null, null]);
  const more = (n: number) => Array.from({ length: n }, (_, i) => ({ ...knife, name: `Course ${i + 1}`, url: `${knife.url}-${i}` }));
  is("but a plain name with ordinary words keeps it", [courseData({ ...knife, name: "Gluten-free Baking" }, provider) !== null, courseData({ ...knife, name: "Off-grid Living" }, provider) !== null, courseData({ ...knife, name: "The Only Sourdough Guide" }, provider) !== null], [true, true, true]);
  is("a list only from three courses", [MIN_COURSE_LIST, courseListData(more(2), provider), (courseListData(more(3), provider) as { itemListElement: unknown[] }).itemListElement.length], [3, null, 3]);
  is("each listed once, in order, by its own page", courseListData([...more(3), more(1)[0]], provider), { "@context": "https://schema.org", "@type": "ItemList", itemListElement: more(3).map((c, i) => ({ "@type": "ListItem", position: i + 1, url: c.url })) });
  is("a course that cannot be marked up does not count toward the three", courseListData([...more(2), { ...knife, name: "Bread course on sale", url: "x" }], provider), null);

  part("On the page");
  const source = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
  is("both are given to search engines", [source.includes("<JsonLd data={breadcrumbData("), source.includes("{faq ? <JsonLd data={faq} /> : null}")], [true, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
