/**
 * The welcome video, a part of the page order (496 [ME1], unit 3; added 16
 * November 2026), so the first product is not pushed below the first screen.
 *
 * Until now the video stood inside the profile, under the creator's name: on
 * a 390 × 844 phone a 16:9 player about 230 px tall sat between the name and
 * the first product. The item asks that what stands above the products move
 * after them by default, with the creator able to put it back. So the video
 * is one of the parts of lib/store-order.ts, right after the products in the
 * usual order: a store that never chose an order gets it there, a store that
 * chose one finds it right after its products (parseOrder's rule for a part
 * added later), and Page order in the studio moves it above them in two
 * presses. Nothing of the creator's is removed or changed: the same video,
 * the same player, loaded only when played. Checked in the order's own
 * functions and in the markup of the page, the studio and the words that say
 * where the video shows.
 */
import { readFileSync } from "node:fs";
import { PAGE_PARTS, USUAL_ORDER, drawnOrder, parseOrder } from "@/lib/store-order";
import { done, is, part } from "./check";

const page = readFileSync("app/[handle]/page.tsx", "utf8");
const studio = readFileSync("app/studio/page.tsx", "utf8");
const editor = readFileSync("components/intro-editor.tsx", "utf8");
const features = readFileSync("lib/feature-pages.ts", "utf8");
const coach = readFileSync("lib/store-coach.ts", "utf8");

function main(): void {
  part("The welcome video is a part of the page order");
  is("right after the products in the usual order", USUAL_ORDER.slice(0, 3), ["products", "intro", "quotes"]);
  const intro = PAGE_PARTS.find((each) => each.id === ("intro" as never));
  is("named as the creator knows it in the studio", intro ? [intro.label, intro.note] : null, ["Welcome video", "Your hello from YouTube, Vimeo or Loom, loaded only when a visitor presses play. Shown when you have added one."]);
  is("a store that never chose an order has it after its products", parseOrder(undefined).indexOf("intro" as never), 1);
  const keptBefore = ["signup", "links", "tips", "products", "quotes", "faq", "contact", "community"];
  is("a store that chose its order before finds it right after its products", parseOrder(keptBefore), ["signup", "links", "tips", "products", "intro", "quotes", "faq", "contact", "community"]);
  const above = ["intro", "products", "quotes", "links", "tips", "signup", "faq", "contact", "community"];
  is("a creator who wants it first keeps it first", parseOrder(above), above);
  is("a search still puts the products first", drawnOrder(parseOrder(above), true)[0], "products");

  part("The store page draws it where the order says");
  const profile = page.slice(page.indexOf('data-store-profile=""'), page.indexOf("</section>", page.indexOf('data-store-profile=""')));
  is("no longer inside the profile, above the products", profile.includes("VideoEmbed"), false);
  is("shown when there is a video and no search", page.includes("intro: store.intro !== null && !searching,"), true);
  const drawn = page.slice(page.indexOf('{part === "intro"'), page.indexOf('{part === "quotes"'));
  is("drawn as its own part, the same player loaded only when played", drawn.includes('<VideoEmbed video={store.intro} title={store.name} poster={null} lang={store.language} />'), true);
  is("one video on the page", page.split("<VideoEmbed video={store.intro}").length - 1, 1);

  part("The studio and the words say where it shows");
  is("Page order says whether it shows now", studio.includes("intro: store.intro !== null,"), true);
  is("the video box no longer says it plays under the name", /under your name/.test(editor), false);
  is("it says where it shows and links to the order that moves it", editor.includes('It shows after your products, unless you move it higher in <a href="#order" className="link">the order of your page</a>.'), true);
  const card = features.slice(features.indexOf('title: "You, at the top"'), features.indexOf("}", features.indexOf('title: "You, at the top"')));
  is("the features page no longer promises it under the name", /welcome video[^.]*under them/.test(card), false);
  is("and says it goes after the products or above them, as the creator chooses", card.includes("a welcome video from YouTube, Vimeo or Loom, after your products or above them, as you choose"), true);
  is("the store coach names it without a place", coach.includes('label: "A welcome video",'), true);
}

main();
done();
