/**
 * A page made to stall the outreach reader is read in linear time (#4592).
 *
 * lib/outreach-rules.ts read a page's HTML with patterns that backtrack over the rest of the page from every "<"
 * (`/<[^>]+>/g`), every "<a " (`<a\b[^>]*...`), every "<script" or "<!--" with no end (lazy `[\s\S]*?` to a closing
 * tag that is not there), and lib/outreach.ts did the same for "<title" and "<meta". A page of up to 3,000,000
 * characters of any of them kept each find running until the function was stopped at 60 s, paid for by the store
 * that looked the site up. Each is now bounded, and a real page still reads the same.
 *
 * Synthetic pages only; no network (readSite takes the reader).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { contactPages, pageText, publishedAddresses } from "@/lib/outreach-rules";
import { readSite } from "@/lib/outreach";

// The page cap (lib/outreach.ts PAGE_BYTES); REDOS_SIZE runs a smaller page to show a slow reader without waiting hours.
const SIZE = Number(process.env.REDOS_SIZE) || 3_000_000;
const within = (ms: number, label: string, work: () => unknown) => {
  const started = performance.now();
  work();
  const took = performance.now() - started;
  assert.ok(took < ms, `${label} took ${Math.round(took)} ms`);
};

const hostile: [string, string][] = [
  ["'<' with no '>'", "<".repeat(SIZE)],
  ["'<a ' with no '>'", "<a ".repeat(SIZE / 3)],
  ["'<a href=\"/contact\">' with no '</a>'", "<a href=\"/contact\">".repeat(SIZE / 19)],
  ["'<script' with no end", "<script>".repeat(SIZE / 8)],
  ["'<style' with no end", "<style>".repeat(SIZE / 7)],
  ["'<!--' with no end", "<!--".repeat(SIZE / 4)],
  ["a mailto link with no '>'", "<a href='mailto:x@example.org' ".repeat(SIZE / 32)],
  // One tag that never closes, holding many attributes: each try used to run to the end of the page (Claude 6 on #4619).
  ["one '<a' holding many href= and no '>'", `<a ${"href='x' ".repeat(SIZE / 9)}`],
  ["one '<a' holding many mailto href= and no '>'", `<a ${"href='mailto:x' ".repeat(SIZE / 16)}`],
];

for (const [label, html] of hostile) {
  test(`pageText reads a page of ${label} in linear time`, () => within(1_000, `pageText on ${label}`, () => pageText(html)));
  test(`contactPages reads a page of ${label} in linear time`, () => within(1_000, `contactPages on ${label}`, () => contactPages(html, "https://shop.example.org/")));
}

test("a whole find on a hostile site ends well inside the function's time limit", async () => {
  for (const html of ["<".repeat(SIZE), "<title>".repeat(SIZE / 7), "<meta ".repeat(SIZE / 6), `<meta ${"name='og:site_name' ".repeat(SIZE / 20)}`, `<a href="/contact">Contact</a><a ${"href='/contact' ".repeat(SIZE / 16)}`]) {
    const started = performance.now();
    await readSite("https://shop.example.org", async (url) => (url.endsWith("/robots.txt") ? null : { url, html }));
    const took = performance.now() - started;
    assert.ok(took < 3_000, `a find took ${Math.round(took)} ms`);
  }
});

test("a real page still reads the same", () => {
  const page = [
    "<html><head><title>Fern &amp; Pine</title><style>p { color: red }</style><script>var a = '<b>';</script></head>",
    "<body><!-- nav --><p>Write to us at <a href=\"mailto:hello%40fernandpine.com\">our desk</a> or",
    " partners@fernandpine.com.<br>No&nbsp;unsolicited email.</p>",
    "<a href=\"/contact\">Contact us</a> <a href=\"/pages/partners\"><span>Partnerships</span></a> <a href=\"/products/x\">Shop</a></body></html>",
  ].join("");
  assert.equal(pageText(page), "Fern & Pine Write to us at hello@fernandpine.com our desk or partners@fernandpine.com. No unsolicited email. Contact us Partnerships Shop");
  assert.deepEqual(contactPages(page, "https://fernandpine.com/"), ["https://fernandpine.com/pages/partners", "https://fernandpine.com/contact"]);
  assert.deepEqual(publishedAddresses(page, "https://fernandpine.com/", "fernandpine.com").map((a) => a.email), ["partners@fernandpine.com", "hello@fernandpine.com"]);
});

test("a letter that is longer in lower case never moves a cut (İ before a script)", () => {
  // toLowerCase() makes "İ" two code units: cuts taken from it landed beside the marks (Claude 6 on #4619).
  for (const count of [3, 12]) {
    const page = `<p>${"İ".repeat(count)}</p><script>var secret = 1;</script><p>info@fernandpine.com</p>`;
    assert.equal(pageText(page), `${"İ".repeat(count)} info@fernandpine.com`);
    assert.deepEqual(publishedAddresses(page, "https://fernandpine.com/", "fernandpine.com").map((a) => a.email), ["info@fernandpine.com"]);
  }
  assert.deepEqual(contactPages(`<p>İİİİ</p><A HREF="/contact">Contact Us</A>`, "https://fernandpine.com/"), ["https://fernandpine.com/contact"]);
});
