/**
 * Review of #3696 (Claude 1, C3, at 1cd1f8a1): the policy page reads every visible product's listing, one GET each
 * past the catalog head, so what it takes from the store's public requests must cover those reads, commands included
 * (publicListingsRead). Covering them by adding PUBLIC_LISTINGS_PER_UNIT commands to every request of every plan raised
 * every plan's worst month and the funded first-year exposure past its reviewed bound. So the page takes its own,
 * larger count of requests for its listings, priced as any public request (laterPageCost), and no plan line changes.
 * Claude 3 (cloud K), 12 November 2026. Synthetic: numbers and source only.
 */
import { readFileSync } from "node:fs";
import * as policy from "@/lib/store-policy-input";
import { listingUnits } from "@/lib/public-read-rules";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { laterPageCost } from "./traffic-cost";
import { publicListingsRead } from "./plan-cost-registry";
import { done, is } from "./check";

const unitsOf = ((policy as Record<string, unknown>).policyListingUnits as ((n: number) => number) | undefined) ?? listingUnits;
const short: number[] = [];
for (let listings = 0; listings <= MAX_PRODUCTS; listings++) if (unitsOf(listings) * laterPageCost() < publicListingsRead(listings)) short.push(listings);
is("at every number of listings up to the catalog's largest, the page's requests cost at least its reads", short.slice(0, 5), []);
is("and none at all is taken for a store with nothing visible", unitsOf(0), 0);
const source = readFileSync("lib/store-policy-input.ts", "utf8");
is("the page takes that count before reading", /takePublicRequest\(store, "public", undefined, policyListingUnits\(/.test(source) || /const units = policyListingUnits\(/.test(source), true);
const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
is("no plan's request line carries the policy page's listing commands", /PUBLIC_LISTINGS_PER_UNIT\) \* COMMAND|1 \+ PUBLIC_LISTINGS_PER_UNIT\) \* COMMAND/.test(registry), false);
done();
