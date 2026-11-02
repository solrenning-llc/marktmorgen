/**
 * The questions someone starting out asks about license keys (534 [FQ1],
 * unit 12, lib/license-key-faq.ts; added 2 November 2026). Checked: the key
 * editor's own words, read from its file; which products take keys, from
 * canHaveKeys; where the buyer sees the key; the list of keys given; the
 * shared trial answer in both states; no figure; first in the page's own
 * Questions block, no question asked twice.
 */
import { readFileSync } from "node:fs";
import { KEY_WORDS, keyBeginnerQuestions } from "@/lib/license-key-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { canHaveKeys } from "@/lib/key-setup";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";
type L = Parameters<typeof canHaveKeys>[0];
const listing = (over: Partial<L>) => ({ priceCents: 2_700, recurring: null, call: null, course: null, bundle: null, ...over }) as unknown as L;

part("The studio's own words");
const editor = flat(read("components/licence-key-editor.tsx")).replace(/&apos;/g, "'");
is("the editor's button, choice, sources, save and list", Object.values(KEY_WORDS).every((w) => editor.includes(w)), true);
is("the save button, and the warning that a list sells out until keys are uploaded", [editor.includes('"Start giving keys"'), editor.includes("Upload the keys on the next step. Until there are some, this product shows as sold out.")], [true, true]);
is("the editor is not drawn on a call, a course, a bundle or something shipped", flat(read("components/product-editor.tsx")).includes("{product.call || product.course || product.bundle || product.shipping ? null : ("), true);
is("the studio counts keys given and revoked", [editor.includes(">Given</dt>"), editor.includes(">Revoked</dt>")], [true, true]);
is("which products take keys: paid, once, not a call, a course or a bundle", [canHaveKeys(listing({})), canHaveKeys(listing({ priceCents: 0 })), canHaveKeys(listing({ recurring: { interval: "month" } } as unknown as Partial<L>)), canHaveKeys(listing({ call: {} } as unknown as Partial<L>)), canHaveKeys(listing({ course: {} } as unknown as Partial<L>)), canHaveKeys(listing({ bundle: ["a", "b"] } as unknown as Partial<L>))], [true, false, false, false, false, false]);
is("a bundle hands out its products' keys, on the thank-you page", /order\.items\?\.items/.test(flat(read("app/[handle]/thanks/page.tsx"))), true);
is("the buyer sees the key on the thank-you page, in the confirmation email and in their list of purchases", [read("app/[handle]/thanks/page.tsx").includes("<LicenceKeyBox"), read("app/[handle]/orders/page.tsx").includes("<LicenceKeyBox"), read("lib/purchase-email.ts").includes("keyForSale")], [true, true, true]);
is("the keys given are listed with the email and the order", editor.includes("Find by key, email or order reference"), true);
is("your software's check answers valid, revoked or unknown", [/return "unknown"/.test(read("lib/licence-keys.ts")), /info\.revokedAt \? "revoked" : "valid"/.test(read("lib/licence-keys.ts"))], [true, true]);

part("The answers");
const now = keyBeginnerQuestions(false);
const later = keyBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What is a license key here?", "How do I turn them on?", "Can I try it before paying?", "Do license keys work?"]);
is("start: the editor's own words, in order", (() => { const a = answer(now, "How do I turn them on?"); const at = [KEY_WORDS.start, KEY_WORDS.source, KEY_WORDS.made, KEY_WORDS.list, KEY_WORDS.save, KEY_WORDS.upload, KEY_WORDS.paste].map((w) => a.indexOf(`“${w}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), true);
is("start: what takes no keys of its own, as the rule has it", ["that you do not ship", "Memberships, calls, courses, shipped products and bundles do not take keys of their own", "a bundle hands out the keys of the products in it", "until there are some, the product shows as sold out"].every((w) => answer(now, "How do I turn them on?").includes(w)), true);
is("try before paying: the one shared answer, in license keys' words", [answer(now, "Can I try it before paying?"), answer(later, "Can I try it before paying?")], [tryBeforePaying("License keys", "license keys on a product", false), tryBeforePaying("License keys", "license keys on a product", true, TRIAL_DAYS)]);
is("does it work: none given while plans are off sale, no figure, the studio's own counts and search", [answer(now, "Do license keys work?").startsWith("Paid plans are not on sale yet, so no key has gone to a buyer yet. We publish no number"), answer(later, "Do license keys work?").startsWith("We publish no number"), answer(now, "Do license keys work?").includes(`under “${KEY_WORDS.given}” you can find one by key, email or order reference`)], [true, true, true]);
is("one space between sentences, never two", /\s{2}/.test([...now, ...later].map((x) => x.a).join(" ")), false);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of keys or sales, no percent, no result promised", /\b\d+\s+(keys|sales|buyers|creators)|%|guarantee|proven|results?\b/i.test(all), false);

part("On the license keys page");
const faq = (findPage("platform", "license-keys")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
