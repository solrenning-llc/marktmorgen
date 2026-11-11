/**
 * Memberships shows how many members are on each price (Claude 1, reviewer C3 on #3589): the product editor links an
 * off-sale price whose count it cannot say to this page, so the page must show that count, per price, from the
 * reading it already makes (no read of its own). A count the reading cannot prove is "Unknown", never 0 (rule 24).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { done, is, part } from "./check";
import { MembershipByPrice } from "@/components/membership-by-price";
import type { Numbers } from "@/lib/membership-numbers";

const base: Numbers = {
  currency: "usd",
  mrr: 0,
  paying: 0,
  trialing: 0,
  atRisk: 0,
  atRiskMrr: 0,
  ended30: 0,
  endedMrr30: 0,
  churn30: null,
  trialsEnded: 0,
  trialsConverted: 0,
  elsewhere: 0,
  byProduct: [],
  complete: true,
  optionsCounted: true,
  at: 1_800_000_000,
};
const listings = new Map([
  [
    "club",
    {
      title: "Guitar Club",
      options: [
        { id: "monthly", label: "Monthly" },
        { id: "founders", label: "Founders", offSale: true as const },
        { id: "nobody", label: "Weekend" },
      ],
    },
  ],
  ["plain", { title: "Plain Club", options: [] }],
]);
const reading = (over: Partial<Numbers>): Numbers => ({
  ...base,
  byProduct: [
    { product: "club", members: 5, trialing: 1, mrr: 9000, byOption: { monthly: 3, founders: 2, gone: 1 } },
    { product: "plain", members: 2, trialing: 0, mrr: 2000 },
  ],
  ...over,
});
const render = (numbers: Numbers) => renderToStaticMarkup(createElement(MembershipByPrice, { numbers, listings }));
/** The cells of the row whose header is this price, as text. */
const rowOf = (html: string, price: string) => {
  const row = html.split("<tr").find((tr) => tr.includes(`<th scope="row"`) && tr.includes(`>${price}<`));
  return row ? [...row.matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/g)].map((m) => m[1].replace(/<[^>]*>/g, "").replace(/[<>]/g, "")) : null;
};

part("Each price of a membership, with how many members are on it");
{
  const html = render(reading({}));
  is("the table is headed by price", /<h3[^>]*id="by-price-title"[^>]*>By price<\/h3>/.test(html), true);
  is("its columns name what they hold", ["Price", "Membership", "For sale", "Members on it"].every((c) => html.includes(`<th scope="col"`) && html.includes(`>${c}</th>`)), true);
  is("an on-sale price and its count", rowOf(html, "Monthly"), ["Monthly", "Guitar Club", "Yes", "3"]);
  is("an off-sale price says so in words, with its count", rowOf(html, "Founders"), ["Founders", "Guitar Club", "No, off sale", "2"]);
  is("a price nobody is on reads 0, as the whole reading proves it", rowOf(html, "Weekend"), ["Weekend", "Guitar Club", "Yes", "0"]);
  is("members on a price since removed are still counted", rowOf(html, "A price you have since removed"), ["A price you have since removed", "Guitar Club", "No, removed", "1"]);
  is("a membership with no prices to choose from gets no rows", html.includes("Plain Club"), false);
  is("no Unknown when every count is known", /Unknown/.test(html), false);
  is("the region is named for keyboard and screen reader users", /role="region"[^>]*aria-labelledby="by-price-title"|aria-labelledby="by-price-title"[^>]*role="region"/.test(html), true);
}

part("A count the reading cannot prove is Unknown, never 0");
{
  const partial = render(reading({ complete: false }));
  is("a reading that did not read every membership: Unknown", [rowOf(partial, "Monthly")?.[3], rowOf(partial, "Weekend")?.[3]], ["Unknown", "Unknown"]);
  is("and the page says why", /did not read every membership/.test(partial), true);
  const old = render(reading({ optionsCounted: undefined }));
  is("a reading kept from before members were counted by price: Unknown", rowOf(old, "Founders")?.[3], "Unknown");
  is("no 0 is shown for an unknown count", /<td[^>]*>0<\/td>/.test(partial) || /<td[^>]*>0<\/td>/.test(old), false);
  const odd = render(reading({ byProduct: [{ product: "club", members: 1, trialing: 0, mrr: 100, byOption: { monthly: -1 as number } }] }));
  is("a count of an odd shape: Unknown", rowOf(odd, "Monthly")?.[3], "Unknown");
}

part("Nothing to show");
is("no membership with prices: nothing rendered", render({ ...base, byProduct: [{ product: "plain", members: 2, trialing: 0, mrr: 2000 }] }), "");

part("The page and the editor say the same thing");
const page = readFileSync("app/studio/memberships/page.tsx", "utf8");
is("Memberships renders the table under By membership, from the listings it already reads", [/<MembershipByPrice numbers=\{numbers\} listings=\{listingsById\} \/>/.test(page), (page.match(/readListings\(/g) ?? []).length], [true, 1]);
const editor = readFileSync("components/product-editor.tsx", "utf8");
is("the editor's link says what Memberships shows: how many, per price", /See how many members are on each price in Memberships/.test(editor), true);
is("it never promises who, which Memberships does not list per price", /See who still pays on this price/.test(editor), false);
const route = readFileSync("app/api/store/option/route.ts", "utf8");
is("the route comment points to where Memberships shows it", /components\/membership-by-price\.tsx/.test(route), true);
done();
