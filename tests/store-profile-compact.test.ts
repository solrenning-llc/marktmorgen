/**
 * The store page's profile, compact (496 [ME1], unit 2; added 1 November
 * 2026), so the first product starts higher on the first screen. Checked in
 * the page's own markup: a 72-pixel photo (it was 104), the name a size
 * down, the introduction at the body size, less room above and below, and
 * the creator's words all kept (nothing cut, nothing hidden).
 *
 * Measured on the demo store with the local stand-ins (1 November 2026,
 * Chromium, fonts loaded): the first product's card ended at 953 px on a
 * 390 × 844 phone and at 997 px on a 1280 × 720 screen; with this profile, at
 * 835 and 865. The phone's first card fits; the desktop's does not yet, nor
 * a card with its buy box: the next unit (the first card's layout) is on the
 * queue, and the automatic first-screen test comes with it.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const page = readFileSync("app/[handle]/page.tsx", "utf8");
const socials = readFileSync("components/store-socials-row.tsx", "utf8");

function main(): void {
  part("The profile, compact");
  is("a 72-pixel photo", [page.includes("width={72}\n                height={72}"), page.includes('style={{ width: 72, height: 72 }}')], [true, true]);
  is("the initial when there is no photo, the same size", page.includes('className="st-avatar st-avatar-initial" style={{ width: 72, height: 72, fontSize: "1.75rem" }}'), true);
  is("less room above it", page.includes('"pb-1 pt-6 sm:pt-8"') && page.includes('"pb-8 pt-8 sm:pt-10"'), true);
  is("the name a size down, close under the photo", page.includes('<h1 className="font-display mt-3 text-2xl font-semibold leading-tight tracking-[-0.02em] sm:text-3xl">'), true);
  is("the introduction at the body size, whole", page.includes('<p className="st-muted mx-auto mt-2 max-w-md leading-relaxed">{store.bio}</p>'), true);
  is("nothing of the creator's cut or hidden: no clamp, no truncation", /line-clamp|truncate|text-ellipsis/.test(page.slice(page.indexOf('data-store-profile'), page.indexOf("</section>", page.indexOf('data-store-profile')))), false);
  is("the social links closer", socials.includes('className="mx-auto mt-3 max-w-lg"'), true);
  is("the products start sooner", page.includes('<div className="mx-auto max-w-xl px-4 pb-16 pt-5">'), true);
  is("the profile is marked for the first-screen measure, apart from the reorderable parts", page.includes('data-store-profile=""') && !page.includes('data-part="profile"'), true);
}

main();
done();
