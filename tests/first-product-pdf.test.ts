/**
 * The first product as a tagged PDF (490 [PP1], unit 2; lib/first-product-pdf.ts, lib/tagged-pdf-sheet.ts and
 * app/api/store/first-product/pdf; added 12 November 2026). Checked:
 *
 *   - what the screen sends is read against the outline the format and answers make: the same number of parts, a
 *     real title (never the placeholder), at least one part written, and too much text refused, never cut;
 *   - an empty heading or group name is the outline's own, and a renamed one is the creator's;
 *   - the file says only what the creator wrote: the title, who made it, then each written part (a checklist as its
 *     groups with numbered items); an empty part is left out; a long unbroken run of letters is cut into pieces;
 *   - the file is tagged for a screen reader: a structure tree, marked content, its language and its title shown;
 *   - the route, with a real session, answers with the file to download, and refuses a missing title or letters
 *     the fonts cannot draw before taking the rest of its studio requests;
 *   - the longest file, measured, stays inside what FIRST_PRODUCT_PDF_UNITS studio requests are priced at.
 */
import { NextRequest } from "next/server";
import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFRef } from "pdf-lib";
import { readFileSync } from "node:fs";
import {
  FIRST_PRODUCT_LONG_WORD,
  FIRST_PRODUCT_MAX_BREAKS,
  FIRST_PRODUCT_MAX_PART,
  FIRST_PRODUCT_MAX_TEXT,
  FIRST_PRODUCT_PDF_UNITS,
  breakLongWords,
  firstProductFileName,
  firstProductPdf,
  firstProductTexts,
  readFirstProduct,
} from "@/lib/first-product-pdf";
import { outlineFor, placeholderTitle } from "@/lib/first-product";
import { claimHandle, setStripeAccount, setSubscription } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as pdfRoute } from "@/app/api/store/first-product/pdf/route";
import { FIRST_PRODUCT_PDF_READ, UNIT_COST } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const partsOf = (format: "guide" | "checklist" | "workbook" | "template", answers: Record<string, string>, fill: (i: number) => string) =>
  outlineFor(format, answers, "x").parts.map((_, i) => ({ heading: "", body: fill(i) }));

async function main(): Promise<void> {
  redis.clear();

  part("Read against the outline");
  const guide = { format: "guide", answers: { length: "short" }, title: "Bread at home", parts: partsOf("guide", { length: "short" }, (i) => (i === 1 ? "Mix flour and water." : "")) };
  const read = readFirstProduct(guide);
  is("a guide with one part written is read", read.ok, true);
  is("an empty heading is the outline's own", read.ok ? read.sheet.parts.map((p) => p.heading) : null, outlineFor("guide", { length: "short" }, "x").parts.map((p) => p.heading));
  is(
    "refused: no format, no title, the placeholder, a part more or less, nothing written",
    [
      readFirstProduct({ ...guide, format: "novel" }),
      readFirstProduct({ ...guide, title: "  " }),
      readFirstProduct({ ...guide, title: placeholderTitle("guide") }),
      readFirstProduct({ ...guide, parts: [...guide.parts, { heading: "", body: "more" }] }),
      readFirstProduct({ ...guide, parts: guide.parts.slice(1) }),
      readFirstProduct({ ...guide, parts: guide.parts.map((p) => ({ ...p, body: "   " })) }),
      readFirstProduct(null),
    ].map((r) => (r.ok ? "read" : r.reason)),
    ["format", "title", "title", "parts", "parts", "empty", "parts"],
  );
  is("too much in one part is refused, never cut", readFirstProduct({ ...guide, parts: guide.parts.map((p, i) => (i === 0 ? { ...p, body: "a".repeat(FIRST_PRODUCT_MAX_PART + 1) } : p)) }), { ok: false, reason: "long" });
  const longList = { format: "checklist", answers: { length: "long", groups: "none" }, title: "List", parts: partsOf("checklist", { length: "long", groups: "none" }, () => "b ".repeat(FIRST_PRODUCT_MAX_PART / 2 - 1)) };
  is("too much in the whole file is refused", [longList.parts.length * (FIRST_PRODUCT_MAX_PART - 2) > FIRST_PRODUCT_MAX_TEXT, readFirstProduct(longList)], [true, { ok: false, reason: "long" }]);
  const lines = (n: number) => ({ ...guide, parts: guide.parts.map((p, i) => (i === 1 ? { ...p, body: "a\n".repeat(n) + "a" } : p)) });
  is("at most FIRST_PRODUCT_MAX_BREAKS line breaks in the file: one more is refused", [readFirstProduct(lines(FIRST_PRODUCT_MAX_BREAKS)).ok, readFirstProduct(lines(FIRST_PRODUCT_MAX_BREAKS + 1))], [true, { ok: false, reason: "long" }]);
  is("a run of empty lines counts as one", (() => {
    const r = readFirstProduct({ ...guide, parts: guide.parts.map((p, i) => (i === 1 ? { ...p, body: "One.\n\n\n\n \n\nTwo." } : p)) });
    return r.ok ? r.sheet.parts[1].body : null;
  })(), "One.\n\nTwo.");
  is("a renamed heading is kept, with tabs and stray control letters made spaces", (() => {
    const r = readFirstProduct({ ...guide, parts: guide.parts.map((p, i) => (i === 1 ? { heading: "Mix\tit", body: "Flour\u0007and water.\r\nRest." } : p)) });
    return r.ok ? r.sheet.parts[1] : null;
  })(), { heading: "Mix it", body: "Flour and water.\nRest." });

  part("What the file says");
  const texts = read.ok ? firstProductTexts(read.sheet, "Harbor Kitchen") : [];
  is("the title, who made it, then each written part", texts, [
    { role: "H1", text: "Bread at home" },
    { role: "P", text: "By Harbor Kitchen" },
    { role: "H2", text: "Step 1" },
    { role: "P", text: "Mix flour and water." },
  ]);
  const grouped = readFirstProduct({ format: "checklist", answers: { length: "short", groups: "stages" }, title: "Move day", groups: ["", "On the day"], parts: partsOf("checklist", { length: "short", groups: "stages" }, (i) => (i < 5 ? `Task ${i}` : "")) });
  is(
    "a checklist: its groups as headings, renamed or not, each with its items numbered; a group with nothing written is left out",
    grouped.ok ? firstProductTexts(grouped.sheet, "S").slice(2) : null,
    [
      { role: "H2", text: "Before" },
      { role: "P", text: "1. Task 0" },
      { role: "P", text: "2. Task 1" },
      { role: "P", text: "3. Task 2" },
      { role: "P", text: "4. Task 3" },
      { role: "H2", text: "On the day" },
      { role: "P", text: "1. Task 4" },
    ],
  );
  const link = "https://example.com/" + "x".repeat(100);
  is("a long unbroken run of letters is cut into pieces, nothing lost", [breakLongWords(`see ${link}`).split(" ").every((w) => Array.from(w).length <= FIRST_PRODUCT_LONG_WORD), breakLongWords(`see ${link}`).replace(/ /g, ""), breakLongWords("short words stay")], [true, `see${link}`, "short words stay"]);
  is("a file name from the title", [firstProductFileName("Bread at home: a guide!"), firstProductFileName("???")], ["Bread-at-home-a-guide.pdf", "my-product.pdf"]);

  part("Tagged for a screen reader");
  const bytes = read.ok ? await firstProductPdf(read.sheet, "Harbor Kitchen", "en") : new Uint8Array();
  const doc = await PDFDocument.load(bytes);
  const root = doc.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
  const kids = root.lookup(PDFName.of("K"), PDFDict).lookup(PDFName.of("K"), PDFArray).asArray().map((ref) => doc.context.lookup(ref as PDFRef, PDFDict));
  is("a structure tree in reading order: the title, who made it, a heading and its words", kids.map((k) => k.get(PDFName.of("S"))?.toString()), ["/H1", "/P", "/H2", "/P"]);
  is("marked, with its title and language", [Boolean(doc.catalog.get(PDFName.of("MarkInfo"))), doc.getTitle(), doc.catalog.get(PDFName.of("Lang"))?.toString()], [true, "Bread at home", "(en)"]);

  part("The route");
  const owner = "first@example.com";
  await claimHandle(owner, "firstshop", "First Shop", "");
  await setStripeAccount(owner, "acct_1FirstShop0001", true);
  await setSubscription(owner, { customerId: "cus_First0001", subscriptionId: "sub_First0001", active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(owner);
  const post = (body: unknown) =>
    pdfRoute(new NextRequest("https://marktmorgen.com/api/store/first-product/pdf", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  let response = await post(guide);
  is("the file, to download, kept nowhere", [response.status, response.headers.get("content-type"), response.headers.get("content-disposition"), response.headers.get("cache-control"), Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()], [200, "application/pdf", 'attachment; filename="Bread-at-home.pdf"', "private, no-store", "%PDF-"]);
  response = await post({ ...guide, title: "" });
  is("a missing title is said", [response.status, ((await response.json()) as { error?: string }).error], [400, "title"]);
  response = await post({ ...guide, parts: guide.parts.map((p, i) => (i === 1 ? { ...p, body: "面包" } : p)) });
  is("letters the fonts cannot draw are said, and nothing is made", [response.status, ((await response.json()) as { error?: string }).error], [422, "letters"]);
  const source = readFileSync("app/api/store/first-product/pdf/route.ts", "utf8");
  is("the rest of its studio requests is taken after the checks and before it is drawn", source.indexOf("firstProductDrawable(texts)") < source.indexOf("countStudio(store, null, FIRST_PRODUCT_PDF_UNITS - 1)") && source.indexOf("countStudio(store, null, FIRST_PRODUCT_PDF_UNITS - 1)") < source.indexOf("await firstProductPdf("), true);
  is("only who may change products may make it", source.includes('guardStoreWrite(request, "products", FIRST_PRODUCT_BODY_BYTES)'), true);

  part("What it costs");
  let worstCpu = 0;
  let worstBytes = 0;
  for (const [format, answers] of [["checklist", { length: "long", groups: "none" }], ["guide", { length: "long" }], ["workbook", { length: "long" }], ["template", { length: "long" }]] as const) {
    const count = outlineFor(format, answers, "x").parts.length;
    // Every part as long as the whole file allows once the title and the 100-letter headings are counted.
    const per = Math.min(FIRST_PRODUCT_MAX_PART, Math.floor((FIRST_PRODUCT_MAX_TEXT - 100 - count * 100) / count));
    const word = "Wm".repeat(19) + " ";
    const body = word.repeat(Math.ceil(per / word.length)).slice(0, per);
    // The widest letters at the most characters, and, as long again, short lines at the most line breaks.
    const breaksEach = Math.floor(FIRST_PRODUCT_MAX_BREAKS / count);
    const shortLines = ("Wm\n".repeat(breaksEach) + body).slice(0, per);
    for (const text of [body, shortLines]) {
    const sheet = readFirstProduct({ format, answers, title: "W".repeat(100), parts: Array.from({ length: count }, () => ({ heading: "W".repeat(100), body: text })) });
    if (!sheet.ok) throw new Error(`the longest ${format} was refused: ${sheet.reason}`);
    const before = process.cpuUsage();
    const made = await firstProductPdf(sheet.sheet, "W".repeat(60), "en");
    const used = process.cpuUsage(before);
    worstCpu = Math.max(worstCpu, (used.user + used.system) / 1e6);
    worstBytes = Math.max(worstBytes, made.length);
    }
  }
  console.log(`longest first-product PDF: ${worstCpu.toFixed(2)} s of CPU, ${worstBytes} bytes; priced at 2 s and 100,000 bytes`);
  is("the longest file measured is inside what is priced, with room (half the CPU, the bytes)", [worstCpu <= 1, worstBytes <= 100_000], [true, true]);
  is("and what is priced is inside the studio requests it takes", FIRST_PRODUCT_PDF_UNITS * UNIT_COST.studio >= FIRST_PRODUCT_PDF_READ, true);
  console.log(`a first product's PDF: $${FIRST_PRODUCT_PDF_READ.toFixed(6)} at most, counted as ${FIRST_PRODUCT_PDF_UNITS} studio requests at $${UNIT_COST.studio.toFixed(6)}`);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
