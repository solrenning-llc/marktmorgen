/**
 * The thank-you page names, to a screen reader, which product each "Open it" and "Download it" link is for
 * (WCAG 2.4.9 Link Purpose, AAA; #4593, Claude 6), after the visible words so a voice user can still say them
 * (2.5.3), the way "Read more" does on a store page. A cart with a main file, added products and products taken
 * after paying had several links of the same name going to different places. The price option's own link is a
 * 44 px target (2.5.5). The page reads headers at request time, so its source is read, as tests/embed.test.ts does.
 * Not covered here: the bundle's lines (components/bundle-delivery.tsx), whose words come from a region another open
 * PR changes.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const page = readFileSync("app/[handle]/thanks/page.tsx", "utf8");

/** Every <a ...>...</a> whose visible words are t.openIt or t.downloadIt, with what follows them up to </a>. */
function deliveryLinks(): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*>\s*\{t\.(?:openIt|downloadIt)\}([\s\S]*?)<\/a>/g;
  for (let m = re.exec(page); m; m = re.exec(page)) out.push(m[0]);
  return out;
}

part("Each delivery link says which product it opens");
const links = deliveryLinks();
is("the page has its seven delivery links (main file, the option's link or file, an added product's link or file, a taken product's link or file)", links.length, 7);
is(
  "each carries the product's or option's name as screen-reader text after its visible words",
  links.map((a) => /\{t\.(?:openIt|downloadIt)\}\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<span className="sr-only">\{`: \$\{(?:order\.product\.title|order\.option\.label|added\.product\.title)\}`\}<\/span>/.test(a)),
  links.map(() => true),
);

part("The price option's link is a 44 px target");
const option = links.filter((a) => a.includes("order.option.label"));
is("both option links (link and file)", option.length, 2);
is("each is inline-flex with a 44 px minimum height", option.map((a) => /className="link mt-1 inline-flex min-h-11 items-center font-semibold"/.test(a)), [true, true]);

done();
