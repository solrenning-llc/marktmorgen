/**
 * 281 [SF1], complement WG (b): the browser fetches the top picture first, and only that one.
 *
 * A sales page's hero is always its first block. With a picture beside or behind the words, that picture already
 * asks to be fetched first (fetchPriority="high"). With a video, the still drawn before play (the product's own
 * picture) is what a phone paints largest at the top, but it asked for nothing, so the browser fetched it at the same
 * rank as every picture further down. The hero's video now passes `priority`, and the still asks for the same as the
 * hero's picture. A video anywhere else on the page (a row, a block of its own, a store's link, a thank-you note)
 * never asks: one picture a page, or the hint means nothing.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoEmbed } from "@/components/video-embed";
import { type BlockContext, HeroView } from "@/components/sales-blocks";
import type { HeroBlock } from "@/lib/sales-page";
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const video = { provider: "youtube" as const, id: "dQw4w9WgXcQ", hash: "" };
const poster = { src: "/api/image/aaaaaaaaaaaaaaaaaaaaaaaa/11111111111111111111111111111111.webp", alt: "The planner", width: 1200, height: 800 };
const embed = (props: Partial<Parameters<typeof VideoEmbed>[0]>) => renderToStaticMarkup(createElement(VideoEmbed, { video, title: "Meal Planner", poster, ...props }));

part("The still before play");
is("asked for first when it is the top of the page", /<img[^>]*fetchPriority="high"[^>]*class="sp-video-poster"/i.test(embed({ priority: true })), true);
is("not asked for first anywhere else", /fetchPriority/i.test(embed({})), false);
is("it keeps its size either way", [embed({ priority: true }), embed({})].every((html) => html.includes('width="1200" height="800"')), true);
is("no still (the store's colors), nothing to ask for", /fetchPriority|<img/i.test(embed({ priority: true, poster: null })), false);
is("nothing is fetched from the video's provider before play (no frame, no address of theirs)", /<iframe|youtube\.com|youtube-nocookie|ytimg/i.test(embed({ priority: true })), false);

part("The hero passes it, and only the hero");
const ctx: BlockContext = {
  storeName: "Harbor Kitchen",
  productTitle: "Meal Planner",
  picture: poster,
  photo: null,
  action: { kind: "link", href: "#buy" },
  defaultLabel: "Get it now",
  now: 1_900_000_000,
};
const hero: HeroBlock = { id: "hero0001", kind: "hero", headline: "Dinner, decided", sub: "", media: "video", video };
const drawn = renderToStaticMarkup(createElement(HeroView, { block: hero, ctx, pill: null, rating: null }));
is("a hero with a video: its still is the one picture asked for first", (drawn.match(/<img[^>]*fetchPriority="high"/gi) ?? []).length, 1);
// React hoists a preload of a picture asked for first into the head: the same address, so the fetch starts earlier.
is("and the page's preload is for that same still", [...drawn.matchAll(/<link rel="preload" as="image" href="([^"]+)" fetchPriority="high"\/>/g)].map((m) => m[1]), [poster.src]);
is("and it is the still", /<img[^>]*fetchPriority="high"[^>]*class="sp-video-poster"/i.test(drawn), true);
const blocks = readFileSync("components/sales-blocks.tsx", "utf8");
const calls = [...blocks.matchAll(/<VideoEmbed\b[^>]*\/>/g)].map((m) => m[0]);
is("the sales page draws its videos in three places", calls.length, 3);
is("only the hero's asks for priority", calls.map((call) => /\bpriority\b/.test(call)), [true, false, false]);
for (const file of ["app/[handle]/page.tsx", "app/[handle]/community/events/[event]/page.tsx", "components/thanks-note-view.tsx"]) {
  is(`${file}: its videos never ask`, /<VideoEmbed\b[^>]*\bpriority\b/.test(readFileSync(file, "utf8")), false);
}

done();
