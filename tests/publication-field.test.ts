/**
 * 789 [IV1] step 3, unit 5a (Claude 5 ibqho's LEVE on #5008): the creator's own answer to whether a product is an
 * electronically supplied publication, kept on the product (lib/catalog.ts, Product.publication) and read per product
 * at checkout (lib/eu-vat-collect.ts, notAPublication). It holds that:
 *   - a product starts unanswered; `true` and `false` are kept exactly, `null` clears it back; the listing carries it;
 *   - the route refuses anything but true, false or null, so a bad value never reads as "not a publication";
 *   - only an explicit `false` on the product, and on every bundle member, lets EU or UK VAT be collected; a cart is
 *     collected only when every product answers `false`, so an e-book beside a course refuses the cart;
 *   - with the real values nothing collects: no record says "collect" and both switches are off.
 * Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setProductPublication, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { consumerGate } from "@/lib/eu-vat-gate";
import { euCartGate, euSaleGate, notAPublication } from "@/lib/eu-vat-collect";
import type { EuSupplyFields } from "@/lib/eu-vat-supply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = new Date("2026-12-01T12:00:00Z");
const RATES = [{ country: "DE", basisPoints: 1900, source: "https://example.invalid/de", readOn: "2026-11-20" }];
const RECORD = { treatment: "collect", implementedIn: "lib/eu-vat-collect.ts", recordedOn: "2026-11-25", evidence: "tests/publication-field.test.ts" };
const SWITCH = {
  reviewed: true,
  seller: { legalName: "Synthetic Seller LLC", address: "1 Test Street, Wilmington, DE 19801, United States" },
  eu: { memberState: "IE", vatNumber: "EU372000019", effectiveFrom: "2026-11-01" },
  uk: { vatNumber: "123456789", effectiveFrom: "2026-11-01" },
  reviews: [
    { jurisdiction: "EU", registration: "EU372000019", reviewedOn: "2026-11-15", reviewer: "owner" },
    { jurisdiction: "UK", registration: "123456789", reviewedOn: "2026-11-15", reviewer: "owner" },
  ],
};
const ON = { records: [{ ...RECORD, jurisdiction: "EU", registration: "IE OSS" }, { ...RECORD, jurisdiction: "UK", registration: "UK VAT 123456789" }], vatSwitch: SWITCH, now: NOW, rates: RATES };

const BASE: EuSupplyFields = { priceCents: 2900, file: null, link: "https://example.com/pack", keys: null, course: null, recurring: null, call: null, bundle: null, pwyw: null };
const COURSE: EuSupplyFields = { ...BASE, publication: false };
const EBOOK: EuSupplyFields = { ...BASE, link: "https://example.com/book", publication: true };
const UNANSWERED: EuSupplyFields = { ...BASE };
const evidence = (ip: string, billing: string) => {
  const headers = new Headers({ "x-vercel-ip-country": ip });
  const form = new URLSearchParams({ billing_country: billing });
  return { headers, form };
};
const DE = evidence("DE", "DE");
const GB = evidence("GB", "GB");

async function main(): Promise<void> {
  part("Kept on the product, unanswered until the creator answers");
  redis.clear();
  const owner = "publication@example.com";
  await claimHandle(owner, "publicationshop", "Publication Shop", "");
  await ensureStatsId(owner);
  const made = await addProduct(owner, "Pattern pack", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(owner, made.product.id, "https://example.com/pack");
  const id = made.product.id;
  const read = async () => (await readListing((await storeForEmail(owner))!, id))!.publication;
  is("a new product: not answered", await read(), undefined);
  for (const [answer, label] of [[false, "not a publication"], [true, "a publication"], [null, "cleared back"]] as const) {
    const result = await setProductPublication(owner, id, answer);
    is(`answered ${label}: saved`, result.ok, true);
    is(`and the listing reads it as ${String(answer ?? "not answered")}`, await read(), answer === null ? undefined : answer);
  }
  is("an unknown product: refused, nothing saved", (await setProductPublication(owner, "nope", false)).ok, false);

  part("The route takes only true, false or null");
  const route = readFileSync("app/api/store/publication/route.ts", "utf8");
  is("anything else is refused with 400 before anything is saved", /if \(value !== true && value !== false && value !== null\) return Response\.json\(\{ ok: false, error: "invalid" \}, \{ status: 400 \}\);/.test(route), true);
  is("it is a store write, under the products permission", /guardStoreWrite\(request, "products"\)/.test(route), true);

  part("Read per product, and per bundle member");
  is("answered not a publication", notAPublication(COURSE), true);
  is("answered a publication", notAPublication(EBOOK), false);
  is("not answered", notAPublication(UNANSWERED), false);
  const members = new Map<string, EuSupplyFields>([["c", COURSE], ["e", EBOOK], ["u", UNANSWERED]]);
  is("a bundle whose members all answered not one", notAPublication({ ...COURSE, bundle: ["c", "c"] }, members), true);
  is("a bundle holding an e-book", notAPublication({ ...COURSE, bundle: ["c", "e"] }, members), false);
  is("a bundle holding an unanswered member", notAPublication({ ...COURSE, bundle: ["c", "u"] }, members), false);
  is("a bundle with a member missing from the map", notAPublication({ ...COURSE, bundle: ["c", "x"] }, members), false);
  is("a bundle with no members read", notAPublication({ ...COURSE, bundle: ["c"] }), false);

  part("With collection on, injected here only: who is collected");
  is("a course answered not a publication: collected in Germany", euSaleGate({ product: COURSE, ...DE, ...ON }), { ok: true, collect: { country: "DE" } });
  is("an e-book: refused as today", euSaleGate({ product: EBOOK, ...DE, ...ON }), consumerGate({ product: EBOOK, ...DE }));
  is("not answered: refused as today", euSaleGate({ product: UNANSWERED, ...DE, ...ON }), consumerGate({ product: UNANSWERED, ...DE }));
  is("the UK the same way: a course collected, an e-book refused", [euSaleGate({ product: COURSE, ...GB, ...ON }), euSaleGate({ product: EBOOK, ...GB, ...ON }).ok], [{ ok: true, collect: { country: "GB" } }, false]);
  is("a cart of two courses: collected", euCartGate({ products: [COURSE, COURSE], ...DE, ...ON }), { ok: true, collect: { country: "DE" } });
  is("a cart of an e-book beside a course: refused as today", euCartGate({ products: [COURSE, EBOOK], ...DE, ...ON }), consumerGate({ product: EBOOK, ...DE }));
  is("a cart with an unanswered product: refused as today", euCartGate({ products: [UNANSWERED, COURSE], ...DE, ...ON }), consumerGate({ product: UNANSWERED, ...DE }));

  part("Nothing collects today: the real values");
  is("a course answered not a publication, a German buyer: exactly consumerGate", euSaleGate({ product: COURSE, ...DE }), consumerGate({ product: COURSE, ...DE }));
  is("and a cart of them: exactly the first refusal", euCartGate({ products: [COURSE, COURSE], ...DE }), consumerGate({ product: COURSE, ...DE }));

  done();
}

void main();
