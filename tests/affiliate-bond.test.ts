/**
 * The buyer who stays with the affiliate who found them.
 *
 * Hotmart's affiliate settings offer a cookie that lasts "for ever". Nobody
 * can deliver that. Chrome caps the life of every cookie at 400 days from the
 * moment it is set and shortens a longer one without saying so, and long
 * before that the cookie is gone anyway because it lives in one browser:
 * cleared, or a new phone, or the work laptop, or a private window, and it
 * never existed. So "for ever" is 400 days at best, written down as something
 * else.
 *
 * What does last is not kept in a browser. Once a sale has been credited, the
 * creator may ask that the buyer stay with that affiliate — and then every
 * later purchase by that person earns them, on any device, at any distance.
 *
 * These hold the four things that make it safe to offer: it is off until a
 * creator asks for it, it never outranks a click, the buyer is stored as a
 * hash that cannot be read or lined up against another store's, and it cannot
 * grow into a cost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_BONDS, bondCount, bondFor, bondsBuyers, forgetBuyer, rememberBuyer } from "@/lib/affiliate-bond";
import { attributionWords, parseAffiliateSetting } from "@/lib/affiliate-setting";
import type { Store } from "@/lib/store";

const ANA = "a1b2c3d4e5f6";
const BRUNO = "b1b2c3d4e5f6";

function storeWith(over: Record<string, unknown> = {}, statsId = "st_bond_1"): Store {
  return {
    handle: "harbor",
    name: "Harbor Kitchen",
    statsId,
    affiliates: parseAffiliateSetting({ enabled: true, percent: 20, days: 30, lifetime: true, ...over }),
  } as unknown as Store;
}

// ---- Off until the creator asks -----------------------------------------

test("it is off until a creator switches it on", () => {
  assert.equal(parseAffiliateSetting({}).lifetime, false);
  for (const value of ["true", 1, "yes", {}, null]) {
    assert.equal(parseAffiliateSetting({ lifetime: value }).lifetime, false, "it changes who gets paid, so only a yes is a yes");
  }
  assert.equal(parseAffiliateSetting({ lifetime: true }).lifetime, true);
});

test("a programme with it off bonds nobody and reads nobody", async () => {
  const store = storeWith({ lifetime: false });
  assert.equal(bondsBuyers(store), false);
  await rememberBuyer(store, "jo@example.com", ANA, "last");
  assert.equal(await bondFor(store, "jo@example.com"), "", "nothing was written, so there is nothing to find");
});

test("a programme switched off entirely bonds nobody either", async () => {
  const store = storeWith({ enabled: false });
  assert.equal(bondsBuyers(store), false);
  await rememberBuyer(store, "jo@example.com", ANA, "last");
  assert.equal(await bondFor(store, "jo@example.com"), "");
});

// ---- What it does -------------------------------------------------------

test("a buyer credited once is found again with no cookie anywhere", async () => {
  const store = storeWith({}, "st_bond_keep");
  await rememberBuyer(store, "jo@example.com", ANA, "last");
  assert.equal(await bondFor(store, "jo@example.com"), ANA);
});

test("the address is matched however it is typed", async () => {
  const store = storeWith({}, "st_bond_case");
  await rememberBuyer(store, "Jo@Example.com", ANA, "last");
  assert.equal(await bondFor(store, "  jo@example.com "), ANA, "the same person is the same person");
});

test("somebody who never bought belongs to nobody", async () => {
  const store = storeWith({}, "st_bond_keep");
  assert.equal(await bondFor(store, "stranger@example.com"), "");
  assert.equal(await bondFor(store, ""), "");
});

test("the same buyer at two stores is two unrelated records", async () => {
  const one = storeWith({}, "st_bond_a");
  const two = storeWith({}, "st_bond_b");
  await rememberBuyer(one, "jo@example.com", ANA, "last");
  assert.equal(await bondFor(two, "jo@example.com"), "", "one creator's buyer list is not another's");
});

// ---- Whose buyer, when two affiliates have a claim ----------------------

test("on last click the affiliate who brought them back takes the buyer", async () => {
  const store = storeWith({ rule: "last" }, "st_bond_last");
  await rememberBuyer(store, "jo@example.com", ANA, "last");
  await rememberBuyer(store, "jo@example.com", BRUNO, "last");
  assert.equal(await bondFor(store, "jo@example.com"), BRUNO);
});

test("on first click the affiliate who found them keeps the buyer", async () => {
  const store = storeWith({ rule: "first" }, "st_bond_first");
  await rememberBuyer(store, "jo@example.com", ANA, "first");
  await rememberBuyer(store, "jo@example.com", BRUNO, "first");
  assert.equal(await bondFor(store, "jo@example.com"), ANA, "a later affiliate cannot take a buyer somebody else found");
});

// ---- Forgetting --------------------------------------------------------

test("a buyer can be forgotten, and then belongs to nobody again", async () => {
  const store = storeWith({}, "st_bond_forget");
  await rememberBuyer(store, "jo@example.com", ANA, "last");
  assert.equal(await forgetBuyer(store, "jo@example.com"), true);
  assert.equal(await bondFor(store, "jo@example.com"), "");
  assert.equal(await forgetBuyer(store, "jo@example.com"), false, "forgetting twice is not an error, just nothing to do");
});

// ---- It cannot become a cost -------------------------------------------

test("a store cannot bond more buyers than the cap", async () => {
  // The cap exists so this can never move a bill. It is reached by adding
  // new buyers only: somebody already bonded is updated, not counted again.
  assert.ok(MAX_BONDS >= 100_000, "set it low enough to touch a real store and it stops being a safety limit");
  const bytes = MAX_BONDS * 80;
  assert.ok(
    bytes < 32 * 1024 * 1024,
    `the whole cap is ${(bytes / 1024 / 1024).toFixed(0)} MB of records, which has to stay far below anything that shows up on an invoice`,
  );
});

test("a store at the cap keeps every bond it has and refuses only new ones", async () => {
  const store = storeWith({}, "st_bond_full");
  // Stand in for a full hash rather than writing two hundred thousand rows.
  const { store: redis } = await import("./redis-stub");
  const key = "nl:aff:st_bond_full:bond";
  await rememberBuyer(store, "known@example.com", ANA, "last");
  for (let i = 0; i < MAX_BONDS; i += 1) redis.run(["HSET", key, `filler${i}`, BRUNO]);

  await rememberBuyer(store, "newcomer@example.com", BRUNO, "last");
  assert.equal(await bondFor(store, "newcomer@example.com"), "", "a full store adds nobody new");
  assert.equal(await bondFor(store, "known@example.com"), ANA, "and loses nobody it already had");

  await rememberBuyer(store, "known@example.com", BRUNO, "last");
  assert.equal(await bondFor(store, "known@example.com"), BRUNO, "a buyer it already knows still moves");
  assert.ok(((await bondCount(store)) ?? -1) >= MAX_BONDS);
});

// ---- The record itself -------------------------------------------------

test("no address, name or order is kept, only a one-way hash", () => {
  const src = readFileSync(join(process.cwd(), "lib/affiliate-bond.ts"), "utf8");
  // Comments and the modules it is written with are not what it keeps.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^import .*$/gm, "");
  assert.match(code, /createHash\("sha256"\)/, "the buyer is hashed, not stored");
  assert.match(code, /nimbus-aff-bond:\$\{statsId\}/, "and the store's own id is mixed in, so two stores' records cannot be lined up");
  // Nothing else about the person may creep in beside the hash.
  for (const word of ["name", "product", "title", "amount", "order"]) {
    assert.doesNotMatch(code, new RegExp(`\\b${word}\\b`, "i"), `a bond must not grow a ${word}`);
  }
});

test("the affiliate is never shown who their buyers are", () => {
  // The bond answers one question, asked by the checkout: which affiliate does
  // this address already belong to. There is no reading it the other way.
  const src = readFileSync(join(process.cwd(), "lib/affiliate-bond.ts"), "utf8");
  // Comments and the modules it is written with are not what it keeps.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^import .*$/gm, "");
  assert.doesNotMatch(code, /HGETALL|HKEYS|HVALS|SMEMBERS/, "no call that lists a store's buyers belongs in this file");
});

// ---- Where it sits in the order of things ------------------------------

test("a click, then a code, then the buyer: never the other way round", () => {
  // Reversing any pair of these takes a sale from the affiliate who earned it
  // and gives it to one who did not, which is how a programme stops being
  // trusted. The order is asserted on the source because it is the whole
  // promise and it is one line's edit away from being wrong.
  const src = readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8");
  const start = src.indexOf("export async function noteSession");
  const body = src.slice(start, start + 3_000);
  const click = body.indexOf("meta.via");
  const code = body.indexOf("affiliateForCodes");
  const bond = body.indexOf("bondFor");
  assert.ok(click > 0 && code > 0 && bond > 0, "all three paths should be in noteSession");
  assert.ok(click < code, "a buyer who followed a link and then typed somebody else's code is still the link's sale");
  assert.ok(code < bond, "and a code typed today beats a bond made last year");
});

test("the bond is written after the sale, never instead of it", () => {
  const src = readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8");
  const start = src.indexOf("export async function noteSession");
  const body = src.slice(start, src.indexOf("export async function noteCharge"));
  const written = body.indexOf("await writeReferral");
  const remembered = body.indexOf("rememberBuyer");
  assert.ok(written > 0 && remembered > written, "a bond that fails costs a future commission; a sale that fails costs an earned one");
  assert.match(body, /rememberBuyer\([\s\S]{0,120}\.catch\(/, "so it can never throw into the path that records the sale");
});

test("a sale says which of the three credited it", () => {
  const src = readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8");
  assert.match(src, /export type Credit = "click" \| "code" \| "buyer" \| "partner"/, "the creator's book should be able to say so");
  // A sale written down before any of this existed came from a click, which
  // is what reading one has to conclude.
  const read = src.slice(src.indexOf("      how:"), src.indexOf("      how:") + 260);
  assert.match(read, /value\.how === "code" \|\| value\.how === "buyer" \|\| value\.how === "partner"/);
  assert.match(read, /value\.byCode === true/);
  assert.match(read, /: "click"/);
});

test("nothing user-facing promises a cookie will last, which is the part nobody can watch", () => {
  // The real hazard is not today's number, it is that browser policy changes
  // without telling anybody and nobody here is going to read release notes to
  // find out. So every sentence about the window is conditional — up to N
  // days, for as long as the browser keeps it — and stays true whether the cap
  // rises, falls or stays. This check is what makes that automatic: a future
  // edit that writes a flat guarantee fails the build instead of quietly
  // publishing something untrue.
  const facing = [
    "lib/affiliate-setting.ts",
    "components/affiliate-studio.tsx",
    "app/[handle]/affiliates/page.tsx",
    // Where the affiliate page's words now live, in every language.
    "lib/buyer-words/affiliates.ts",
    "app/privacy/page.tsx",
  ];
  for (const file of facing) {
    const src = readFileSync(join(process.cwd(), file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(
      src,
      /cookie (?:that )?lasts? for ?ever|never expires?|permanent cookie|cookie for ?ever|unlimited cookie/i,
      `${file} must not say a cookie lasts for ever. No site can deliver that, and saying it is what Hotmart does.`,
    );
    assert.doesNotMatch(
      src,
      /(?:cookie|click) (?:is )?(?:kept|remembered|stored|held) for (?:exactly |a full |the full )?\d+ days/i,
      `${file} states a cookie duration as a fact. Browsers decide that and change it without notice, so the wording has to stay conditional.`,
    );
  }

  // And the conditional wording has to actually be there.
  const words = attributionWords(parseAffiliateSetting({ days: 30, rule: "last" }));
  assert.match(words, /^The last affiliate link a buyer follows earns the sale, up to 30 days/, "stated as a ceiling");
  assert.match(words, /as long as the buyer's browser keeps the cookie/, "and conditional on the browser");
  assert.match(words, /browsers set their own limit/i, "saying plainly whose decision that is");
});

test("the one promise with no time limit is the one we actually control", () => {
  const on = attributionWords(parseAffiliateSetting({ days: 30, rule: "last", lifetime: true }));
  assert.match(on, /no time limit/, "the bond is unconditional, because it is in our own records");
  assert.match(on, /no cookie involved at all/, "and says why it can be");
  const src = readFileSync(join(process.cwd(), "lib/affiliate-bond.ts"), "utf8");
  assert.doesNotMatch(
    src.replace(/\/\*[\s\S]*?\*\//g, ""),
    /maxAge|Max-Age|Set-Cookie|expires/i,
    "a bond that touched a cookie or an expiry would inherit the problem it exists to solve",
  );
});

test("the affiliate reads the promise in plain words when it is on", () => {
  const off = attributionWords(parseAffiliateSetting({ days: 30, rule: "last" }));
  assert.doesNotMatch(off, /stays theirs/, "a store that did not switch it on must not promise it");

  const on = attributionWords(parseAffiliateSetting({ days: 30, rule: "last", lifetime: true }));
  assert.match(on, /the buyer stays with that affiliate/);
  assert.match(on, /no time limit/, "which is the whole difference from the window above it");
  assert.match(on, /on any device/, "and the part a cookie cannot do at any length");
});
