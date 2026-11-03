/**
 * 617 [SZ1], unit 3: a store's policy page is built from what the store is
 * now (lib/store-policy-input.ts): what it sells, PayPal, the pixels switched
 * on, the postal address; it changes with them; the address is kept from a
 * creator's own page names. Synthetic store values; the page's markup is read
 * from its source, as other store page checks do.
 */
import { readFileSync } from "node:fs";
import { policyInputFrom } from "@/lib/store-policy-input";
import { policyFacts, policyFingerprint } from "@/lib/store-policy-facts";
import { RESERVED_SLUGS } from "@/lib/site-page-rules";
import { NO_PIXELS } from "@/lib/pixels";
import { done, is, part } from "./check";

const store = { name: "Harbor Kitchen", pixels: { ...NO_PIXELS }, mail: { address: "1 Main St, Portland, OR 97201" } } as unknown as Parameters<typeof policyInputFrom>[0];
const ebook = { priceCents: 1900, file: { pathname: "x" } };
const free = { priceCents: 0, file: { pathname: "y" } };
const club = { priceCents: 900, recurring: { interval: "month" } };
const call = { priceCents: 9900, call: { minutes: 30 } };

part("What the store sells, counting only what is paid for");
is("an ebook: digital", policyInputFrom(store, [ebook], false).sellsDigital, true);
is("a free download alone: nothing sold", [policyInputFrom(store, [free], false).sellsDigital, policyInputFrom(store, [free], false).sellsMemberships], [false, false]);
is("a membership: memberships, not digital content", [policyInputFrom(store, [club], false).sellsMemberships, policyInputFrom(store, [club], false).sellsDigital], [true, false]);
is("a call: neither", [policyInputFrom(store, [call], false).sellsDigital, policyInputFrom(store, [call], false).sellsMemberships], [false, false]);

part("Settings flow into the page, and change it");
const before = policyFacts(policyInputFrom(store, [ebook], false), "en");
const withPixel = policyFacts(policyInputFrom({ ...store, pixels: { ...NO_PIXELS, meta: "123456789012345" } } as typeof store, [ebook], false), "en");
is("a pixel switched on: the measurement section, named by its platform", withPixel.find((s) => s.id === "measurement")?.sentences[0], "Harbor Kitchen measures its ads with Meta.");
is("and a new version", policyFingerprint(withPixel) === policyFingerprint(before), false);
is("PayPal taken: said", policyFacts(policyInputFrom(store, [ebook], true), "en")[0].sentences[2].includes("PayPal"), true);
is("no postal address: no contact section", policyFacts(policyInputFrom({ ...store, mail: null } as typeof store, [ebook], false), "en").some((s) => s.id === "contact"), false);

part("The page");
const page = readFileSync("app/[handle]/policies/page.tsx", "utf8");
is("built from the store as it is now, in its language", page.includes("policyFacts(await policyInput(store), store.language)"), true);
is("its version is the fingerprint of its words", page.includes("const version = policyFingerprint(sections);"), true);
is("says it is not legal advice", page.includes("{notAdvice(store.language)}"), true);
is("one h1, a titled h2 per section, the page's language marked", [(page.match(/<h1\b/g) ?? []).length, page.includes("aria-labelledby={`policy-${section.id}`}"), page.includes("lang={said.lang.locale}")], [1, true, true]);
is("a product read that fails is never quietly left out", readFileSync("lib/store-policy-input.ts", "utf8").includes("const products = await readListings(store, visibleIds(store));"), true);
is("a creator's page cannot take its address", RESERVED_SLUGS.has("policies"), true);

done();
